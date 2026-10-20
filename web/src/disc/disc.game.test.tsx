// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/disc.md, phần web: Game.onDiscover và Root (AC-DISC-01, 05, 06, 09).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU
 *   Game: prop tùy chọn onDiscover?: (d: {a, b, result, id}) => void — a/b/result là TÊN, id là ElementId của result;
 *         gọi đúng một lần khi ghép ra phần tử mới đối với người chơi (không khi đã có sẵn, không khi trượt).
 *   Root: khi đã đồng ý, khám phá mới POST /lau-meme/api/discoveries và hiện dòng
 *         "Công thức gia truyền của <nickname>" (kèm "Bạn là người đầu tiên!" khi first:true).
 *         Chưa đồng ý: không gửi gì, hiện lời mời "Cần đồng ý chính sách dữ liệu để gửi".
 * Kéo thả/Nồi theo hợp đồng DOM của Game.test.tsx.
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { initialProgress, saveProgress } from '../game/engine'
import type { Item, Manifest, Progress } from '../game/engine'
import { Game } from '../game/Game'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { Root } from '../Root'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7

function manifestOf(): Manifest {
  return {
    version: VERSION,
    batch_at: '2026-10-20T00:00:00.000Z',
    graph_url: `/api/graph/${VERSION}`,
    starters: [
      { id: eid('Cay'), name: 'Cay', emoji: '🌶️' },
      { id: eid('Cười'), name: 'Cười', emoji: '😂' },
      { id: eid('Toang'), name: 'Toang', emoji: '💀' },
      { id: eid('Deadline'), name: 'Deadline', emoji: '⏰' },
    ],
    miss_lines: Array.from({ length: 30 }, (_, i) => `Nồi trào kiểu ${i}, khét rồi!`),
    daily: { element_id: eid('Tới Công Chuyện'), emoji: '🍜', hint: 'gợi ý', depth: 4 },
    policy_version: 1,
  } as Manifest
}

async function buildGraph(specs: Array<{ a: string; b: string; name: string; emoji?: string }>): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of specs) {
    const plain: GraphResult = { added_version: VERSION, depth: 1, emoji: s.emoji ?? '🍲', id: eid(s.name), image_key: null, name: s.name }
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

let fetchMock: ReturnType<typeof vi.fn>
let discoveryReply: () => Response
let discoveriesGetReply: () => Response = () => json({ items: [] })

async function installNet(): Promise<void> {
  const manifest = manifestOf()
  const graph = await buildGraph([{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' }])
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.includes('/manifest')) return json(manifest)
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    if (url.includes('/health')) return json({ status: 'ok', env: 'test', schema: '1' })
    if (url.includes('/api/discoveries') && method === 'POST') return discoveryReply()
    if (url.includes('/api/discoveries') && method === 'GET') return discoveriesGetReply()
    if (url.endsWith('/api/consents') && method === 'POST') return json({ created_at: '2026-10-20T00:00:00.000Z' }, 201)
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
const discoveryPosts = () => calls().filter((c) => c.method === 'POST' && c.url.endsWith('/api/discoveries'))

// ---------------------------------------------------------------- kéo thả
let dropTarget: Element | null = null
function drag(src: Element, dest: Element, at = { x: 100, y: 100 }): void {
  dropTarget = dest
  const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
  fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: at.x / 2, clientY: at.y / 2 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: at.x, clientY: at.y })
  fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: at.x, clientY: at.y })
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
const plateItem = (name: string): HTMLElement => {
  const el = within(plateEl()).queryAllByTestId('plate-item').find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
  return el
}
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')
async function potCombine(a: string, b: string): Promise<void> {
  drag(plateItem(a), slot(1))
  drag(plateItem(b), slot(2))
  await advance(1300)
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
function seed(mutate: (p: Progress) => void = () => {}): void {
  const p = initialProgress(manifestOf(), T0)
  p.tutorial_seen = true
  mutate(p)
  saveProgress(localStorage, p)
}
function owned(name: string, emoji: string): Item {
  return { id: eid(name), name, emoji, depth: 1, added_version: VERSION, image_key: null, discovered_at: '2026-10-01T00:00:00.000Z' }
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  window.history.pushState({}, '', '/lau-meme/')
  dropTarget = null
  discoveriesGetReply = () => json({ items: [] })
  discoveryReply = () =>
    json({ element_id: eid('Tới Công Chuyện'), nickname: 'Bếp Trưởng', discovered_at: '2026-10-20T03:00:01.000Z', first: true }, 201)
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
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

// ================================================================ Game.onDiscover
describe('disc: Game.onDiscover', () => {
  async function mountGame(onDiscover: (d: { a: string; b: string; result: string; id: string }) => void): Promise<void> {
    await installNet()
    render(<Game onDiscover={onDiscover} />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
  }

  it('AC-DISC-05: ghép ra phần tử mới gọi onDiscover đúng một lần với tên a/b/result và id của kết quả', async () => {
    seed()
    const spy = vi.fn()
    await mountGame(spy)
    await potCombine('Cay', 'Cười')
    expect(spy).toHaveBeenCalledTimes(1)
    const d = spy.mock.calls[0]![0] as { a: string; b: string; result: string; id: string }
    expect([d.a, d.b].sort()).toEqual(['Cay', 'Cười'].sort())
    expect(d.result).toBe('Tới Công Chuyện')
    expect(d.id).toBe(eid('Tới Công Chuyện'))
  })

  it('AC-DISC-06: ghép ra phần tử người chơi đã có thì KHÔNG gọi onDiscover', async () => {
    seed((p) => p.items.push(owned('Tới Công Chuyện', '🔥')))
    const spy = vi.fn()
    await mountGame(spy)
    await potCombine('Cay', 'Cười')
    expect(spy).not.toHaveBeenCalled()
  })

  it('AC-DISC-07: ghép trượt (không có công thức) KHÔNG gọi onDiscover', async () => {
    seed()
    const spy = vi.fn()
    await mountGame(spy)
    await potCombine('Cay', 'Deadline')
    expect(await screen.findByTestId('miss-line')).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()
  })
})

// ================================================================ Root
describe('disc: Root', () => {
  async function mountRoot(): Promise<void> {
    await installNet()
    seed()
    render(<Root />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
  }

  it('AC-DISC-05: đã đồng ý, khám phá mới POST /lau-meme/api/discoveries và hiện "Công thức gia truyền của <nickname>" + "Bạn là người đầu tiên!"', async () => {
    saveConsent(localStorage, 1, 'granted')
    await mountRoot()
    await potCombine('Cay', 'Cười')
    expect(await screen.findByText(/Công thức gia truyền của Bếp Trưởng/)).toBeTruthy()
    expect(screen.getByText(/Bạn là người đầu tiên!/)).toBeTruthy()
    const posts = discoveryPosts()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.player).toBe(getPlayerId(localStorage))
    const body = JSON.parse(posts[0]!.body!) as { a: string; b: string; result: string }
    expect([body.a, body.b].sort()).toEqual(['Cay', 'Cười'].sort())
    expect(body.result).toBe('Tới Công Chuyện')
  })

  it('AC-DISC-06: máy chủ trả first:false thì vẫn hiện dòng Công thức gia truyền của người đầu tiên nhưng không có "Bạn là người đầu tiên!"', async () => {
    saveConsent(localStorage, 1, 'granted')
    discoveryReply = () =>
      json({ element_id: eid('Tới Công Chuyện'), nickname: 'Thực khách ẩn danh', discovered_at: '2026-10-19T03:00:00.000Z', first: false }, 200)
    await mountRoot()
    await potCombine('Cay', 'Cười')
    expect(await screen.findByText(/Công thức gia truyền của Thực khách ẩn danh/)).toBeTruthy()
    expect(screen.queryByText(/Bạn là người đầu tiên!/)).toBeNull()
  })

  it('AC-DISC-05: chưa đồng ý (đã chọn "Chỉ chơi") thì không gửi khám phá, không gửi X-Player-Id và hiện "Cần đồng ý chính sách dữ liệu để gửi"', async () => {
    saveConsent(localStorage, 1, 'declined')
    await mountRoot()
    await potCombine('Cay', 'Cười')
    expect(await screen.findByText(/Cần đồng ý chính sách dữ liệu để gửi/)).toBeTruthy()
    expect(discoveryPosts()).toEqual([])
    expect(calls().filter((c) => c.player !== null)).toEqual([])
    expect(screen.queryByText(/Công thức gia truyền của/)).toBeNull()
  })

  it('AC-DISC-11: máy chủ trả 429 hoặc lỗi thì trò chơi vẫn chạy (Đĩa giữ phần tử mới), không hiện dòng Công thức gia truyền', async () => {
    saveConsent(localStorage, 1, 'granted')
    discoveryReply = () => json({ type: 'about:blank', title: 'Quá nhanh', status: 429 }, 429)
    await mountRoot()
    await potCombine('Cay', 'Cười')
    await waitFor(() => expect(discoveryPosts()).toHaveLength(1))
    expect(plateItem('Tới Công Chuyện')).toBeTruthy()
    expect(screen.queryByText(/Công thức gia truyền của/)).toBeNull()
  })
})

describe('disc: Root, Công thức gia truyền trên Đĩa và lỗi gửi', () => {
  it('AC-DISC-09: Đĩa đọc công khai GET /discoveries (không X-Player-Id, không cần đồng ý); phần tử C có title "Công thức gia truyền của Bếp Trưởng", D không có title', async () => {
    discoveriesGetReply = () =>
      json({ items: [{ element_id: eid('Tới Công Chuyện'), nickname: 'Bếp Trưởng', discovered_at: '2026-10-19T03:00:00.000Z' }] })
    await installNet()
    seed((p) => {
      p.items.push(owned('Tới Công Chuyện', '🔥'), owned('Chạy Deadline', '🏃'))
    })
    render(<Root />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(plateItem('Tới Công Chuyện').getAttribute('title')).toBe('Công thức gia truyền của Bếp Trưởng'))
    expect(plateItem('Chạy Deadline').hasAttribute('title')).toBe(false)
    const gets = calls().filter((c) => c.method === 'GET' && c.url.includes('/lau-meme/api/discoveries'))
    expect(gets.length).toBeGreaterThanOrEqual(1)
    const ids = gets.map((g) => decodeURIComponent(g.url)).join(',')
    expect(ids).toContain(eid('Tới Công Chuyện'))
    expect(ids).toContain(eid('Chạy Deadline'))
    expect(gets.every((g) => g.player === null)).toBe(true)
    expect(calls().filter((c) => c.player !== null)).toEqual([])
  })

  it('AC-DISC-11: POST khám phá trả 429 thì hiện "Gửi quá nhanh, thử lại sau." và không có dòng Công thức gia truyền', async () => {
    saveConsent(localStorage, 1, 'granted')
    discoveryReply = () => json({ type: 'about:blank', title: 'Quá nhanh', status: 429 }, 429)
    await installNet()
    seed()
    render(<Root />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    await potCombine('Cay', 'Cười')
    expect(await screen.findByText('Gửi quá nhanh, thử lại sau.')).toBeTruthy()
    expect(screen.queryByText(/Công thức gia truyền của/)).toBeNull()
  })

  it('AC-DISC-11: POST khám phá trả lỗi khác (500) thì hiện "Không gửi được khám phá, thử lại sau." và không có dòng Công thức gia truyền', async () => {
    saveConsent(localStorage, 1, 'granted')
    discoveryReply = () => json({ type: 'about:blank', title: 'Lỗi', status: 500 }, 500)
    await installNet()
    seed()
    render(<Root />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    await potCombine('Cay', 'Cười')
    expect(await screen.findByText('Không gửi được khám phá, thử lại sau.')).toBeTruthy()
    expect(screen.queryByText(/Công thức gia truyền của/)).toBeNull()
  })
})

// ================================================================ AC-DISC-01
describe('disc: UUID cục bộ', () => {
  it('AC-DISC-01: getPlayerId sinh UUID v4 bằng crypto.randomUUID đúng một lần, lưu ở laumeme:player-id và giữ nguyên khi gọi lại', () => {
    const spy = vi.spyOn(webcrypto, 'randomUUID')
    const id = getPlayerId(localStorage)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(localStorage.getItem('laumeme:player-id')).toBe(id)
    expect(getPlayerId(localStorage)).toBe(id)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('AC-DISC-01: tải lại (dựng lại Root) vẫn giữ UUID và UUID không xuất hiện trong DOM công khai', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    seed()
    const first = render(<Root />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    const id = getPlayerId(localStorage)
    expect(document.body.innerHTML).not.toContain(id)
    first.unmount()
    render(<Root />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    expect(getPlayerId(localStorage)).toBe(id)
    expect(document.body.innerHTML).not.toContain(id)
    expect(document.body.innerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
  })
})
