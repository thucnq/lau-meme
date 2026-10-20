// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/daily.md, phần nối UI: AC-DAILY-03/04/05/06/08/09/12.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU
 *   ./api:  submitDailyResult(version, {steps, path}, {storage, policyVersion}) -> {result, already}
 *             201 -> already:false; 409 -> already:true với result trong body problem; lỗi khác -> SendError(.status);
 *             chưa đồng ý -> ném lỗi, không fetch.
 *           getDailyLeaderboard(version, {storage, policyVersion}) -> {version, rows, me}; X-Player-Id chỉ khi đã đồng ý.
 *   ./DailyPanel: <DailyPanel manifest lookup onDiscover storage />
 *   Game: render <DailyPanel> sau khi tải manifest + graph; onDiscover của bàn thử thách thêm phần tử vào Đĩa chính.
 */
import { createHash, webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendError } from '../disc/api'
import { initialProgress, saveProgress } from '../game/engine'
import type { Manifest } from '../game/engine'
import { Game } from '../game/Game'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { getDailyLeaderboard, submitDailyResult } from './api'
import { DailyPanel } from './DailyPanel'

// ---------------------------------------------------------------- fixtures
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7

const CHAIN = [
  { a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' },
  { a: 'Tới Công Chuyện', b: 'Deadline', name: 'Chạy Deadline', emoji: '🏃' },
  { a: 'Chạy Deadline', b: 'Toang', name: 'Hết Cứu', emoji: '🆘' },
  { a: 'Hết Cứu', b: 'Cay', name: 'Stonks', emoji: '📈' },
  { a: 'Cay', b: 'Cay', name: 'Siêu Cay', emoji: '🥵' },
]

function manifestOf(version = VERSION, batchAt = '2026-10-20T00:00:00.000Z'): Manifest {
  return {
    version,
    batch_at: batchAt,
    graph_url: `/api/graph/${version}`,
    starters: [
      { id: eid('Cay'), name: 'Cay', emoji: '🌶️' },
      { id: eid('Cười'), name: 'Cười', emoji: '😂' },
      { id: eid('Toang'), name: 'Toang', emoji: '💀' },
      { id: eid('Deadline'), name: 'Deadline', emoji: '⏰' },
    ],
    miss_lines: Array.from({ length: 30 }, (_, i) => `Nồi trào kiểu ${i}, khét rồi!`),
    daily: { element_id: eid('Stonks'), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    policy_version: 1,
  } as Manifest
}

const pairKey = (a: string, b: string): string => [fold(a), fold(b)].sort().join('|')
const RESULTS = new Map(CHAIN.map((s) => [pairKey(s.a, s.b), { added_version: VERSION, depth: 1, emoji: s.emoji, id: eid(s.name), image_key: null, name: s.name } as GraphResult]))
const lookup = async (a: string, b: string): Promise<GraphResult | null> => RESULTS.get(pairKey(a, b)) ?? null

async function buildGraph(): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of CHAIN) {
    const plain = RESULTS.get(pairKey(s.a, s.b))!
    const [x, y] = [fold(s.a), fold(s.b)].sort()
    const key = sha('lm1|k|' + x + '\0' + y)
    const ikm = await webcrypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
    const okm = new Uint8Array(
      await webcrypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + VERSION), info: enc.encode('lm1|aes-gcm') },
        ikm,
        44 * 8,
      ),
    )
    const aes = await webcrypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt'])
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) }, aes, enc.encode(JSON.stringify(plain)))
    entries[key] = Buffer.from(new Uint8Array(ct)).toString('base64url')
  }
  return { format: 1, version: VERSION, entries }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

const STORED = { version: VERSION, steps: 5, rank: 3, streak: { current: 2, longest: 4 }, submitted_at: '2026-10-20T03:10:00.000Z' }
let resultsReply: () => Response
let leaderboardReply: () => Response
let fetchMock: ReturnType<typeof vi.fn>

function installNet(extra?: { graph?: Graph }): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.includes('/daily/') && url.endsWith('/results') && method === 'POST') return resultsReply()
    if (url.includes('/daily/') && url.endsWith('/leaderboard') && method === 'GET') return leaderboardReply()
    if (url.includes('/manifest')) return json(manifestOf())
    if (url.includes('/graph/') && extra?.graph) return json(extra.graph)
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    if (url.includes('/health')) return json({ status: 'ok', env: 'test', schema: '1' })
    if (url.includes('/api/discoveries') && method === 'GET') return json({ items: [] })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const calls = () =>
  fetchMock.mock.calls.map((c) => ({
    url: urlOf(c[0] as RequestInfo),
    method: methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined),
    player: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id'),
    body: (c[1] as RequestInit | undefined)?.body as string | undefined,
  }))
const resultPosts = () => calls().filter((c) => c.method === 'POST' && c.url.includes('/daily/') && c.url.endsWith('/results'))
const leaderboardGets = () => calls().filter((c) => c.method === 'GET' && c.url.includes('/daily/') && c.url.endsWith('/leaderboard'))

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  window.history.pushState({}, '', '/lau-meme/')
  resultsReply = () => json({ ...STORED, steps: 5, rank: 1, streak: { current: 1, longest: 1 } }, 201)
  leaderboardReply = () => json({ version: VERSION, rows: [], me: null })
  installNet()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ---------------------------------------------------------------- UI helpers
const board = (): HTMLElement => screen.getByRole('region', { name: 'Bàn thử thách' })
const el = (label: string): HTMLElement => within(board()).getByRole('button', { name: label })
const counter = (n: number): HTMLElement => within(board()).getByText(`Bước: ${n}`)
const NAMES: Record<string, string> = { Cay: '🌶️ Cay', Cười: '😂 Cười', Toang: '💀 Toang', Deadline: '⏰ Deadline' }
for (const s of CHAIN) NAMES[s.name] = `${s.emoji} ${s.name}`
let stepsDone = 0
async function mix(a: string, b: string): Promise<void> {
  fireEvent.click(el(NAMES[a]!))
  fireEvent.click(el(NAMES[b]!))
  stepsDone += 1
  await waitFor(() => counter(stepsDone))
}
async function openBoard(): Promise<void> {
  stepsDone = 0
  fireEvent.click(screen.getByRole('button', { name: /thử thách/i }))
  await screen.findByRole('region', { name: 'Bàn thử thách' })
}
function panel(opts: { manifest?: Manifest; onDiscover?: (e: { id: string; name: string; emoji: string }) => void } = {}) {
  return (
    <DailyPanel manifest={opts.manifest ?? manifestOf()} lookup={lookup} onDiscover={opts.onDiscover ?? (() => {})} storage={localStorage} />
  )
}
async function solve(): Promise<void> {
  await mix('Cay', 'Toang') // trượt
  await mix('Cay', 'Cười')
  await mix('Tới Công Chuyện', 'Deadline')
  await mix('Chạy Deadline', 'Toang')
  await mix('Hết Cứu', 'Cay')
}

// ================================================================ AC-DAILY-03 / 12: thẻ + đồng hồ
describe('daily ui: thẻ và đồng hồ', () => {
  it('AC-DAILY-03: DailyPanel hiện thẻ "Món đặc biệt hôm nay" với emoji, gợi ý và tên "???", không lộ tên món', () => {
    const { container } = render(panel())
    const card = screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })
    expect(card.textContent).toContain('📈')
    expect(within(card).getByText('Món lên như diều gặp gió')).toBeTruthy()
    expect(within(card).getByText('???')).toBeTruthy()
    expect(container.textContent).not.toContain('Stonks')
    expect(screen.queryByRole('region', { name: 'Bàn thử thách' })).toBeNull()
  })

  it('AC-DAILY-12: hiện "Mẻ mới sau h:mm:ss" tính từ batch_at của manifest', () => {
    render(panel()) // batch_at 00:00 UTC, bây giờ 03:00 UTC => mốc 05:00 UTC còn 2 giờ
    expect(screen.getByText(/Mẻ mới sau 2:00:0\d/)).toBeTruthy()
  })

  it('AC-DAILY-12: đã quá mốc mà manifest chưa đổi thì hiện "Mẻ mới sắp lên", không có số âm', () => {
    vi.setSystemTime(new Date('2026-10-20T05:20:00.000Z'))
    render(panel())
    expect(screen.getByText('Mẻ mới sắp lên')).toBeTruthy()
    expect(screen.queryByText(/Mẻ mới sau/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/-\d+:\d\d/)
  })

  it('AC-DAILY-12: batch_at 17:03 UTC (cron trễ), lúc 17:30 UTC hiện 11:30:00 tới mốc 05:00 UTC', () => {
    vi.setSystemTime(new Date('2026-10-20T17:30:00.000Z'))
    render(panel({ manifest: manifestOf(VERSION, '2026-10-20T17:03:00.000Z') }))
    expect(screen.getByText(/Mẻ mới sau 11:30:0\d/)).toBeTruthy()
  })
})

// ================================================================ AC-DAILY-04: bàn thử thách
describe('daily ui: bàn thử thách', () => {
  it('AC-DAILY-04: bấm "Thử thách" mở bàn có 4 phần tử khởi đầu (aria-pressed) và bộ đếm "Bước: 0"', async () => {
    render(panel())
    await openBoard()
    for (const s of ['Cay', 'Cười', 'Toang', 'Deadline']) {
      expect(el(NAMES[s]!).getAttribute('aria-pressed')).toBe('false')
    }
    expect(within(board()).getAllByRole('button')).toHaveLength(4)
    counter(0)
    fireEvent.click(el(NAMES.Cay!))
    expect(el(NAMES.Cay!).getAttribute('aria-pressed')).toBe('true')
  })

  it('AC-DAILY-04: trượt hiện "💨 Trượt rồi" và vẫn tăng bộ đếm; không gọi onDiscover', async () => {
    const onDiscover = vi.fn()
    render(panel({ onDiscover }))
    await openBoard()
    await mix('Cay', 'Toang')
    expect(await screen.findByText('💨 Trượt rồi')).toBeTruthy()
    expect(within(board()).getAllByRole('button')).toHaveLength(4)
    expect(onDiscover).not.toHaveBeenCalled()
  })

  it('AC-DAILY-04: ghép trúng thêm nút phần tử mới lên bàn và gọi onDiscover đúng một lần; ghép lại món đã có chỉ tăng bước', async () => {
    const onDiscover = vi.fn()
    render(panel({ onDiscover }))
    await openBoard()
    await mix('Cay', 'Cười')
    expect(el(NAMES['Tới Công Chuyện']!)).toBeTruthy()
    expect(onDiscover).toHaveBeenCalledTimes(1)
    expect(onDiscover.mock.calls[0]![0]).toMatchObject({ id: eid('Tới Công Chuyện'), name: 'Tới Công Chuyện', emoji: '🔥' })
    await mix('Cười', 'Cay')
    expect(onDiscover).toHaveBeenCalledTimes(1)
    expect(within(board()).getAllByRole('button')).toHaveLength(5)
  })

  it('AC-DAILY-04: bấm cùng một nút hai lần ghép phần tử với chính nó', async () => {
    render(panel())
    await openBoard()
    await mix('Cay', 'Cay')
    expect(el(NAMES['Siêu Cay']!)).toBeTruthy()
    counter(1)
  })

  it('AC-DAILY-04: ghép ra món đích (so theo id) thì lộ tên thay "???" và hiện "Xong sau N bước" (kể cả lượt trượt)', async () => {
    render(panel())
    await openBoard()
    await solve()
    expect(await screen.findByText('Xong sau 5 bước')).toBeTruthy()
    const card = screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })
    expect(within(card).getByText('Stonks')).toBeTruthy()
    expect(within(card).queryByText('???')).toBeNull()
  })

  it('AC-DAILY-04: Game hiện DailyPanel sau khi tải; phần tử khám phá trên bàn thử thách được thêm vào Đĩa chính', async () => {
    const p = initialProgress(manifestOf(), T0)
    p.tutorial_seen = true
    saveProgress(localStorage, p)
    installNet({ graph: await buildGraph() })
    render(<Game />)
    const plate = await screen.findByRole('list', { name: 'Đĩa nhúng' })
    const names = () => within(plate).queryAllByTestId('plate-item').map((e) => (e as HTMLElement).dataset.name)
    expect(names()).not.toContain('Tới Công Chuyện')
    await screen.findByRole('region', { name: 'Món đặc biệt hôm nay' })
    await openBoard()
    await mix('Cay', 'Toang') // trượt: không thêm gì vào Đĩa
    await mix('Cay', 'Cười')
    await waitFor(() => expect(names()).toContain('Tới Công Chuyện'))
    expect(names().filter((n) => n === 'Tới Công Chuyện')).toHaveLength(1)
    // bàn thử thách tách khỏi Đĩa: Đĩa không dùng cho thử thách và ngược lại
    expect(within(board()).getAllByRole('button').length).toBe(5)
  })
})

// ================================================================ AC-DAILY-05: tải lại
describe('daily ui: tải lại', () => {
  it('AC-DAILY-05: dựng lại DailyPanel với cùng storage khôi phục bàn đang mở, phần tử đã có và bộ đếm', async () => {
    const first = render(panel())
    await openBoard()
    await mix('Cay', 'Cười')
    await mix('Cay', 'Toang')
    first.unmount()
    render(panel())
    await screen.findByRole('region', { name: 'Bàn thử thách' })
    counter(2)
    expect(el(NAMES['Tới Công Chuyện']!)).toBeTruthy()
    expect(within(board()).getAllByRole('button')).toHaveLength(5)
    // chơi tiếp được
    stepsDone = 2
    await mix('Tới Công Chuyện', 'Deadline')
    expect(el(NAMES['Chạy Deadline']!)).toBeTruthy()
  })

  it('AC-DAILY-05: sang mẻ mới (version khác) thì thử thách cũ đóng, bàn mới chỉ có 4 phần tử và bộ đếm 0', async () => {
    const first = render(panel())
    await openBoard()
    await mix('Cay', 'Cười')
    first.unmount()
    render(panel({ manifest: manifestOf(VERSION + 1, '2026-10-20T05:04:00.000Z') }))
    if (!screen.queryByRole('region', { name: 'Bàn thử thách' })) {
      fireEvent.click(screen.getByRole('button', { name: /thử thách/i }))
      await screen.findByRole('region', { name: 'Bàn thử thách' })
    }
    counter(0)
    expect(within(board()).getAllByRole('button')).toHaveLength(4)
  })
})

// ================================================================ AC-DAILY-06 / 08: nộp kết quả
describe('daily ui: nộp kết quả', () => {
  it('AC-DAILY-06: đã đồng ý, giải xong thì POST /daily/{version}/results {steps, path} kèm X-Player-Id và hiện hạng + streak', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(panel())
    await openBoard()
    await solve()
    expect(await screen.findByText('Hạng #1 · Streak 1 ngày')).toBeTruthy()
    const posts = resultPosts()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toContain(`/lau-meme/api/daily/${VERSION}/results`)
    expect(posts[0]!.player).toBe(getPlayerId(localStorage))
    const body = JSON.parse(posts[0]!.body!) as { steps: number; path: Array<{ a: string; b: string; result: string }> }
    expect(body.steps).toBe(5)
    expect(body.path.map((s) => s.result)).toEqual(['Tới Công Chuyện', 'Chạy Deadline', 'Hết Cứu', 'Stonks'])
    expect([body.path[3]!.a, body.path[3]!.b].sort()).toEqual(['Cay', 'Hết Cứu'])
  })

  it('AC-DAILY-06: chưa đồng ý thì hiện "Cần đồng ý chính sách dữ liệu để gửi", không gửi gì, không có X-Player-Id', async () => {
    saveConsent(localStorage, 1, 'declined')
    render(panel())
    await openBoard()
    await solve()
    expect(await screen.findByText('Xong sau 5 bước')).toBeTruthy()
    expect(await screen.findByText(/Cần đồng ý chính sách dữ liệu để gửi/)).toBeTruthy()
    expect(resultPosts()).toEqual([])
    expect(calls().filter((c) => c.player !== null)).toEqual([])
  })

  it('AC-DAILY-08: máy chủ trả 409 thì hiện hạng + streak từ kết quả đã lưu', async () => {
    saveConsent(localStorage, 1, 'granted')
    resultsReply = () => json({ type: 'about:blank', title: 'Đã nộp', status: 409, result: STORED }, 409)
    render(panel())
    await openBoard()
    await solve()
    expect(await screen.findByText('Hạng #3 · Streak 2 ngày')).toBeTruthy()
    expect(resultPosts()).toHaveLength(1)
  })

  it('AC-DAILY-06: máy chủ trả 429 thì hiện "Gửi quá nhanh, thử lại sau."', async () => {
    saveConsent(localStorage, 1, 'granted')
    resultsReply = () => json({ type: 'about:blank', title: 'Quá nhanh', status: 429 }, 429)
    render(panel())
    await openBoard()
    await solve()
    expect(await screen.findByText('Gửi quá nhanh, thử lại sau.')).toBeTruthy()
    expect(screen.queryByText(/Hạng #/)).toBeNull()
  })
})

describe('daily ui: submitDailyResult', () => {
  const body = { steps: 4, path: [{ a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' }] }
  const opts = () => ({ storage: localStorage as Storage | null, policyVersion: 1 })

  it('AC-DAILY-06: 201 trả {result, already:false}; POST đúng đường dẫn, JSON và X-Player-Id', async () => {
    saveConsent(localStorage, 1, 'granted')
    const out = await submitDailyResult(VERSION, body, opts())
    expect(out.already).toBe(false)
    expect(out.result.rank).toBe(1)
    const p = resultPosts()[0]!
    expect(p.url).toContain(`/lau-meme/api/daily/${VERSION}/results`)
    expect(JSON.parse(p.body!)).toEqual(body)
    expect(p.player).toBe(getPlayerId(localStorage))
  })

  it('AC-DAILY-08: 409 trả {result: kết quả đã lưu, already:true}', async () => {
    saveConsent(localStorage, 1, 'granted')
    resultsReply = () => json({ type: 'about:blank', title: 'Đã nộp', status: 409, result: STORED }, 409)
    const out = await submitDailyResult(VERSION, body, opts())
    expect(out).toEqual({ result: STORED, already: true })
  })

  it('AC-DAILY-08: 410 (mẻ đã qua), 400 và 422 ném SendError mang status', async () => {
    saveConsent(localStorage, 1, 'granted')
    for (const status of [410, 400, 422, 429]) {
      resultsReply = () => json({ type: 'about:blank', title: 'Lỗi', status }, status)
      const err = await submitDailyResult(VERSION, body, opts()).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(SendError)
      expect((err as SendError).status).toBe(status)
    }
  })

  it('AC-DAILY-06: chưa đồng ý thì ném lỗi (không phải SendError) và không fetch', async () => {
    const err = await submitDailyResult(VERSION, body, opts()).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeTruthy()
    expect(err).not.toBeInstanceOf(SendError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ================================================================ AC-DAILY-09: bảng xếp hạng
describe('daily ui: bảng xếp hạng', () => {
  const ROWS = [
    { rank: 1, nickname: 'Bếp Trưởng', value: 5 },
    { rank: 2, nickname: 'Thực khách ẩn danh', value: 6 },
  ]

  it('AC-DAILY-09: nút "Bảng xếp hạng" tải GET /daily/{version}/leaderboard và liệt kê "#1 Bếp Trưởng — 5 bước"', async () => {
    leaderboardReply = () => json({ version: VERSION, rows: ROWS, me: null })
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Bảng xếp hạng' }))
    const list = await screen.findByRole('list', { name: 'Bảng xếp hạng' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toBe('#1 Bếp Trưởng — 5 bước')
    expect(items[1]!.textContent).toBe('#2 Thực khách ẩn danh — 6 bước')
    expect(leaderboardGets()[0]!.url).toContain(`/lau-meme/api/daily/${VERSION}/leaderboard`)
  })

  it('AC-DAILY-09: chưa đồng ý thì GET bảng xếp hạng không mang X-Player-Id', async () => {
    saveConsent(localStorage, 1, 'declined')
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Bảng xếp hạng' }))
    await screen.findByRole('list', { name: 'Bảng xếp hạng' })
    expect(leaderboardGets()).toHaveLength(1)
    expect(calls().filter((c) => c.player !== null)).toEqual([])
  })

  it('AC-DAILY-09: getDailyLeaderboard gửi X-Player-Id khi đã đồng ý và trả {version, rows, me}', async () => {
    saveConsent(localStorage, 1, 'granted')
    const me = { rank: 25, nickname: 'Tôi', value: 9 }
    leaderboardReply = () => json({ version: VERSION, rows: ROWS, me })
    const out = await getDailyLeaderboard(VERSION, { storage: localStorage, policyVersion: 1 })
    expect(out).toEqual({ version: VERSION, rows: ROWS, me })
    expect(leaderboardGets()[0]!.player).toBe(getPlayerId(localStorage))
  })

  it('AC-DAILY-09: getDailyLeaderboard không gửi X-Player-Id khi chưa đồng ý hoặc không có storage (AC-PRIV-02)', async () => {
    await getDailyLeaderboard(VERSION, { storage: localStorage, policyVersion: 1 })
    await getDailyLeaderboard(VERSION, { storage: null, policyVersion: 1 })
    saveConsent(localStorage, 1, 'declined')
    await getDailyLeaderboard(VERSION, { storage: localStorage, policyVersion: 1 })
    expect(leaderboardGets()).toHaveLength(3)
    expect(leaderboardGets().every((g) => g.player === null)).toBe(true)
  })
})

// ================================================================ bổ sung: gửi lại, tự gửi sau tải lại, hạng của tôi, lỗi
describe('daily ui: gửi lại, tự gửi, hạng của tôi, lỗi', () => {
  it('AC-DAILY-06: giải xong khi chưa đồng ý thì không gửi; có nút "Gửi lại kết quả"; đồng ý rồi bấm thì POST và hiện hạng', async () => {
    saveConsent(localStorage, 1, 'declined')
    render(panel())
    await openBoard()
    await solve()
    expect(await screen.findByText(/Cần đồng ý chính sách dữ liệu để gửi/)).toBeTruthy()
    expect(resultPosts()).toEqual([])
    const retry = await screen.findByRole('button', { name: 'Gửi lại kết quả' })
    saveConsent(localStorage, 1, 'granted')
    fireEvent.click(retry)
    expect(await screen.findByText('Hạng #1 · Streak 1 ngày')).toBeTruthy()
    expect(resultPosts()).toHaveLength(1)
  })

  it('AC-DAILY-06: POST lần đầu trả 500 thì hiện "Gửi lại kết quả"; bấm sẽ POST lại', async () => {
    saveConsent(localStorage, 1, 'granted')
    resultsReply = () => json({ type: 'about:blank', title: 'Lỗi', status: 500 }, 500)
    render(panel())
    await openBoard()
    await solve()
    const retry = await screen.findByRole('button', { name: 'Gửi lại kết quả' })
    expect(resultPosts()).toHaveLength(1)
    resultsReply = () => json({ ...STORED, rank: 2, streak: { current: 3, longest: 3 } }, 201)
    fireEvent.click(retry)
    expect(await screen.findByText('Hạng #2 · Streak 3 ngày')).toBeTruthy()
    expect(resultPosts()).toHaveLength(2)
  })

  it('AC-DAILY-05: bàn đã giải nhưng chưa có kết quả; tải lại khi đã đồng ý thì tự POST đúng một lần, 409 hiện hạng đã lưu', async () => {
    saveConsent(localStorage, 1, 'granted')
    resultsReply = () => json({ type: 'about:blank', title: 'Lỗi', status: 500 }, 500)
    const first = render(panel())
    await openBoard()
    await solve()
    await screen.findByRole('button', { name: 'Gửi lại kết quả' })
    expect(resultPosts()).toHaveLength(1)
    first.unmount()

    resultsReply = () => json({ type: 'about:blank', title: 'Đã nộp', status: 409, result: STORED }, 409)
    const second = render(panel())
    expect(await screen.findByText('Hạng #3 · Streak 2 ngày')).toBeTruthy()
    expect(resultPosts()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(resultPosts()).toHaveLength(2)

    second.unmount()
    render(panel())
    await screen.findByRole('region', { name: 'Bàn thử thách' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(resultPosts().length).toBeLessThanOrEqual(3)
  })

  it('AC-DAILY-09: me ngoài top hiện thêm dòng "Bạn: #25 — 9 bước"', async () => {
    leaderboardReply = () => json({ version: VERSION, rows: [{ rank: 1, nickname: 'A', value: 4 }], me: { rank: 25, nickname: 'Bếp Trưởng', value: 9 } })
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Bảng xếp hạng' }))
    await screen.findByRole('list', { name: 'Bảng xếp hạng' })
    expect(await screen.findByText('Bạn: #25 — 9 bước')).toBeTruthy()
  })

  it('AC-DAILY-09: me null hoặc hạng đã nằm trong rows thì không có dòng "Bạn:"', async () => {
    leaderboardReply = () => json({ version: VERSION, rows: [{ rank: 1, nickname: 'A', value: 4 }], me: null })
    const a = render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Bảng xếp hạng' }))
    await screen.findByRole('list', { name: 'Bảng xếp hạng' })
    expect(screen.queryByText(/Bạn:/)).toBeNull()
    a.unmount()

    leaderboardReply = () =>
      json({ version: VERSION, rows: [{ rank: 1, nickname: 'A', value: 4 }], me: { rank: 1, nickname: 'A', value: 4 } })
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Bảng xếp hạng' }))
    await screen.findByRole('list', { name: 'Bảng xếp hạng' })
    expect(screen.queryByText(/Bạn:/)).toBeNull()
  })

  it('AC-DAILY-09: GET bảng xếp hạng trả 500 thì hiện "Không tải được bảng xếp hạng"', async () => {
    leaderboardReply = () => json({ type: 'about:blank', title: 'Lỗi', status: 500 }, 500)
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: 'Bảng xếp hạng' }))
    expect(await screen.findByText('Không tải được bảng xếp hạng')).toBeTruthy()
  })

  it('AC-DAILY-04: lookup bị từ chối thì hiện "Nồi trục trặc, thử lại nhé.", bộ đếm giữ nguyên và bàn vẫn dùng được', async () => {
    let broken = true
    const flaky = async (a: string, b: string): Promise<GraphResult | null> => {
      if (broken) throw new Error('giải mã lỗi')
      return lookup(a, b)
    }
    render(<DailyPanel manifest={manifestOf()} lookup={flaky} onDiscover={() => {}} storage={localStorage} />)
    await openBoard()
    fireEvent.click(el(NAMES.Cay!))
    fireEvent.click(el(NAMES['Cười']!))
    expect(await screen.findByText('Nồi trục trặc, thử lại nhé.')).toBeTruthy()
    counter(0)
    broken = false
    stepsDone = 0
    await mix('Cay', 'Cười')
    expect(el(NAMES['Tới Công Chuyện']!)).toBeTruthy()
  })
})
