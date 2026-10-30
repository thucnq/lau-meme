// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho giao diện chơi ghép (docs/acceptance/game.md).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU
 *
 * web/src/game/Game.tsx:  export function Game(): JSX.Element     (không props)
 *   - Khi mount: đọc tiến độ từ localStorage (loadProgress) và hiện Đĩa NGAY, trước khi mạng trả lời.
 *   - Tải song song GET manifest (/api/manifest), GET manifest.graph_url, GET /api/blocklist.
 *     Chỉ khi cả ba thành công thì `pot` mới chuyển sang 'idle'. Lỗi mạng hoặc 5xx ở manifest/graph =>
 *     role="alert" + nút "Thử lại" (bấm thì tải lại). Lỗi blocklist coi như danh sách rỗng.
 *   - Mọi yêu cầu ghi (POST/PUT...) KHÔNG được phát sinh khi khôi phục tiến độ (AC-GAME-10).
 *   - Kéo thả bằng Pointer Events (pointerdown trên phần tử nguồn; pointermove/pointerup bắt ở
 *     element nguồn hoặc document/window). Đích thả được xác định bằng
 *     document.elementFromPoint(clientX, clientY) (test stub hàm này). Phải bọc setPointerCapture
 *     bằng kiểm tra tồn tại (jsdom không có).
 *   - Lưu tiến độ bằng engine.saveProgress(localStorage, ...) mỗi khi đổi.
 *
 * DOM hợp đồng (data-testid / role):
 *   Đĩa nhúng      role="list" aria-label="Đĩa nhúng"; mỗi mục data-testid="plate-item" data-name="<tên>"
 *                  chứa chữ "MỚI" nếu engine.isNew
 *   Ô tìm          role="searchbox" aria-label="Tìm trong Đĩa nhúng"
 *   Sắp xếp        <select> aria-label="Sắp xếp", value 'newest' | 'name' | 'depth'
 *                  (nhãn: "Mới khám phá", "Tên", "Độ sâu")
 *   Bàn            data-testid="table"; mỗi mục data-testid="table-item" data-name data-x data-y (số, px)
 *                  chứa chữ "MỚI" nếu engine.isNew
 *   Nồi            data-testid="pot", data-state = 'disabled' (chưa tải xong / lỗi) | 'idle' | 'boiling' (<= 1,2 s)
 *   Chỗ thả        data-testid="pot-slot-1" và "pot-slot-2"; khi có phần tử thì chứa tên của nó
 *   Hơi lẩu        data-testid="stack-steam" tồn tại tối đa 0,6 s sau khi thả chồng trên bàn
 *   Nồi trào       data-testid="miss-line" (câu), data-testid="miss-hint" (chỉ khi có gợi ý)
 *   Nút            "Dọn bàn", "?", "Thử lại", "Chuyển chế độ" (aria-label/ tên chứa cụm này).
 *                  KHÔNG có nút/menu "Chơi lại từ đầu" ở đâu cả (AC-GAME-11, cập nhật 2026-10-24).
 *   Hướng dẫn      role="dialog" có tên chứa "Hướng dẫn", nút "Đóng"; chứa chữ "kéo"
 *   Chế độ tối     document.documentElement.dataset.theme = 'dark' | 'light'; lựa chọn lưu ở THEME_KEY
 *
 * Phụ thuộc engine.ts: PROGRESS_KEY, THEME_KEY, initialProgress, loadProgress, saveProgress (xem engine.test.ts).
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentSession } from '../auth/session'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { PROGRESS_KEY, THEME_KEY, initialProgress, loadProgress, saveProgress } from './engine'
import type { Item, Manifest, Progress } from './engine'
import { Game } from './Game'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url')
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))

interface Spec {
  a: string
  b: string
  name: string
  emoji?: string
  depth?: number
  added_version?: number
}

async function buildGraph(version: number, specs: Spec[]): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of specs) {
    const plain: GraphResult = {
      added_version: s.added_version ?? version,
      depth: s.depth ?? 1,
      emoji: s.emoji ?? '🍲',
      id: eid(s.name),
      image_key: null,
      name: s.name,
    }
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
    const ct = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) },
      aes,
      enc.encode(JSON.stringify(plain)),
    )
    entries[key] = b64u(new Uint8Array(ct))
  }
  return { format: 1, version, entries }
}

const T0 = new Date('2026-10-20T03:00:00.000Z')
const STARTER_NAMES = ['Cay', 'Cười', 'Toang', 'Deadline']
const MISS_LINES = Array.from({ length: 30 }, (_, i) => `Nồi trào kiểu ${i}, khét rồi!`)

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
    miss_lines: MISS_LINES,
    daily: { element_id: eid('Tới Công Chuyện'), emoji: '🍜', hint: 'gợi ý', depth: 4 },
    policy_version: 1,
  } as Manifest
}

function item(name: string, emoji: string, depth: number, added_version: number, discovered_at: string): Item {
  return { id: eid(name), name, emoji, depth, added_version, image_key: null, discovered_at }
}

// ---------------------------------------------------------------- mạng giả
interface Net {
  manifest: () => Response | Promise<Response>
  graph: () => Response | Promise<Response>
  blocklist: () => Response | Promise<Response>
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  })

let net: Net
let fetchMock: ReturnType<typeof vi.fn>

async function installNet(opts: { version?: number; specs?: Spec[]; blocklist?: object } = {}): Promise<void> {
  const version = opts.version ?? 7
  const manifest = manifestOf(version)
  const graph = await buildGraph(version, opts.specs ?? [])
  net = {
    manifest: () => json(manifest),
    graph: () => json(graph),
    blocklist: () => json(opts.blocklist ?? { elements: [], recipes: [], images: [] }),
  }
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/manifest')) return net.manifest()
    if (url.includes('/graph/')) return net.graph()
    if (url.includes('/blocklist')) return net.blocklist()
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

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

// ---------------------------------------------------------------- truy vấn DOM
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

async function mount(): Promise<void> {
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
}

async function mountReady(): Promise<void> {
  await mount()
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

function seed(mutate: (p: Progress) => void = () => {}, version = 7, seen = true): Progress {
  const p = initialProgress(manifestOf(version), T0)
  p.tutorial_seen = seen
  mutate(p)
  saveProgress(localStorage, p)
  return p
}

function nonGetCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((c) => {
    const init = c[1] as RequestInit | undefined
    const req = c[0] as Request | string | URL
    const method = (init?.method ?? (typeof req === 'object' && 'method' in req ? req.method : 'GET')).toUpperCase()
    return method !== 'GET'
  })
}

const alertDialog = (): HTMLElement | null => screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog')

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  dropTarget = null
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () =>
    dropTarget ? [dropTarget] : []
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ AC-GAME-01
describe('Game', () => {
  it('AC-GAME-01: lần đầu Đĩa có đúng 4 phần tử khởi đầu từ manifest, nồi có 2 chỗ thả trống', async () => {
    await installNet()
    await mountReady()
    const close = screen.queryByRole('button', { name: 'Đóng' })
    if (close) fireEvent.click(close)

    expect(plateNames()).toEqual(expect.arrayContaining(STARTER_NAMES))
    expect(plateItems()).toHaveLength(4)
    expect(within(plateItem('Cay')).getByText(/🌶️/)).toBeTruthy()
    expect(within(plateItem('Cười')).getByText(/😂/)).toBeTruthy()
    expect(within(plateItem('Toang')).getByText(/💀/)).toBeTruthy()
    expect(within(plateItem('Deadline')).getByText(/⏰/)).toBeTruthy()
    expect(slot(1)).toBeTruthy()
    expect(slot(2)).toBeTruthy()
    for (const n of STARTER_NAMES) {
      expect(slot(1).textContent).not.toContain(n)
      expect(slot(2).textContent).not.toContain(n)
    }
    expect(tableItems()).toHaveLength(0)
  })

  // ============================================================== AC-GAME-02
  it('AC-GAME-02: thả A và B vào nồi - nồi sôi tối đa 1,2 s, bỏ qua thao tác lúc sôi, C lên bàn và vào Đĩa', async () => {
    await installNet({ specs: [{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' }] })
    seed()
    await mountReady()

    drag(plateItem('Cay'), slot(1))
    expect(slot(1).textContent).toContain('Cay')
    drag(plateItem('Cười'), slot(2))
    await waitFor(() => expect(pot().dataset.state).toBe('boiling'))

    // Trong lúc sôi: thao tác bị bỏ qua ngay
    drag(plateItem('Toang'), slot(1))
    expect(slot(1).textContent).not.toContain('Toang')
    expect(tableItems()).toHaveLength(0)

    await advance(1200)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    expect(tableNames()).toContain('Tới Công Chuyện')
    expect(plateNames()).toContain('Tới Công Chuyện')
    expect(slot(1).textContent).not.toMatch(/Cay|Cười|Toang/)
    expect(slot(2).textContent).not.toMatch(/Cay|Cười|Toang/)

    const saved = loadProgress(localStorage)!.items.find((i) => i.name === 'Tới Công Chuyện')!
    const at = Date.parse(saved.discovered_at)
    expect(at).toBeGreaterThanOrEqual(T0.getTime())
    expect(at).toBeLessThanOrEqual(T0.getTime() + 5000)
  })

  // ============================================================== AC-GAME-03
  it('AC-GAME-03: kéo A thả chồng lên B trên bàn thì thay bằng C tại vị trí của B, hơi lẩu <= 0,6 s', async () => {
    await installNet({ specs: [{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' }] })
    seed()
    await mountReady()

    drag(plateItem('Cay'), tableEl(), { x: 80, y: 90 })
    drag(plateItem('Cười'), tableEl(), { x: 300, y: 210 })
    expect(tableNames().sort()).toEqual(['Cay', 'Cười'])
    const bx = tableItem('Cười').dataset.x
    const by = tableItem('Cười').dataset.y

    drag(tableItem('Cay'), tableItem('Cười'), { x: 300, y: 210 })
    await waitFor(() => expect(tableNames()).toEqual(['Tới Công Chuyện']))
    expect(tableItem('Tới Công Chuyện').dataset.x).toBe(bx)
    expect(tableItem('Tới Công Chuyện').dataset.y).toBe(by)
    expect(plateNames()).toContain('Tới Công Chuyện')
    expect(screen.queryByTestId('stack-steam')).not.toBeNull()
    await advance(600)
    expect(screen.queryByTestId('stack-steam')).toBeNull()
    expect(tableNames()).toEqual(['Tới Công Chuyện'])
  })

  // ============================================================== AC-GAME-04
  it('AC-GAME-04: ghép ra phần tử đã có thì C hiện trên bàn nhưng Đĩa không trùng, thời điểm cũ giữ nguyên', async () => {
    await installNet({ specs: [{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' }] })
    const old = '2026-09-01T10:00:00.000Z'
    seed((p) => p.items.push(item('Tới Công Chuyện', '🔥', 1, 7, old)))
    await mountReady()

    await potCombine('Cười', 'Cay') // thứ tự ngược
    expect(tableNames()).toContain('Tới Công Chuyện')
    expect(plateNames().filter((n) => n === 'Tới Công Chuyện')).toHaveLength(1)
    const saved = loadProgress(localStorage)!.items.filter((i) => i.name === 'Tới Công Chuyện')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.discovered_at).toBe(old)
  })

  // ============================================================== AC-GAME-05
  it('AC-GAME-05: cùng một câu Nồi trào cho (A,B), (B,A) và sau khi tải lại; A và B trở lại bàn', async () => {
    await installNet({ specs: [{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện' }] })
    // Tới Công Chuyện đã có trong Đĩa: không còn công thức chưa khám phá, nên lần trượt thứ 3 liên tiếp
    // vẫn hiện câu Nồi trào (AC-GAME-06) và AC-GAME-05 kiểm tra được cả 3 lần.
    seed((p) => p.items.push(item('Tới Công Chuyện', '🍲', 1, 7, '2026-10-01T00:00:00.000Z')))
    await mountReady()

    await potCombine('Cay', 'Deadline')
    const l1 = (await screen.findByTestId('miss-line')).textContent ?? ''
    expect(MISS_LINES.some((m) => l1.includes(m))).toBe(true)
    expect(tableNames()).toEqual(expect.arrayContaining(['Cay', 'Deadline']))
    expect(plateItems()).toHaveLength(5) // 4 phần tử khởi đầu + Tới Công Chuyện đã seed; trượt không thêm gì

    cleanup()
    await mountReady()
    await potCombine('Deadline', 'Cay')
    const l2 = (await screen.findByTestId('miss-line')).textContent ?? ''

    await reload()
    await potCombine('Cay', 'Deadline')
    const l3 = (await screen.findByTestId('miss-line')).textContent ?? ''

    expect(l2).toBe(l1)
    expect(l3).toBe(l1)
  })

  // ============================================================== AC-GAME-06
  // Hợp đồng DOM của AC-GAME-06 (cập nhật 2026-10-30): thẻ A và B (cả data-testid="table-item" và
  // "plate-item") có thuộc tính data-hint-glow="pulse" (nháy chậm) hoặc "static" (prefers-reduced-motion: reduce,
  // chỉ viền sáng). Thẻ không thuộc gợi ý thì KHÔNG có thuộc tính này. Dòng gợi ý vẫn là data-testid="miss-hint".
  const glowing = (els: HTMLElement[]): string[] =>
    els.filter((e) => e.hasAttribute('data-hint-glow')).map((e) => e.dataset.name ?? '').sort()

  // Tiến độ lưu không được chứa gợi ý cặp hay glow; trường hợp lệ `touch_hint_seen` (AC-GAME-21) được bỏ qua.
  function expectNoPairHintStored(raw: string): void {
    expect(raw).not.toMatch(/glow|Thử|hint_pair/i)
    const stored = JSON.parse(raw) as Record<string, unknown>
    const bad = Object.keys(stored).filter((k) => k !== 'touch_hint_seen' && /hint|glow/i.test(k))
    expect(bad).toEqual([])
  }

  async function reachHint(): Promise<{ line: string }> {
    await installNet({
      specs: [
        { a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' },
        { a: 'Toang', b: 'Cười', name: 'Lẩu Thần Sầu', emoji: '🥘' },
      ],
    })
    // Toang đã nằm sẵn trên bàn (để thấy nháy ở cả bàn lẫn Đĩa); Cười chỉ ở Đĩa
    seed((p) => {
      p.items.push(item('Tới Công Chuyện', '🔥', 1, 7, '2026-10-01T00:00:00.000Z'))
      p.table = [{ uid: 't1', id: eid('Toang'), name: 'Toang', emoji: '💀', x: 40, y: 50 }]
    })
    await mountReady()

    await potCombine('Cay', 'Deadline')
    const line = (await screen.findByTestId('miss-line')).textContent ?? ''
    expect(screen.queryByTestId('miss-hint')).toBeNull()
    expect(glowing([...plateItems(), ...tableItems()])).toEqual([])
    await potCombine('Cay', 'Deadline')
    expect(screen.queryByTestId('miss-hint')).toBeNull()
    expect(glowing([...plateItems(), ...tableItems()])).toEqual([])
    await potCombine('Cay', 'Deadline')
    return { line }
  }

  it('AC-GAME-06: lần trượt thứ 3 hiện gợi ý cặp "Thử <emoji A> <tên A> + <emoji B> <tên B> xem" thay câu Nồi trào, không lộ kết quả', async () => {
    const { line } = await reachHint()
    const hint = ((await screen.findByTestId('miss-hint')).textContent ?? '').trim()
    expect(['Thử 💀 Toang + 😂 Cười xem', 'Thử 😂 Cười + 💀 Toang xem']).toContain(hint)
    expect(hint).not.toContain('Lẩu Thần Sầu')
    expect(hint).not.toContain('🥘')
    // lần 3 chỉ hiện gợi ý, thay cho câu Nồi trào
    expect(screen.queryByTestId('miss-line')).toBeNull()
    expect(line).not.toBe('')
  })

  it('AC-GAME-06: thẻ A và B nháy sáng ở mọi chỗ đang hiện (bàn và Đĩa nhúng), thẻ khác không nháy', async () => {
    await reachHint()
    await screen.findByTestId('miss-hint')
    expect(glowing(plateItems())).toEqual(['Cười', 'Toang'])
    expect(glowing(tableItems())).toEqual(['Toang'])
    expect(plateItem('Toang').dataset.hintGlow).toBe('pulse')
    expect(plateItem('Cười').dataset.hintGlow).toBe('pulse')
    expect(tableItem('Toang').dataset.hintGlow).toBe('pulse')
    expect(plateItem('Cay').hasAttribute('data-hint-glow')).toBe(false)
    expect(plateItem('Deadline').hasAttribute('data-hint-glow')).toBe(false)
    // thẻ A/B xuất hiện trên bàn sau đó cũng nháy
    drag(plateItem('Cười'), tableEl(), { x: 260, y: 180 })
    expect(glowing(tableItems())).toEqual(['Cười', 'Toang'])
  })

  it('AC-GAME-06: dòng gợi ý và hiệu ứng nháy không tự ẩn theo thời gian', async () => {
    await reachHint()
    await screen.findByTestId('miss-hint')
    await advance(60000)
    expect(screen.queryByTestId('miss-line')).toBeNull()
    expect(screen.queryByTestId('miss-hint')).not.toBeNull()
    expect(glowing(plateItems())).toEqual(['Cười', 'Toang'])
    expect(glowing(tableItems())).toEqual(['Toang'])
  })

  it('AC-GAME-06: ghép trượt tiếp theo tắt dòng gợi ý và hiệu ứng nháy', async () => {
    await reachHint()
    await screen.findByTestId('miss-hint')
    await potCombine('Cay', 'Deadline') // trượt thứ 1 của chuỗi mới
    await screen.findByTestId('miss-line')
    expect(screen.queryByTestId('miss-hint')).toBeNull()
    expect(glowing([...plateItems(), ...tableItems()])).toEqual([])
  })

  it('AC-GAME-06: ghép thành công tắt dòng gợi ý và hiệu ứng nháy', async () => {
    await reachHint()
    await screen.findByTestId('miss-hint')
    await potCombine('Cay', 'Cười')
    expect(tableNames()).toContain('Tới Công Chuyện')
    expect(screen.queryByTestId('miss-hint')).toBeNull()
    expect(glowing([...plateItems(), ...tableItems()])).toEqual([])
  })

  it('AC-GAME-06: gợi ý không lưu vào tiến độ cục bộ, tải lại trang thì không còn gợi ý hay nháy', async () => {
    await reachHint()
    await screen.findByTestId('miss-hint')
    const raw = localStorage.getItem(PROGRESS_KEY) ?? ''
    expectNoPairHintStored(raw)
    expect(loadProgress(localStorage)!.miss_streak).toBe(0)

    await reload()
    expect(screen.queryByTestId('miss-hint')).toBeNull()
    expect(glowing([...plateItems(), ...tableItems()])).toEqual([])
    expectNoPairHintStored(localStorage.getItem(PROGRESS_KEY) ?? '')
  })

  it('AC-GAME-06: bật giảm chuyển động (prefers-reduced-motion) thì thẻ chỉ có viền sáng tĩnh (data-hint-glow="static")', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q.includes('prefers-reduced-motion'),
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    })
    await reachHint()
    await screen.findByTestId('miss-hint')
    expect(glowing(plateItems())).toEqual(['Cười', 'Toang'])
    for (const e of [plateItem('Toang'), plateItem('Cười'), tableItem('Toang')]) {
      expect(e.dataset.hintGlow).toBe('static')
    }
  })

  it('AC-GAME-06: không còn công thức chưa khám phá thì sau 3 lần trượt không có gợi ý và không thẻ nào nháy', async () => {
    await installNet({ specs: [{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' }] })
    seed((p) => p.items.push(item('Tới Công Chuyện', '🔥', 1, 7, '2026-10-01T00:00:00.000Z')))
    await mountReady()
    for (let i = 0; i < 3; i++) await potCombine('Cay', 'Deadline')
    // lần 3 không có cặp hợp lệ: câu Nồi trào như thường
    expect(await screen.findByTestId('miss-line')).toBeTruthy()
    expect(screen.queryByTestId('miss-hint')).toBeNull()
    expect(glowing([...plateItems(), ...tableItems()])).toEqual([])
  })

  // ============================================================== AC-GAME-07
  it('AC-GAME-07: gõ "ca phe" (không dấu, hoa/thường, nhiều khoảng trắng) chỉ hiện Cà Phê Sữa Đá', async () => {
    await installNet()
    seed((p) => {
      p.items.push(item('Cà Phê Sữa Đá', '☕', 3, 1, '2026-10-02T00:00:00.000Z'))
      p.items.push(item('Cà Khịa', '😏', 2, 1, '2026-10-03T00:00:00.000Z'))
    })
    await mountReady()
    const box = screen.getByRole('searchbox', { name: 'Tìm trong Đĩa nhúng' })
    for (const q of ['ca phe', 'CÀ PHÊ', '  ca   phe ']) {
      fireEvent.change(box, { target: { value: q } })
      expect(plateNames()).toEqual(['Cà Phê Sữa Đá'])
    }
    fireEvent.change(box, { target: { value: '' } })
    expect(plateItems()).toHaveLength(6)
  })

  // ============================================================== AC-GAME-08
  it('AC-GAME-08: sắp xếp Mới khám phá / Tên / Độ sâu và nhớ lựa chọn sau khi tải lại', async () => {
    await installNet()
    const custom = ['Cá Chép', 'Bún Bò', 'Cà Phê', 'Ăn Vặt']
    seed((p) => {
      p.items.push(item('Cá Chép', '🐟', 1, 1, '2026-10-05T00:00:00.000Z'))
      p.items.push(item('Bún Bò', '🍜', 2, 1, '2026-10-04T00:00:00.000Z'))
      p.items.push(item('Cà Phê', '☕', 3, 1, '2026-10-03T00:00:00.000Z'))
      p.items.push(item('Ăn Vặt', '🍢', 2, 1, '2026-10-02T00:00:00.000Z'))
    })
    await mountReady()
    const order = (): string[] => plateNames().filter((n) => custom.includes(n))
    const select = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Sắp xếp' }) as HTMLSelectElement

    fireEvent.change(select(), { target: { value: 'newest' } })
    expect(order()).toEqual(['Cá Chép', 'Bún Bò', 'Cà Phê', 'Ăn Vặt'])
    fireEvent.change(select(), { target: { value: 'name' } })
    expect(order()).toEqual(['Ăn Vặt', 'Bún Bò', 'Cá Chép', 'Cà Phê'])
    fireEvent.change(select(), { target: { value: 'depth' } })
    expect(order()).toEqual(['Cá Chép', 'Ăn Vặt', 'Bún Bò', 'Cà Phê'])

    await reload()
    expect(select().value).toBe('depth')
    expect(order()).toEqual(['Cá Chép', 'Ăn Vặt', 'Bún Bò', 'Cà Phê'])
  })

  // ============================================================== AC-GAME-09
  it('AC-GAME-09: chỉ phần tử thêm ở mẻ hiện tại có nhãn MỚI (ở Đĩa và trên bàn)', async () => {
    await installNet()
    const c = item('Món Mới', '🆕', 2, 7, '2026-10-20T00:00:00.000Z')
    seed((p) => {
      p.items.push(c)
      p.items.push(item('Món Cũ', '📜', 2, 6, '2026-10-19T00:00:00.000Z'))
      p.table = [{ uid: 't1', id: c.id, name: c.name, emoji: c.emoji, x: 40, y: 50 }]
    })
    await mountReady()
    expect(within(plateItem('Món Mới')).getByText('MỚI')).toBeTruthy()
    expect(within(plateItem('Món Cũ')).queryByText('MỚI')).toBeNull()
    expect(within(plateItem('Cay')).queryByText('MỚI')).toBeNull()
    expect(within(tableItem('Món Mới')).getByText('MỚI')).toBeTruthy()
  })

  // ============================================================== AC-GAME-10
  it('AC-GAME-10: tải lại khôi phục Đĩa, vị trí trên bàn, sắp xếp, đã xem hướng dẫn; không gọi API ghi', async () => {
    await installNet({ specs: [{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥' }] })
    await mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Đóng' })) // hướng dẫn lần đầu
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))

    await potCombine('Cay', 'Cười')
    drag(plateItem('Toang'), tableEl(), { x: 220, y: 140 })
    fireEvent.change(screen.getByRole('combobox', { name: 'Sắp xếp' }), { target: { value: 'name' } })
    const before = tableItems().map((e) => [e.dataset.name, e.dataset.x, e.dataset.y])
    const plateBefore = plateNames()
    expect(before.length).toBeGreaterThanOrEqual(2)

    await reload()
    expect(tableItems().map((e) => [e.dataset.name, e.dataset.x, e.dataset.y])).toEqual(before)
    expect(plateNames()).toEqual(plateBefore)
    expect((screen.getByRole('combobox', { name: 'Sắp xếp' }) as HTMLSelectElement).value).toBe('name')
    expect(screen.queryByRole('dialog')).toBeNull() // đã xem hướng dẫn
    expect(nonGetCalls()).toEqual([])
  })

  // ============================================================== AC-GAME-11
  it('AC-GAME-11: không còn nút/menu "Chơi lại từ đầu" (chưa và đã đăng nhập); Dọn bàn chỉ xóa bàn, giữ Đĩa, UUID, nickname, Daily', async () => {
    await installNet()
    type SessionArg = Parameters<typeof setCurrentSession>[0]
    const session = { nickname: 'Lẩu Thủ', created_at: '2026-10-20T02:00:00.000Z' } as unknown as SessionArg
    const NO_RESET = /chơi lại từ đầu/i
    const expectNoReset = (when: string): void => {
      for (const role of ['button', 'menuitem', 'link'] as const) {
        expect(screen.queryAllByRole(role, { name: NO_RESET }), `${when}: còn ${role} "Chơi lại từ đầu"`).toHaveLength(0)
      }
      expect(document.body.textContent ?? '', `${when}: còn chữ "Chơi lại từ đầu"`).not.toMatch(NO_RESET)
      expect(alertDialog(), `${when}: không được có hộp xác nhận xóa Đĩa`).toBeNull()
    }
    const keep: Record<string, string> = {
      'lm.player_id': '3f0a7f0e-2f52-4c7a-9f5f-0c2b1a1d9e11',
      'lm.nickname': 'Thực khách',
      'lm.daily.7': '{"steps":9}',
      'lm.streak': '{"current":3}',
    }
    seed((p) => {
      for (let i = 0; i < 3; i++) p.items.push(item(`Món ${i}`, '🍲', 1, 7, '2026-10-20T01:00:00.000Z'))
      p.table = [
        { uid: 't1', id: eid('Cay'), name: 'Cay', emoji: '🌶️', x: 10, y: 20 },
        { uid: 't2', id: eid('Món 0'), name: 'Món 0', emoji: '🍲', x: 60, y: 70 },
      ]
    })
    for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v)
    await mountReady()
    expect(plateItems()).toHaveLength(7)
    expect(tableItems()).toHaveLength(2)

    const plateBefore = plateNames()
    expectNoReset('chưa đăng nhập, trước khi dọn')

    fireEvent.click(screen.getByRole('button', { name: 'Dọn bàn' }))
    await waitFor(() => expect(tableItems()).toHaveLength(0))
    expect(plateNames()).toEqual(plateBefore)
    expectNoReset('chưa đăng nhập, sau khi dọn')
    const stored = loadProgress(localStorage)
    expect(stored).not.toBeNull()
    expect(stored!.items).toHaveLength(7)
    expect(stored!.table).toHaveLength(0)
    for (const [k, v] of Object.entries(keep)) expect(localStorage.getItem(k)).toBe(v)

    // đã đăng nhập: vẫn không có cách nào xóa Đĩa
    // (cơ chế như ui2.ui.test.tsx: điểm cuối phiên trả về phiên, rồi tải lại để AuthBar đọc)
    const plainFetch = fetchMock as unknown as typeof fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (url.endsWith('/api/auth/session') && method === 'GET') return json(session)
        return plainFetch(input, init)
      }),
    )
    try {
      cleanup()
      await mountReady()
      await waitFor(() => expect(document.body.textContent).toContain('Lẩu Thủ'))
      expectNoReset('đã đăng nhập')
      drag(plateItem('Cay'), tableEl(), { x: 80, y: 90 })
      expect(tableNames()).toEqual(['Cay'])
      fireEvent.click(screen.getByRole('button', { name: 'Dọn bàn' }))
      await waitFor(() => expect(tableItems()).toHaveLength(0))
      expect(plateNames()).toEqual(plateBefore)
      expectNoReset('đã đăng nhập, sau khi dọn')
      for (const [k, v] of Object.entries(keep)) expect(localStorage.getItem(k)).toBe(v)
    } finally {
      act(() => setCurrentSession(null))
      vi.stubGlobal('fetch', plainFetch)
    }

    await reload()
    expect(plateNames()).toEqual(plateBefore)
    expectNoReset('sau khi tải lại')
  })

  // ============================================================== AC-GAME-12
  it('AC-GAME-12: hướng dẫn hiện lần đầu, không hiện lại sau khi đóng, nút "?" mở lại', async () => {
    await installNet()
    await mountReady()
    const dlg = await screen.findByRole('dialog', { name: /hướng dẫn/i })
    expect(dlg.textContent?.toLowerCase()).toContain('kéo')
    fireEvent.click(within(dlg).getByRole('button', { name: 'Đóng' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await reload()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '?' }))
    expect(await screen.findByRole('dialog', { name: /hướng dẫn/i })).toBeTruthy()
  })

  // ============================================================== AC-GAME-13
  it('AC-GAME-13: theo hệ thống tối khi chưa chọn; nút chuyển sang sáng và được nhớ, ưu tiên hơn hệ thống', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q.includes('prefers-color-scheme: dark'),
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    })
    await installNet()
    seed()
    await mountReady()
    expect(document.documentElement.dataset.theme).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: /chuyển chế độ/i }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')

    await reload()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  // ============================================================== AC-GAME-14 (UI không gọi mạng khi ghép)
  it('AC-GAME-14: ghép trên giao diện chỉ tra bộ nhớ, không phát thêm yêu cầu mạng nào', async () => {
    await installNet({ specs: [{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện' }] })
    seed()
    await mountReady()
    fetchMock.mockClear()
    await potCombine('Cay', 'Cười')
    await potCombine('Cay', 'Deadline')
    const lookups = fetchMock.mock.calls.filter((c) => /\/(manifest|graph|blocklist)/.test(String(c[0])))
    expect(lookups).toEqual([])
  })

  // ============================================================== AC-GAME-15
  it('AC-GAME-15: phần tử bị chặn không hiện ở Đĩa/bàn nhưng còn trong lưu trữ; ghép ra nó là trượt', async () => {
    const e = item('Món Cấm', '🚫', 2, 5, '2026-10-10T00:00:00.000Z')
    await installNet({
      specs: [{ a: 'Cay', b: 'Cười', name: 'Món Cấm' }],
      blocklist: { elements: [e.id], recipes: [], images: [] },
    })
    seed((p) => {
      p.items.push(e)
      p.table = [{ uid: 't1', id: e.id, name: e.name, emoji: e.emoji, x: 10, y: 10 }]
    })
    await mountReady()
    expect(plateNames()).not.toContain('Món Cấm')
    expect(tableNames()).not.toContain('Món Cấm')
    expect(loadProgress(localStorage)!.items.map((i) => i.id)).toContain(e.id)

    await potCombine('Cay', 'Cười')
    expect(await screen.findByTestId('miss-line')).toBeTruthy()
    expect(tableNames()).not.toContain('Món Cấm')
    expect(plateNames()).not.toContain('Món Cấm')
    expect(tableNames()).toEqual(expect.arrayContaining(['Cay', 'Cười']))
  })

  // ============================================================== AC-GAME-16
  describe.each([
    ['manifest trả 503', (n: Net) => (n.manifest = () => json({ type: 'about:blank', title: 'Chưa có mẻ', status: 503 }, 503))],
    ['manifest lỗi mạng', (n: Net) => (n.manifest = () => Promise.reject(new TypeError('Failed to fetch')))],
    ['graph trả 500', (n: Net) => (n.graph = () => json({ type: 'about:blank', title: 'Lỗi', status: 500 }, 500))],
    ['graph lỗi mạng', (n: Net) => (n.graph = () => Promise.reject(new TypeError('Failed to fetch')))],
  ])('lỗi tải: %s', (label, breakIt) => {
    it(`AC-GAME-16: ${label} -> role=alert + "Thử lại", Đĩa từ lưu trữ cục bộ, tiến độ còn, ghép bị vô hiệu`, async () => {
      await installNet({ specs: [{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện' }] })
      seed((p) => p.items.push(item('Món Riêng', '🍲', 1, 6, '2026-10-19T00:00:00.000Z')))
      const raw = localStorage.getItem(PROGRESS_KEY)
      const good = { ...net }
      breakIt(net)

      await mount()
      expect(await screen.findByRole('alert')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy()
      expect(plateNames()).toContain('Món Riêng')
      expect(plateNames()).toEqual(expect.arrayContaining(STARTER_NAMES))
      expect(localStorage.getItem(PROGRESS_KEY)).toBe(raw)
      expect(pot().dataset.state).toBe('disabled')

      drag(plateItem('Cay'), slot(1))
      drag(plateItem('Cười'), slot(2))
      await advance(1500)
      expect(pot().dataset.state).toBe('disabled')
      expect(plateNames()).not.toContain('Tới Công Chuyện')
      expect(localStorage.getItem(PROGRESS_KEY)).toBe(raw)

      Object.assign(net, good)
      fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      await waitFor(() => expect(pot().dataset.state).toBe('idle'))
      expect(plateNames()).toContain('Món Riêng')
    })
  })

  // ============================================================== AC-GAME-17
  it('AC-GAME-17: tiến độ của V1 khi manifest là V2 - giữ mọi phần tử, tra theo graph V2, không hỏi gì', async () => {
    await installNet({
      version: 2,
      specs: [{ a: 'Cay', b: 'Cười', name: 'Món Mới', emoji: '🆕', added_version: 2 }],
    })
    seed((p) => {
      p.items.push(item('Món Cũ', '📜', 1, 1, '2026-09-01T00:00:00.000Z'))
      p.items.push(item('Món Hai', '2️⃣', 2, 1, '2026-09-02T00:00:00.000Z'))
    }, 1)
    await mountReady()
    expect(plateNames()).toEqual(expect.arrayContaining(['Món Cũ', 'Món Hai', ...STARTER_NAMES]))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(alertDialog()).toBeNull()

    await potCombine('Cay', 'Cười')
    expect(tableNames()).toContain('Món Mới')
    expect(plateNames()).toEqual(expect.arrayContaining(['Món Cũ', 'Món Hai', 'Món Mới']))
    expect(loadProgress(localStorage)!.graph_version).toBe(2)
    expect(alertDialog()).toBeNull()
  })
})
