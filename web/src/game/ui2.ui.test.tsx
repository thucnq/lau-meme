// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests (jsdom) for UI2: AC-GAME-19, AC-GAME-21 (hint), AC-DAILY-16, AC-DAILY-17.
 * Layout and computed-style parts live in ui2.browser.test.tsx (jsdom computes no boxes).
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (everything is reached through <Game /> with no props, as in game.ui.test.tsx)
 *   - header (role "banner"): game title, theme toggle ("Chuyển chế độ") and the account area. Account area is the
 *     AuthBar: button "Đăng nhập bằng Google" when signed out, text "Đã đăng nhập: <nickname>" when signed in.
 *     No "Dọn bàn" / "Chơi lại từ đầu" / "?" in the header; no sign-in button anywhere outside the header.
 *   - "Dọn bàn", "Chơi lại từ đầu", "?" are buttons inside the nearest section that also holds the pot, and that
 *     section holds neither the header nor the footer.
 *   - two top-level tabs (role "tab") "Bàn lẩu" (default selected) and "Bảng xếp hạng"; the card
 *     (region "Món đặc biệt hôm nay") has a button "Xem bảng xếp hạng" that selects the second tab, and no longer holds
 *     the leaderboard (no "Mẻ này"/"Tuần"/"Tháng" tabs inside the card).
 *   - leaderboard row of the viewer: aria-current="true" on the row (or an element inside it); ranks 1-3 show 🥇🥈🥉.
 *   - card: label "Thử thách" (not a button), lead "Ghép ra món bí ẩn này trên bàn lẩu"; "Đã giải" replaces the label.
 *   - touch hint "Giữ món để kéo, vuốt chỗ trống để cuộn" with a close button named /đóng/i, shown only when
 *     matchMedia('(pointer: coarse)') matches (this file also sets navigator.maxTouchPoints), until closed or the first
 *     successful drop; stored with the local progress.
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentSession } from '../auth/session'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { saveConsent } from '../privacy/consent'
import { initialProgress, saveProgress } from './engine'
import type { Item, Manifest, Progress } from './engine'
import { Game } from './Game'

// ---------------------------------------------------------------- fixtures
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7
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

function manifestOf(version = VERSION): Manifest {
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

const CREATED = '2026-10-19T01:00:00.000Z'
let fetchMock: ReturnType<typeof vi.fn>
let batchBoardReply: () => Response
let periodBoardReply: (period: string) => Response
let serverSession: { nickname: string | null; created_at: string } | null
let signInAs: { nickname: string | null; created_at: string }

const emptyBatch = (): Response => json({ version: VERSION, rows: [], me: null })
const emptyPeriod = (period: string): Response =>
  json({ period, starts_at: '2026-10-18T17:00:00.000Z', ends_at: '2026-10-25T17:00:00.000Z', batches: 0, rows: [], me: null })

async function installNet(): Promise<void> {
  const manifest = manifestOf()
  const graph = await buildGraph(VERSION, SPECS)
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.endsWith('/api/auth/google') && method === 'POST') {
      serverSession = signInAs
      return json(signInAs)
    }
    if (url.endsWith('/api/auth/session') && method === 'GET') {
      return serverSession ? json(serverSession) : json({ type: 'about:blank', title: 'Chưa đăng nhập', status: 401 }, 401)
    }
    if (url.endsWith('/api/auth/session') && method === 'DELETE') {
      serverSession = null
      return new Response(null, { status: 204 })
    }
    if (url.includes('/daily/') && url.endsWith('/results') && method === 'POST') {
      return json({ version: VERSION, solve_ms: 1_805_000, rank: 2, streak: { current: 3, longest: 3 }, solved_at: '2026-10-20T06:00:05.000Z' }, 201)
    }
    if (url.includes('/daily/leaderboard') && method === 'GET') return periodBoardReply(new URL(url, 'https://example.com').searchParams.get('period') ?? '')
    if (url.includes('/daily/') && url.endsWith('/leaderboard') && method === 'GET') return batchBoardReply()
    if (url.includes('/manifest')) return json(manifest)
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

// Google Identity Services stub: renderButton appends a button whose click delivers a fake credential.
type GisCfg = { client_id: string; callback: (r: { credential: string }) => void }
function installGis(): void {
  let cfg: GisCfg | null = null
  const id = {
    initialize: vi.fn((c: GisCfg) => {
      cfg = c
    }),
    renderButton: vi.fn((el: HTMLElement) => {
      const b = document.createElement('button')
      b.textContent = 'Đăng nhập bằng Google'
      b.addEventListener('click', () => cfg!.callback({ credential: 'fake.id.token' }))
      el.appendChild(b)
    }),
    prompt: vi.fn(),
    disableAutoSelect: vi.fn(),
  }
  vi.stubGlobal('google', { accounts: { id } })
}

// ---------------------------------------------------------------- touch / pointer environment
function setTouch(on: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: on && /pointer:\s*coarse|hover:\s*none/.test(q),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: on ? 5 : 0 })
}

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

// ---------------------------------------------------------------- DOM queries
const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
const plateItems = (): HTMLElement[] => within(plateEl()).queryAllByTestId('plate-item')
const plateItem = (name: string): HTMLElement => {
  const el = plateItems().find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
  return el
}
const tableEl = (): HTMLElement => screen.getByTestId('table')
const tableNames = (): string[] => screen.queryAllByTestId('table-item').map((e) => e.dataset.name ?? '')
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')
const card = (): HTMLElement => screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })
const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })
const hasText = (t: string): boolean => Array.from(document.body.querySelectorAll('*')).some((e) => e.textContent?.trim() === t)
const seeText = (t: string) => waitFor(() => expect(hasText(t), `thiếu dòng "${t}"`).toBe(true))
const BOARD_INVITE = 'Đăng nhập bằng Google để có tên trên bảng xếp hạng'
const HINT = 'Giữ món để kéo, vuốt chỗ trống để cuộn'

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
function seed(mutate: (p: Progress) => void = () => {}): Progress {
  const p = initialProgress(manifestOf(), T0)
  p.tutorial_seen = true
  mutate(p)
  saveProgress(localStorage, p)
  return p
}
const withIngredient = (p: Progress): void => {
  p.items.push(item('Hết Cứu', '🧯', 3, 1, '2026-10-19T00:00:00.000Z'))
}
/** Deepest element whose text contains `needle`. */
function deepestWith(needle: string): HTMLElement {
  const all = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter((e) => (e.textContent ?? '').includes(needle))
  const leaf = all.find((e) => !Array.from(e.children).some((c) => (c.textContent ?? '').includes(needle)))
  if (!leaf) throw new Error(`Không thấy "${needle}"`)
  return leaf
}
/** Row of the leaderboard: climb from the nickname to the first ancestor that also holds the time text. */
function rowOf(nickname: string, time: string): HTMLElement {
  let el: HTMLElement | null = deepestWith(nickname)
  while (el && !(el.textContent ?? '').includes(time)) el = el.parentElement
  if (!el) throw new Error(`Không thấy dòng "${nickname}" kèm "${time}"`)
  return el
}
const isHighlighted = (row: HTMLElement): boolean => row.closest('[aria-current="true"]') !== null || row.querySelector('[aria-current="true"]') !== null

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  dropTarget = null
  serverSession = null
  signInAs = { nickname: null, created_at: CREATED }
  batchBoardReply = emptyBatch
  periodBoardReply = emptyPeriod
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  setTouch(false)
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

// ================================================================ AC-GAME-19
describe('ui2: đầu trang, khu bàn lẩu (AC-GAME-19)', () => {
  const CONTROL_NAMES = ['Dọn bàn', 'Chơi lại từ đầu', '?']

  it('AC-GAME-19: chưa đăng nhập, đầu trang chỉ có tên game, nút đổi giao diện và nút "Đăng nhập bằng Google"; không có Dọn bàn, Chơi lại, "?"', async () => {
    saveConsent(localStorage, 1, 'granted')
    installGis()
    seed()
    await mountReady()
    const header = screen.getByRole('banner')
    expect(within(header).getByRole('heading')).toBeTruthy()
    expect(within(header).getByRole('button', { name: /Chuyển chế độ/ })).toBeTruthy()
    expect(await within(header).findByRole('button', { name: 'Đăng nhập bằng Google' })).toBeTruthy()
    for (const name of CONTROL_NAMES) expect(within(header).queryByRole('button', { name }), `"${name}" không được nằm ở đầu trang`).toBeNull()
    const names = within(header).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '')
    for (const n of names) expect(['Đăng nhập bằng Google'].some((ok) => n === ok) || /Chuyển chế độ/.test(n), `nút lạ ở đầu trang: "${n}"`).toBe(true)
  })

  it('AC-GAME-19: nút đăng nhập chỉ có ở đầu trang, chân trang không còn nút đăng nhập', async () => {
    saveConsent(localStorage, 1, 'granted')
    installGis()
    seed()
    await mountReady()
    const header = screen.getByRole('banner')
    await within(header).findByRole('button', { name: 'Đăng nhập bằng Google' })
    const all = screen.getAllByRole('button', { name: 'Đăng nhập bằng Google' })
    expect(all.length).toBeGreaterThan(0)
    for (const b of all) expect(header.contains(b), 'nút đăng nhập nằm ngoài đầu trang').toBe(true)
    const footer = screen.queryByRole('contentinfo')
    if (footer) expect(within(footer).queryByRole('button', { name: /Đăng nhập/ })).toBeNull()
  })

  it('AC-GAME-19: đăng nhập thành công thì đầu trang hiện "Đã đăng nhập: <nickname>", nút đăng nhập biến mất ở mọi nơi', async () => {
    saveConsent(localStorage, 1, 'granted')
    installGis()
    signInAs = { nickname: 'Lẩu Thủ', created_at: CREATED }
    seed()
    await mountReady()
    const header = screen.getByRole('banner')
    fireEvent.click(await within(header).findByRole('button', { name: 'Đăng nhập bằng Google' }))
    await waitFor(() => expect(header.textContent).toContain('Đã đăng nhập: Lẩu Thủ'))
    expect(screen.queryByRole('button', { name: 'Đăng nhập bằng Google' })).toBeNull()
    for (const name of CONTROL_NAMES) expect(within(header).queryByRole('button', { name })).toBeNull()
  })

  it('AC-GAME-19: "Dọn bàn", "Chơi lại từ đầu", "?" nằm trong khu bàn lẩu (cùng khu với nồi), ngoài đầu trang và chân trang', async () => {
    seed()
    await mountReady()
    const header = screen.getByRole('banner')
    const footer = screen.queryByRole('contentinfo')
    for (const name of CONTROL_NAMES) {
      const btn = screen.getByRole('button', { name })
      expect(header.contains(btn)).toBe(false)
      expect(footer?.contains(btn) ?? false).toBe(false)
      let section: HTMLElement | null = btn
      while (section && !section.contains(pot())) section = section.parentElement
      expect(section, `"${name}" không cùng khu với nồi`).not.toBeNull()
      expect(section!.contains(header), `khu chứa "${name}" không được chứa đầu trang`).toBe(false)
      expect(section!.contains(btn)).toBe(true)
      expect(section === document.body).toBe(false)
    }
  })

  it('AC-GAME-19: hành vi giữ nguyên: "Dọn bàn" xóa bàn giữ Đĩa; "Chơi lại từ đầu" có hộp xác nhận, "Hủy" không đổi gì; "?" mở hướng dẫn', async () => {
    seed()
    await mountReady()
    drag(plateItem('Cay'), tableEl(), { x: 80, y: 90 })
    expect(tableNames()).toEqual(['Cay'])
    fireEvent.click(screen.getByRole('button', { name: 'Dọn bàn' }))
    await waitFor(() => expect(tableNames()).toEqual([]))
    expect(plateItems().map((e) => e.dataset.name)).toContain('Cay')

    drag(plateItem('Cười'), tableEl(), { x: 80, y: 90 })
    fireEvent.click(screen.getByRole('button', { name: 'Chơi lại từ đầu' }))
    const dlg = await screen.findByRole('alertdialog')
    fireEvent.click(within(dlg).getByRole('button', { name: 'Hủy' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(tableNames()).toEqual(['Cười'])

    fireEvent.click(screen.getByRole('button', { name: '?' }))
    expect(await screen.findByRole('dialog', { name: /Hướng dẫn/ })).toBeTruthy()
  })
})

// ================================================================ AC-GAME-21 (hint part)
describe('ui2: gợi ý cảm ứng (AC-GAME-21)', () => {
  it('AC-GAME-21: thiết bị cảm ứng lần đầu mở thì hiện gợi ý "Giữ món để kéo, vuốt chỗ trống để cuộn"; chuột thì không hiện', async () => {
    setTouch(false)
    seed()
    await mountReady()
    expect(hasText(HINT)).toBe(false)
    cleanup()

    localStorage.clear()
    setTouch(true)
    seed()
    await mountReady()
    await seeText(HINT)
  })

  it('AC-GAME-21: bấm đóng thì gợi ý ẩn và không hiện lại sau khi tải lại trang', async () => {
    setTouch(true)
    seed()
    await mountReady()
    await seeText(HINT)
    const close = screen.getAllByRole('button', { name: /đóng/i })
    expect(close).toHaveLength(1) // hướng dẫn đã xem, chỉ còn nút đóng của gợi ý
    fireEvent.click(close[0]!)
    await waitFor(() => expect(hasText(HINT)).toBe(false))

    await reload()
    await advance(500)
    expect(hasText(HINT)).toBe(false)
  })

  it('AC-GAME-21: kéo thả trượt (thả ra ngoài bàn và nồi) thì gợi ý còn; kéo thả thành công đầu tiên thì gợi ý ẩn và không hiện lại sau khi tải lại', async () => {
    setTouch(true)
    seed()
    await mountReady()
    await seeText(HINT)

    drag(plateItem('Cay'), document.body) // không phải đích thả
    expect(tableNames()).toEqual([])
    expect(hasText(HINT)).toBe(true)

    drag(plateItem('Cay'), tableEl(), { x: 80, y: 90 })
    expect(tableNames()).toEqual(['Cay'])
    await waitFor(() => expect(hasText(HINT)).toBe(false))

    await reload()
    await advance(500)
    expect(hasText(HINT)).toBe(false)
  })
})

// ================================================================ AC-DAILY-16
describe('ui2: thẻ thử thách nổi bật (AC-DAILY-16)', () => {
  it('AC-DAILY-16: chưa giải thì thẻ có nhãn "Thử thách" (không phải nút) trên câu dẫn "Ghép ra món bí ẩn này trên bàn lẩu", kèm emoji, gợi ý và đồng hồ "Mẻ mới sau"', async () => {
    seed()
    await mountReady()
    const c = card()
    const label = within(c).getByText('Thử thách')
    const lead = within(c).getByText('Ghép ra món bí ẩn này trên bàn lẩu')
    expect(label.closest('button')).toBeNull()
    expect(label.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy() // nhãn đứng trước câu dẫn
    expect(c.textContent).toContain('📈')
    expect(within(c).getByText('Món lên như diều gặp gió')).toBeTruthy()
    expect(c.textContent).toMatch(/Mẻ mới sau \d+:\d\d:\d\d/)
    expect(within(c).queryByText('Đã giải')).toBeNull()
  })

  it('AC-DAILY-16: sau khi giải thì nhãn đổi thành "Đã giải", không còn nhãn "Thử thách" và câu dẫn', async () => {
    seed(withIngredient)
    await mountReady()
    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Đã giải')).toBeTruthy())
    expect(within(card()).queryByText('Thử thách')).toBeNull()
    expect(within(card()).queryByText('Ghép ra món bí ẩn này trên bàn lẩu')).toBeNull()
    expect(within(card()).getByText('Stonks')).toBeTruthy()
  })
})

// ================================================================ AC-DAILY-17
describe('ui2: bảng xếp hạng ở tab riêng (AC-DAILY-17)', () => {
  it('AC-DAILY-17: trang có hai tab "Bàn lẩu" (đang chọn) và "Bảng xếp hạng"; thẻ Món đặc biệt không chứa bảng xếp hạng', async () => {
    seed()
    await mountReady()
    expect(tab('Bàn lẩu').getAttribute('aria-selected')).toBe('true')
    expect(tab('Bảng xếp hạng').getAttribute('aria-selected')).toBe('false')
    expect(within(card()).queryByRole('tab')).toBeNull()
    expect(within(card()).queryByText('Mẻ này')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Mẻ này' })).toBeNull()
    expect(within(card()).getByRole('button', { name: 'Xem bảng xếp hạng' })).toBeTruthy()
  })

  it('AC-DAILY-17: nút "Xem bảng xếp hạng" trên thẻ chuyển sang tab "Bảng xếp hạng" với 3 thẻ "Mẻ này", "Tuần", "Tháng"; bảng nằm ngoài thẻ', async () => {
    seed()
    await mountReady()
    fireEvent.click(within(card()).getByRole('button', { name: 'Xem bảng xếp hạng' }))
    await waitFor(() => expect(tab('Bảng xếp hạng').getAttribute('aria-selected')).toBe('true'))
    expect(tab('Bàn lẩu').getAttribute('aria-selected')).toBe('false')
    const inner = await screen.findByRole('tab', { name: 'Mẻ này' })
    expect(inner.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Tuần' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Tháng' })).toBeTruthy()
    expect(card().contains(inner)).toBe(false)
    expect(within(card()).queryByRole('tab')).toBeNull()
  })

  it('AC-DAILY-17: tab "Bảng xếp hạng" ở đầu trang cũng mở bảng; giữ trạng thái AC-DAILY-15: bảng rỗng và dòng nhắc đăng nhập (chưa đăng nhập)', async () => {
    seed()
    await mountReady()
    fireEvent.click(tab('Bảng xếp hạng'))
    await seeText('Chưa có ai giải món này')
    await seeText(BOARD_INVITE)
    fireEvent.click(await screen.findByRole('tab', { name: 'Tuần' }))
    await seeText('Chưa có ai giải món nào trong kỳ')
    expect(hasText(BOARD_INVITE)).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Tháng' }))
    await seeText('Chưa có ai giải món nào trong kỳ')

    act(() => setCurrentSession(SESSION))
    await waitFor(() => expect(hasText(BOARD_INVITE)).toBe(false))
  })

  it('AC-DAILY-17: hạng 1-3 có huy chương 🥇🥈🥉, hạng 4 thì không', async () => {
    batchBoardReply = () =>
      json({
        version: VERSION,
        rows: [
          { rank: 1, nickname: 'Bếp Trưởng', value: 312_000 },
          { rank: 2, nickname: 'Bếp Phó', value: 330_000 },
          { rank: 3, nickname: 'Thực Tập', value: 3_912_000 },
          { rank: 4, nickname: 'Khách Lạ', value: 4_000_000 },
        ],
        me: null,
      })
    seed()
    await mountReady()
    fireEvent.click(tab('Bảng xếp hạng'))
    await waitFor(() => expect(document.body.textContent).toContain('Bếp Trưởng'))
    const r1 = rowOf('Bếp Trưởng', '5 phút 12 giây').textContent ?? ''
    const r2 = rowOf('Bếp Phó', '5 phút 30 giây').textContent ?? ''
    const r3 = rowOf('Thực Tập', '1 giờ 05 phút 12 giây').textContent ?? ''
    const r4 = rowOf('Khách Lạ', '1 giờ 06 phút 40 giây').textContent ?? ''
    expect(r1).toContain('🥇')
    expect(r2).toContain('🥈')
    expect(r3).toContain('🥉')
    expect(r4).not.toMatch(/🥇|🥈|🥉/)
    expect(r1).not.toMatch(/🥈|🥉/)
    expect(r2).not.toMatch(/🥇|🥉/)
    expect(r3).not.toMatch(/🥇|🥈/)
  })

  it('AC-DAILY-17: đã đăng nhập và có tên trong bảng (me.rank) thì chỉ dòng của mình có aria-current="true"; me = null thì không dòng nào', async () => {
    const rows = [
      { rank: 1, nickname: 'Bếp Trưởng', value: 312_000 },
      { rank: 2, nickname: 'Bếp Phó', value: 330_000 },
      { rank: 3, nickname: 'Thực Tập', value: 3_912_000 },
    ]
    batchBoardReply = () => json({ version: VERSION, rows, me: { rank: 2, nickname: 'Bếp Phó', value: 330_000 } })
    seed()
    await mountReady()
    act(() => setCurrentSession(SESSION))
    fireEvent.click(tab('Bảng xếp hạng'))
    await waitFor(() => expect(document.body.textContent).toContain('Bếp Phó'))
    expect(isHighlighted(rowOf('Bếp Phó', '5 phút 30 giây'))).toBe(true)
    expect(isHighlighted(rowOf('Bếp Trưởng', '5 phút 12 giây'))).toBe(false)
    expect(isHighlighted(rowOf('Thực Tập', '1 giờ 05 phút 12 giây'))).toBe(false)

    cleanup()
    batchBoardReply = () => json({ version: VERSION, rows, me: null })
    await mountReady()
    fireEvent.click(tab('Bảng xếp hạng'))
    await waitFor(() => expect(document.body.textContent).toContain('Bếp Phó'))
    expect(document.querySelectorAll('[aria-current="true"]:not([role="tab"])').length).toBe(0)
  })

  it('AC-DAILY-17: quay lại tab "Bàn lẩu" thì món trên bàn và món trong ô nồi giữ nguyên', async () => {
    seed()
    await mountReady()
    drag(plateItem('Cay'), tableEl(), { x: 80, y: 90 })
    drag(plateItem('Cười'), slot(1))
    expect(tableNames()).toEqual(['Cay'])
    expect(slot(1).textContent).toContain('Cười')

    fireEvent.click(within(card()).getByRole('button', { name: 'Xem bảng xếp hạng' }))
    await screen.findByRole('tab', { name: 'Mẻ này' })
    fireEvent.click(tab('Bàn lẩu'))
    await waitFor(() => expect(tab('Bàn lẩu').getAttribute('aria-selected')).toBe('true'))

    expect(tableNames()).toEqual(['Cay'])
    expect(slot(1).textContent).toContain('Cười')
    expect(pot().dataset.state).toBe('idle')
  })
})
