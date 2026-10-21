// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests for docs/acceptance/daily.md, <Game /> integration: AC-DAILY-04/05/06/15.
 * Making the Món đặc biệt on the normal board (pot or table stack) counts as solving; no challenge board, no steps.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES
 *   Game: whenever a combine on the pot or a table stack yields the element whose id equals manifest.daily.element_id
 *     (even if it was already on the plate) it calls saveSolved(storage, manifest.version, { a, b, name }) and renders
 *     <DailyPanel solved=...>; on load it reads loadSolved(storage, version). Misses change nothing.
 *   ./solved:  one key 'laumeme:daily-solved' holding { version, a, b, name }
 *   ../auth/session: setCurrentSession(s | null)
 * The harness (fake pointer drag, graph encryption, queries) follows web/src/game/Game.test.tsx.
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentSession } from '../auth/session'
import { initialProgress, saveProgress } from '../game/engine'
import type { Item, Manifest, Progress } from '../game/engine'
import { Game } from '../game/Game'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { saveConsent } from '../privacy/consent'
import { saveSolved } from './solved'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const KEY = 'laumeme:daily-solved'
type SessionArg = Parameters<typeof setCurrentSession>[0]
const SESSION = { nickname: null, created_at: '2026-10-20T02:00:00.000Z' } as unknown as SessionArg

interface Spec {
  a: string
  b: string
  name: string
  emoji?: string
  depth?: number
}
const SPECS: Spec[] = [
  { a: 'Hết Cứu', b: 'Cay', name: 'Stonks', emoji: '📈', depth: 4 },
  { a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
]

async function buildGraph(version: number, specs: Spec[]): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of specs) {
    const plain: GraphResult = { added_version: version, depth: s.depth ?? 1, emoji: s.emoji ?? '🍲', id: eid(s.name), image_key: null, name: s.name }
    const [x, y] = [fold(s.a), fold(s.b)].sort()
    const key = sha('lm1|k|' + x + '\0' + y)
    const ikm = await webcrypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
    const okm = new Uint8Array(
      await webcrypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + version), info: enc.encode('lm1|aes-gcm') },
        ikm,
        44 * 8,
      ),
    )
    const aes = await webcrypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt'])
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) }, aes, enc.encode(JSON.stringify(plain)))
    entries[key] = Buffer.from(new Uint8Array(ct)).toString('base64url')
  }
  return { format: 1, version, entries }
}

function manifestOf(version = 7): Manifest {
  return {
    version,
    batch_at: '2026-10-20T00:00:00.000Z',
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

function item(name: string, emoji: string, depth: number, added_version: number, discovered_at: string): Item {
  return { id: eid(name), name, emoji, depth, added_version, image_key: null, discovered_at }
}

// ---------------------------------------------------------------- fake network
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

const NEW_RESULT = { version: 7, solve_ms: 1_805_000, rank: 2, streak: { current: 3, longest: 3 }, solved_at: '2026-10-20T06:00:05.000Z' }
let resultsReply: () => Response
let fetchMock: ReturnType<typeof vi.fn>

async function installNet(version = 7): Promise<void> {
  const manifest = manifestOf(version)
  const graph = await buildGraph(version, SPECS)
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.includes('/daily/') && url.endsWith('/results') && method === 'POST') return resultsReply()
    if (url.includes('/daily/') && method === 'GET') return json({ version, rows: [], me: null })
    if (url.includes('/auth/session')) return json({ type: 'about:blank', title: 'Chưa đăng nhập', status: 401 }, 401)
    if (url.includes('/manifest')) return json(manifest)
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const resultPosts = () =>
  fetchMock.mock.calls
    .map((c) => ({ url: urlOf(c[0] as RequestInfo), method: methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined), body: (c[1] as RequestInit | undefined)?.body as string | undefined }))
    .filter((c) => c.method === 'POST' && c.url.includes('/daily/') && c.url.endsWith('/results'))

// ---------------------------------------------------------------- drag and drop (same as Game.test.tsx)
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
const plateItems = (): HTMLElement[] => within(plateEl()).queryAllByTestId('plate-item')
const plateNames = (): string[] => plateItems().map((e) => e.dataset.name ?? '')
const plateItem = (name: string): HTMLElement => {
  const el = plateItems().find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa: ${plateNames().join(', ')}`)
  return el
}
const tableEl = (): HTMLElement => screen.getByTestId('table')
const tableItems = (): HTMLElement[] => screen.queryAllByTestId('table-item')
const tableNames = (): string[] => tableItems().map((e) => e.dataset.name ?? '')
const tableItem = (name: string): HTMLElement => {
  const el = tableItems().find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trên bàn: ${tableNames().join(', ')}`)
  return el
}
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')
const card = (): HTMLElement => screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })

async function mountReady(): Promise<void> {
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
async function reload(): Promise<void> {
  cleanup()
  fetchMock.mockClear()
  await mountReady()
}
async function potCombine(a: string, b: string): Promise<void> {
  drag(plateItem(a), slot(1))
  drag(plateItem(b), slot(2))
  await advance(1300)
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
function seed(mutate: (p: Progress) => void = () => {}, version = 7): Progress {
  const p = initialProgress(manifestOf(version), T0)
  p.tutorial_seen = true
  mutate(p)
  saveProgress(localStorage, p)
  return p
}
/** Plate with the ingredient of the Món đặc biệt. */
const withIngredient = (p: Progress): void => {
  p.items.push(item('Hết Cứu', '🧯', 3, 1, '2026-10-19T00:00:00.000Z'))
}
const stored = (): { version: number; a: string; b: string; name: string } | null => {
  const s = localStorage.getItem(KEY)
  return s === null ? null : (JSON.parse(s) as { version: number; a: string; b: string; name: string })
}
const foldedPair = (s: { a: string; b: string }): string[] => [fold(s.a), fold(s.b)].sort()
const hasText = (t: string): boolean => Array.from(document.body.querySelectorAll('*')).some((e) => e.textContent?.trim() === t)
const hasMatch = (re: RegExp): boolean => Array.from(document.body.querySelectorAll('*')).some((e) => re.test(e.textContent ?? ''))
const INVITE = 'Đăng nhập bằng Google để lên bảng xếp hạng'

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  dropTarget = null
  resultsReply = () => json(NEW_RESULT, 201)
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
  await installNet()
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

// ================================================================ AC-DAILY-04
describe('game + daily: ghép ra Món đặc biệt trên bàn lẩu', () => {
  it('AC-DAILY-04: ghép bằng nồi lẩu ra đúng món đích thì thẻ lộ tên "Stonks" và hiện "Đã giải"; trạng thái được lưu cục bộ; không có bàn thử thách, không đếm bước', async () => {
    seed(withIngredient)
    await mountReady()
    expect(within(card()).getByText('???')).toBeTruthy()
    expect(within(card()).queryByText('Đã giải')).toBeNull()
    expect(screen.queryByRole('button', { name: /thử thách/i })).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()

    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Stonks')).toBeTruthy())
    expect(within(card()).getByText('Đã giải')).toBeTruthy()
    expect(within(card()).queryByText('???')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Bàn thử thách' })).toBeNull()
    expect(document.body.textContent).not.toMatch(/Bước:/)
    expect(plateNames()).toContain('Stonks') // it still lands on the normal plate and table
    expect(tableNames()).toContain('Stonks')

    const s = stored()!
    expect(s.version).toBe(7)
    expect(s.name).toBe('Stonks')
    expect(foldedPair(s)).toEqual(['cay', 'het cuu'])
  })

  it('AC-DAILY-04: thả chồng trên bàn ra đúng món đích cũng tính là giải', async () => {
    seed(withIngredient)
    await mountReady()
    drag(plateItem('Hết Cứu'), tableEl(), { x: 80, y: 90 })
    drag(plateItem('Cay'), tableEl(), { x: 300, y: 210 })
    expect(tableNames().sort()).toEqual(['Cay', 'Hết Cứu'])

    drag(tableItem('Hết Cứu'), tableItem('Cay'), { x: 300, y: 210 })
    await waitFor(() => expect(tableNames()).toEqual(['Stonks']))
    await waitFor(() => expect(within(card()).getByText('Stonks')).toBeTruthy())
    expect(within(card()).getByText('Đã giải')).toBeTruthy()
    const s = stored()!
    expect(s.name).toBe('Stonks')
    expect(foldedPair(s)).toEqual(['cay', 'het cuu'])
  })

  it('AC-DAILY-04: "Stonks" đã có sẵn trong Đĩa mà chưa ghép lại trong mẻ thì chưa tính là giải; ghép lại thì mới tính', async () => {
    seed((p) => {
      withIngredient(p)
      p.items.push(item('Stonks', '📈', 4, 1, '2026-10-19T00:00:00.000Z'))
    })
    await mountReady()
    expect(within(card()).getByText('???')).toBeTruthy()
    expect(within(card()).queryByText('Đã giải')).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(card().textContent).not.toContain('Stonks')

    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Stonks')).toBeTruthy())
    expect(within(card()).getByText('Đã giải')).toBeTruthy()
    expect(plateNames().filter((n) => n === 'Stonks')).toHaveLength(1)
    expect(stored()?.name).toBe('Stonks')
  })

  it('AC-DAILY-04: ghép trượt hoặc ra món khác thì không ảnh hưởng gì tới Món đặc biệt, kể cả khi đã đăng nhập', async () => {
    saveConsent(localStorage, 1, 'granted')
    seed(withIngredient)
    await mountReady()
    act(() => setCurrentSession(SESSION))

    await potCombine('Cay', 'Toang') // miss
    await potCombine('Cay', 'Cười') // real recipe, not the target
    expect(tableNames()).toContain('Tới Công Chuyện')
    expect(within(card()).getByText('???')).toBeTruthy()
    expect(within(card()).queryByText('Đã giải')).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    await advance(2000)
    expect(resultPosts()).toEqual([])
  })
})

// ================================================================ AC-DAILY-05
describe('game + daily: trạng thái đã giải', () => {
  it('AC-DAILY-05: tải lại trong cùng mẻ thì thẻ vẫn "Đã giải" kèm tên; chưa đăng nhập thì không gửi gì', async () => {
    seed(withIngredient)
    await mountReady()
    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Đã giải')).toBeTruthy())

    await reload()
    expect(within(card()).getByText('Stonks')).toBeTruthy()
    expect(within(card()).getByText('Đã giải')).toBeTruthy()
    expect(within(card()).queryByText('???')).toBeNull()
    await advance(2000)
    expect(resultPosts()).toEqual([])
  })

  it('AC-DAILY-05: giải khi chưa đăng nhập, tải lại, rồi đăng nhập thì client gửi lại kết quả', async () => {
    saveConsent(localStorage, 1, 'granted')
    seed(withIngredient)
    await mountReady()
    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Đã giải')).toBeTruthy())
    expect(resultPosts()).toEqual([])

    await reload()
    expect(resultPosts()).toEqual([])
    act(() => setCurrentSession(SESSION))
    await waitFor(() => expect(resultPosts()).toHaveLength(1))
    await waitFor(() => expect(hasMatch(/Hạng #2 · Streak 3/)).toBe(true))
    const body = JSON.parse(resultPosts()[0]!.body!) as { a: string; b: string }
    expect(foldedPair(body)).toEqual(['cay', 'het cuu'])
  })

  it('AC-DAILY-05: sang mẻ V+1 thì trạng thái của V bị bỏ và thẻ mới hiện "???"', async () => {
    saveSolved(localStorage, 7, { a: 'Hết Cứu', b: 'Cay', name: 'Stonks' })
    cleanup()
    await installNet(8)
    seed(withIngredient, 8)
    await mountReady()
    expect(within(card()).getByText('???')).toBeTruthy()
    expect(within(card()).queryByText('Đã giải')).toBeNull()
    expect(card().textContent).not.toContain('Stonks')
    await advance(2000)
    expect(resultPosts()).toEqual([])
  })
})

// ================================================================ AC-DAILY-06 / 15
describe('game + daily: gửi kết quả sau khi giải', () => {
  it('AC-DAILY-06: đã đăng nhập thì giải xong tự gửi { a, b } đúng một lần và hiện "Hạng #… · Streak …"', async () => {
    saveConsent(localStorage, 1, 'granted')
    seed(withIngredient)
    await mountReady()
    act(() => setCurrentSession(SESSION))
    expect(resultPosts()).toEqual([]) // nothing to send before solving

    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(resultPosts()).toHaveLength(1))
    await waitFor(() => expect(hasMatch(/Hạng #2 · Streak 3/)).toBe(true))
    const post = resultPosts()[0]!
    expect(post.url).toContain('/lau-meme/api/daily/7/results')
    const body = JSON.parse(post.body!) as { a: string; b: string }
    expect(Object.keys(body).sort()).toEqual(['a', 'b'])
    expect(foldedPair(body)).toEqual(['cay', 'het cuu'])
    await advance(5000)
    expect(resultPosts()).toHaveLength(1)
  })

  it('AC-DAILY-15: giải khi chưa đăng nhập thì thẻ hiện "Đã giải" và lời mời đăng nhập; đăng nhập xong tự gửi ngay không cần bấm thêm', async () => {
    saveConsent(localStorage, 1, 'granted')
    seed(withIngredient)
    await mountReady()
    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Đã giải')).toBeTruthy())
    await waitFor(() => expect(hasText(INVITE)).toBe(true))
    expect(resultPosts()).toEqual([])

    act(() => setCurrentSession(SESSION))
    await waitFor(() => expect(resultPosts()).toHaveLength(1))
    await waitFor(() => expect(hasMatch(/Hạng #2 · Streak 3/)).toBe(true))
    expect(hasText(INVITE)).toBe(false)
  })
})
