// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Test điểm vào của SHARE: thẻ Daily trong DailyPanel và thẻ Công thức gia truyền trong Root.
 * (AC-SHARE-01, AC-SHARE-04). Bề mặt cần có: <ShareCard> và buildDailyCardText/buildDiscCardText từ './index'
 * (xem share.test.tsx), SITE_URL từ '../base'.
 *
 * Daily: đăng nhập + đã giải + kết quả máy chủ => có ShareCard daily; chưa đăng nhập => không có nút "Sao chép".
 * Công thức gia truyền: khám phá first:true => có ShareCard discovery; first:false hoặc chưa đồng ý => không có.
 * Kiểm chữ qua nút "Sao chép" -> navigator.clipboard.writeText.
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentSession } from '../auth/session'
import { SITE_URL } from '../base'
import { DailyPanel } from '../daily/DailyPanel'
import { initialProgress, saveProgress } from '../game/engine'
import type { Manifest, Progress } from '../game/engine'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { saveConsent } from '../privacy/consent'
import { Root } from '../Root'
import { buildDailyCardText, buildDiscCardText } from './index'

// ---------------------------------------------------------------- fixtures
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T08:00:00.000Z')
const VERSION = 7
const BATCH_AT = '2026-10-20T05:00:00.000Z' // 12:00 GMT+7
const SOLVED = { a: 'Hết Cứu', b: 'Cay', name: 'Stonks' }
type SessionArg = Parameters<typeof setCurrentSession>[0]
const SESSION = { nickname: null, created_at: '2026-10-20T02:00:00.000Z' } as unknown as SessionArg

function manifestOf(): Manifest {
  return {
    version: VERSION,
    batch_at: BATCH_AT,
    graph_url: `/api/graph/${VERSION}`,
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

const NEW_RESULT = { version: VERSION, solve_ms: 3_905_000, rank: 12, streak: { current: 1, longest: 1 }, solved_at: '2026-10-20T06:05:05.000Z' }
let discoveryReply: () => Response
const writeText = vi.fn()

async function installNet(): Promise<void> {
  const manifest = manifestOf()
  const graph = await buildGraph([{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' }])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      const method = methodOf(input, init)
      if (url.includes('/daily/') && url.endsWith('/results') && method === 'POST') return json(NEW_RESULT, 201)
      if (url.includes('/manifest')) return json(manifest)
      if (url.includes('/graph/')) return json(graph)
      if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
      if (url.includes('/health')) return json({ status: 'ok', env: 'test', schema: '1' })
      if (url.includes('/api/discoveries') && method === 'POST') return discoveryReply()
      if (url.includes('/api/discoveries') && method === 'GET') return json({ items: [] })
      if (url.endsWith('/api/consents') && method === 'POST') return json({ created_at: '2026-10-20T00:00:00.000Z' }, 201)
      return new Response(null, { status: 204 })
    }),
  )
}

// ---------------------------------------------------------------- kéo thả (theo disc.game.test.tsx)
let dropTarget: Element | null = null
function drag(src: Element, dest: Element, at = { x: 100, y: 100 }): void {
  dropTarget = dest
  const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
  fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: at.x / 2, clientY: at.y / 2 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: at.x, clientY: at.y })
  fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: at.x, clientY: at.y })
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
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300)
  })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
function seed(): void {
  const p: Progress = initialProgress(manifestOf(), T0)
  p.tutorial_seen = true
  saveProgress(localStorage, p)
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
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  discoveryReply = () =>
    json({ element_id: eid('Tới Công Chuyện'), nickname: 'Bếp Trưởng', discovered_at: '2026-10-20T08:00:01.000Z', first: true }, 201)
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
  act(() => setCurrentSession(null))
})
afterEach(() => {
  cleanup()
  act(() => setCurrentSession(null))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ Daily
describe('share entry: thẻ Daily trong DailyPanel', () => {
  it('AC-SHARE-01: đã đăng nhập và có kết quả thì hiện thẻ chia sẻ Daily, chữ đúng định dạng, không lộ đáp án', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    act(() => setCurrentSession(SESSION))
    render(<DailyPanel manifest={manifestOf()} storage={localStorage} solved={SOLVED} />)
    expect(await screen.findByText(/Hạng #12/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Chia sẻ/ })).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: /Sao chép/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const text = writeText.mock.calls[0]![0] as string
    expect(text).toBe(
      buildDailyCardText({ day: '2026-10-20', batchHour: 12, emoji: '📈', solveSeconds: 3905, rank: 12, link: SITE_URL }),
    )
    expect(text.split('\n')[0]).toBe('Lẩu Meme 🍲 Món đặc biệt 20/10 · mẻ 12h')
    expect(text.split('\n')[1]).toBe('📈 giải sau 1 giờ 05 phút · hạng #12')
    for (const leak of [SOLVED.name, SOLVED.a, SOLVED.b]) expect(text).not.toContain(leak)
  })

  it('AC-SHARE-01: chưa đăng nhập thì chưa có thẻ chia sẻ (thời gian giải chỉ do máy chủ tính)', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    render(<DailyPanel manifest={manifestOf()} storage={localStorage} solved={SOLVED} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.queryByRole('button', { name: /Sao chép/ })).toBeNull()
    expect(screen.queryByText(/Hạng #/)).toBeNull()
  })
})

// ================================================================ Công thức gia truyền
describe('share entry: thẻ Công thức gia truyền trong Root', () => {
  async function mountRoot(): Promise<void> {
    await installNet()
    seed()
    render(<Root />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
  }

  it('AC-SHARE-04: người đầu tiên khám phá thì hiện thẻ chia sẻ, chữ đúng, không lộ 2 phần tử đầu vào', async () => {
    saveConsent(localStorage, 1, 'granted')
    await mountRoot()
    await potCombine('Cay', 'Cười')
    expect(await screen.findByText(/Bạn là người đầu tiên!/)).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: /Sao chép/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const text = writeText.mock.calls[0]![0] as string
    expect(text).toBe(buildDiscCardText({ emoji: '🔥', name: 'Tới Công Chuyện', nickname: 'Bếp Trưởng', link: SITE_URL }))
    expect(text.split('\n')[0]).toBe(
      'Mình là người đầu tiên nấu ra 🔥 Tới Công Chuyện trên Lẩu Meme - Công thức gia truyền của Bếp Trưởng',
    )
    expect(text).toContain('?ref=disc')
    expect(text).not.toContain('Cay')
    expect(text).not.toContain('Cười')
  })

  it('AC-SHARE-04: first:false (đã có người nấu trước) thì không có thẻ chia sẻ', async () => {
    saveConsent(localStorage, 1, 'granted')
    discoveryReply = () =>
      json({ element_id: eid('Tới Công Chuyện'), nickname: 'Thực khách ẩn danh', discovered_at: '2026-10-19T03:00:00.000Z', first: false }, 200)
    await mountRoot()
    await potCombine('Cay', 'Cười')
    expect(await screen.findByText(/Công thức gia truyền của Thực khách ẩn danh/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sao chép/ })).toBeNull()
  })

  it('AC-SHARE-04: chưa đồng ý thì không có thẻ chia sẻ', async () => {
    saveConsent(localStorage, 1, 'declined')
    await mountRoot()
    await potCombine('Cay', 'Cười')
    expect(await screen.findByText(/Cần đồng ý chính sách dữ liệu để gửi/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sao chép/ })).toBeNull()
  })
})
