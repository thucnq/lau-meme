// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/sync.md, phần web (Đĩa nhúng theo tài khoản): AC-SYNC-01..10.
 * Hộp đen qua <Game />; mạng là fetch giả (cùng cách dựng graph mã hóa thật như Game.test.tsx).
 *
 * Phủ gì:
 *   AC-SYNC-01  ghép ra món mới khi đã đăng nhập: POST me/plate {a, b, result} chạy nền, game không chờ; Đĩa cục bộ cập nhật ngay
 *   AC-SYNC-02  mở trang kéo Đĩa tổng hợp của server (giải id bằng cách ghép lại trong graph, kể cả khi server trả sai thứ tự);
 *               thời điểm khám phá = sớm nhất; sắp xếp, nhãn MỚI, tìm kiếm chạy trên Đĩa tổng hợp; vị trí bàn không đồng bộ
 *   AC-SYNC-03  đăng nhập (null -> có phiên) gộp phần tử cục bộ có cặp lên server qua me/plate/merge; phần tử thiếu cặp ở lại cục bộ
 *   AC-SYNC-04  404/422 thì món chỉ ở cục bộ, không báo lỗi, không gửi lại
 *   AC-SYNC-05  chưa đăng nhập / chưa đồng ý play / 401 / đăng xuất: không gọi me/plate hoặc dừng đồng bộ, vẫn chơi cục bộ
 *   AC-SYNC-06  lỗi mạng hoặc 5xx: không hiện lỗi chặn, gửi bù ở lần ghép sau hoặc lần tải lại sau, không gửi trùng khi đã nhận 200
 *   AC-SYNC-07  "Dọn bàn" không gửi request nào tới me/plate, Đĩa giữ nguyên; không có nút xóa Đĩa/Chơi lại từ đầu
 *   AC-SYNC-08  phần tử bị chặn ẩn nhưng giữ; bỏ chặn thì hiện lại không cần ghép; đổi version graph không làm mất phần tử
 *   AC-SYNC-09  gộp chia lô <= 500; 429 + Retry-After được tôn trọng rồi gửi bù
 *   AC-SYNC-10  trang chính sách nêu dữ liệu, mục đích và thời hạn của Đĩa theo tài khoản
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (ngoài những gì Game.test.tsx đã yêu cầu)
 *   engine.ts  Item có thêm trường tùy chọn `pair?: [string, string]` = hai tên đầu vào đã dùng lần đầu máy này ghép ra nó.
 *              Item không có `pair` (tiến độ cũ, 4 món khởi đầu) không bao giờ được gửi.
 *   Game       khi có phiên (lúc mount hoặc khi setCurrentSession đổi từ null sang có phiên) VÀ đã đồng ý play cho
 *              manifest.policy_version: GET api/me/plate, hợp với Đĩa cục bộ (món server có mà cục bộ chưa có được giải ra
 *              bằng cách ghép lại trong graph hiện hành từ các món Đĩa đã có, lặp tới khi hết tiến triển), rồi gửi các món
 *              cục bộ có `pair` mà server thiếu bằng POST api/me/plate/merge (lô <= 500). Món mới ghép ra: cập nhật cục bộ
 *              ngay rồi POST api/me/plate chạy nền. Lỗi mạng/5xx/429: không hiện lỗi, gửi bù (merge) ở lần ghép mới kế tiếp
 *              hoặc lần mount kế tiếp; 429 tôn trọng Retry-After; 401: ngừng đồng bộ; 404/422: món chỉ ở cục bộ.
 *              Mọi yêu cầu mang header X-Player-Id.
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentSession } from '../auth/session'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { PolicyPage } from '../privacy/PolicyPage'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { initialProgress, loadProgress, saveProgress } from './engine'
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
const POLICY = 1

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
    policy_version: POLICY,
  } as Manifest
}

function item(name: string, emoji: string, depth: number, added_version: number, discovered_at: string): Item {
  return { id: eid(name), name, emoji, depth, added_version, image_key: null, discovered_at }
}
const withPair = (i: Item, pair: [string, string]): Item => ({ ...i, pair })

// Tên theo tiêu chí: C = Cay + Cười, D = C + Deadline, E/J = Toang + Deadline.
const NAME_C = 'Tới Công Chuyện'
const NAME_D = 'Chạy Deadline'
const NAME_J = 'Khét Lẹt'
const SPEC_C: Spec = { a: 'Cay', b: 'Cười', name: NAME_C, emoji: '🔥', depth: 1, added_version: 6 }
const SPEC_D: Spec = { a: NAME_C, b: 'Deadline', name: NAME_D, emoji: '🏃', depth: 2, added_version: 7 }
const SPEC_J: Spec = { a: 'Toang', b: 'Deadline', name: NAME_J, emoji: '🫠', depth: 1, added_version: 6 }

// ---------------------------------------------------------------- mạng giả (có API Đĩa)
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers },
  })
const problem = (status: number, headers: Record<string, string> = {}): Response =>
  json({ type: 'about:blank', title: 'Lỗi giả lập', status }, status, headers)

const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string =>
  (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

interface Combo {
  a: string
  b: string
  result: string
}
interface PlateRow {
  element_id: string
  found_at: string
}
interface Write {
  kind: 'post' | 'merge'
  body: unknown
  player: string | null
}
interface Server {
  plate: PlateRow[]
  writes: Write[]
  acked: string[] // tên kết quả đã nhận 200 (mỗi lần gửi một dòng)
  mode: 'ok' | 'network' | '500' | '429' | '401'
  getMode: 'ok' | 'network' | '500' | '401'
  retryAfter: number
  hold: boolean // phản hồi ghi không bao giờ tới
  reject: Set<string> // tên kết quả mà server coi là không hợp lệ (POST -> 422, merge -> skipped)
}

interface Net {
  manifest: () => Response | Promise<Response>
  graph: () => Response | Promise<Response>
  blocklist: () => Response | Promise<Response>
}

type SessionArg = Parameters<typeof setCurrentSession>[0]
const SESSION = { nickname: 'Lẩu Thủ', created_at: '2026-10-20T02:00:00.000Z' } as unknown as SessionArg

let net: Net
let server: Server
let fetchMock: ReturnType<typeof vi.fn>
let sessionNow: SessionArg | null = null

const combosOf = (w: Write): Combo[] => (w.kind === 'post' ? [w.body as Combo] : (w.body as { items: Combo[] }).items)
const posts = (): Write[] => server.writes.filter((w) => w.kind === 'post')
const merges = (): Write[] => server.writes.filter((w) => w.kind === 'merge')
const sentResults = (): string[] => server.writes.flatMap(combosOf).map((c) => c.result)
const plateCalls = (): unknown[][] => fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo).includes('api/me/plate'))
const plateGets = (): unknown[][] =>
  plateCalls().filter((c) => methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined) === 'GET')
const sorted = (xs: string[]): string[] => [...xs].sort()

function handleGet(): Response {
  if (server.getMode === 'network') throw new TypeError('Failed to fetch')
  if (server.getMode === '500') return problem(500)
  if (server.getMode === '401') return problem(401)
  return json({ items: server.plate }, 200, { 'Cache-Control': 'no-store' })
}

async function handleWrite(kind: 'post' | 'merge', input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? '{}')) as unknown
  const write: Write = { kind, body, player: headerOf(input, init, 'X-Player-Id') }
  server.writes.push(write)
  if (server.hold) return new Promise<Response>(() => {})
  if (server.mode === 'network') throw new TypeError('Failed to fetch')
  if (server.mode === '500') return problem(500)
  if (server.mode === '401') return problem(401)
  if (server.mode === '429') return problem(429, { 'Retry-After': String(server.retryAfter) })

  const combos = combosOf(write)
  const skipped: number[] = []
  combos.forEach((c, i) => {
    if (server.reject.has(c.result)) {
      skipped.push(i)
      return
    }
    const id = eid(c.result)
    if (!server.plate.some((p) => p.element_id === id)) server.plate.push({ element_id: id, found_at: new Date().toISOString() })
    server.acked.push(c.result)
  })
  if (kind === 'post') {
    if (skipped.length > 0) return problem(422)
    return json({ count: server.plate.length })
  }
  return json({ count: server.plate.length, skipped })
}

async function installNet(opts: { version?: number; specs?: Spec[]; blocklist?: object; plate?: PlateRow[] } = {}): Promise<void> {
  const version = opts.version ?? 7
  const manifest = manifestOf(version)
  const graph = await buildGraph(version, opts.specs ?? [])
  net = {
    manifest: () => json(manifest),
    graph: () => json(graph),
    blocklist: () => json(opts.blocklist ?? { elements: [], recipes: [], images: [] }),
  }
  server = {
    plate: [...(opts.plate ?? [])],
    writes: [],
    acked: [],
    mode: 'ok',
    getMode: 'ok',
    retryAfter: 30,
    hold: false,
    reject: new Set(),
  }
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.includes('/auth/session')) return sessionNow ? json(sessionNow) : problem(401)
    if (url.includes('api/me/plate/merge')) return handleWrite('merge', input, init)
    if (url.includes('api/me/plate')) return method === 'GET' ? handleGet() : handleWrite('post', input, init)
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
const learned = (): string[] => plateNames().filter((n) => !STARTER_NAMES.includes(n))
const tableEl = (): HTMLElement => screen.getByTestId('table')
const tableItems = (): HTMLElement[] => screen.queryAllByTestId('table-item')
const tableNames = (): string[] => tableItems().map((e) => e.dataset.name ?? '')
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')
const sortBy = (value: 'newest' | 'name' | 'depth'): void => {
  fireEvent.change(screen.getByRole('combobox', { name: 'Sắp xếp' }), { target: { value } })
}

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

function signIn(): void {
  sessionNow = SESSION
  act(() => setCurrentSession(SESSION))
}
function signOut(): void {
  sessionNow = null
  act(() => setCurrentSession(null))
}

interface SetupOpts {
  version?: number
  specs?: Spec[]
  blocklist?: object
  plate?: PlateRow[]
  progress?: (p: Progress) => void
  progressVersion?: number
  signedIn?: boolean // mặc định true
  consent?: 'granted' | 'declined' // mặc định granted
}
async function setup(o: SetupOpts = {}): Promise<void> {
  await installNet(o)
  saveConsent(localStorage, POLICY, o.consent ?? 'granted')
  seed(o.progress, o.progressVersion ?? o.version ?? 7)
  if (o.signedIn === false) signOut()
  else signIn()
}

const noReset = /chơi lại từ đầu|xóa đĩa|xóa toàn bộ đĩa/i

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  sessionNow = null
  dropTarget = null
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
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
  act(() => setCurrentSession(null))
  sessionNow = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
  vi.stubGlobal('crypto', webcrypto)
})

describe('sync (web)', () => {
  // ============================================================== AC-SYNC-01
  it('AC-SYNC-01: ghép ra món mới khi đã đăng nhập - Đĩa cục bộ cập nhật ngay, POST me/plate {a, b, result} chạy nền, game không chờ phản hồi', async () => {
    await setup({ specs: [SPEC_C, SPEC_D] })
    server.hold = true // phản hồi của API Đĩa không bao giờ tới
    await mountReady()

    await potCombine('Cay', 'Cười')
    expect(plateNames()).toContain(NAME_C)
    await waitFor(() => expect(posts()).toHaveLength(1))
    const sent = posts()[0]!
    const body = sent.body as Combo
    expect(Object.keys(body).sort()).toEqual(['a', 'b', 'result']) // không có vị trí bàn hay trường nào khác
    expect(sorted([body.a, body.b])).toEqual(sorted(['Cay', 'Cười']))
    expect(body.result).toBe(NAME_C)
    expect(sent.player).toBe(getPlayerId(localStorage))

    // phản hồi chưa tới mà vẫn ghép tiếp được
    await potCombine(NAME_C, 'Deadline')
    expect(plateNames()).toContain(NAME_D)
    expect(pot().dataset.state).toBe('idle')
    expect(screen.queryByRole('alert')).toBeNull()

    // cặp đã dùng được nhớ cục bộ để gửi bù
    const saved = loadProgress(localStorage)!.items.find((i) => i.name === NAME_C)!
    expect(sorted(saved.pair as string[])).toEqual(sorted(['Cay', 'Cười']))
    // 4 món khởi đầu không bao giờ được gửi
    expect(sentResults().every((r) => !STARTER_NAMES.includes(r))).toBe(true)
  })

  // ============================================================== AC-SYNC-02
  it('AC-SYNC-02: tải lại ở máy 2 kéo Đĩa tổng hợp (server trả sai thứ tự phụ thuộc), thời điểm sớm nhất, MỚI/sắp xếp/tìm kiếm chạy trên Đĩa tổng hợp, bàn không đổi, không gửi gì thừa', async () => {
    await setup({
      specs: [SPEC_C, SPEC_D, SPEC_J],
      plate: [
        { element_id: eid(NAME_D), found_at: '2026-10-11T00:00:00.000Z' }, // D cần C, mà C đứng sau trong danh sách
        { element_id: eid(NAME_J), found_at: '2026-10-12T00:00:00.000Z' },
        { element_id: eid(NAME_C), found_at: '2026-10-10T00:00:00.000Z' },
      ],
      progress: (p) => {
        // máy 2 đã tự ghép ra C (sớm hơn server) và E=J (muộn hơn server)
        p.items.push(withPair(item(NAME_C, '🔥', 1, 6, '2026-10-05T00:00:00.000Z'), ['Cay', 'Cười']))
        p.items.push(withPair(item(NAME_J, '🫠', 1, 6, '2026-10-15T00:00:00.000Z'), ['Toang', 'Deadline']))
        p.table = [{ uid: 't1', id: eid('Cay'), name: 'Cay', emoji: '🌶️', x: 40, y: 50 }]
      },
    })
    await mountReady()
    await waitFor(() => expect(plateNames()).toContain(NAME_D))

    expect(sorted(plateNames())).toEqual(sorted([...STARTER_NAMES, NAME_C, NAME_D, NAME_J]))
    sortBy('newest')
    expect(learned()).toEqual([NAME_J, NAME_D, NAME_C]) // J: 10-12 (server sớm hơn), D: 10-11, C: 10-05 (cục bộ sớm hơn)
    expect(within(plateItem(NAME_D)).getByText('MỚI')).toBeTruthy()
    expect(within(plateItem(NAME_C)).queryByText('MỚI')).toBeNull()
    expect(within(plateItem(NAME_J)).queryByText('MỚI')).toBeNull()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Tìm trong Đĩa nhúng' }), { target: { value: 'khet' } })
    expect(plateNames()).toEqual([NAME_J])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Tìm trong Đĩa nhúng' }), { target: { value: '' } })

    // bàn là của riêng máy này
    expect(tableItems().map((e) => [e.dataset.name, e.dataset.x, e.dataset.y])).toEqual([['Cay', '40', '50']])
    // server đã có đủ: không gửi gì
    expect(server.writes).toEqual([])
  })

  it('AC-SYNC-02: máy 3 mới đăng nhập (chưa có tiến độ) có 4 món khởi đầu + C, D, E với thời điểm của server', async () => {
    await setup({
      specs: [SPEC_C, SPEC_D, SPEC_J],
      plate: [
        { element_id: eid(NAME_D), found_at: '2026-10-11T00:00:00.000Z' },
        { element_id: eid(NAME_J), found_at: '2026-10-12T00:00:00.000Z' },
        { element_id: eid(NAME_C), found_at: '2026-10-10T00:00:00.000Z' },
      ],
    })
    await mountReady()
    await waitFor(() => expect(learned()).toHaveLength(3))
    expect(sorted(plateNames())).toEqual(sorted([...STARTER_NAMES, NAME_C, NAME_D, NAME_J]))
    sortBy('newest')
    expect(learned()).toEqual([NAME_J, NAME_D, NAME_C])
    expect(tableItems()).toHaveLength(0)
    expect(server.writes).toEqual([])
    expect(plateGets().length).toBeGreaterThanOrEqual(1)
    expect(plateGets().every((c) => headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id') === getPlayerId(localStorage))).toBe(true)
  })

  // ============================================================== AC-SYNC-03
  it('AC-SYNC-03: đăng nhập gộp F và G cục bộ (có cặp) lên server qua merge; món thiếu cặp ở lại cục bộ; Đĩa sau đó = khởi đầu + C + F + G + món cũ', async () => {
    await setup({
      signedIn: false,
      specs: [SPEC_C, SPEC_D, SPEC_J],
      plate: [{ element_id: eid(NAME_C), found_at: '2026-10-10T00:00:00.000Z' }], // server chỉ có C
      progress: (p) => {
        p.items.push(withPair(item(NAME_D, '🏃', 2, 7, '2026-10-18T00:00:00.000Z'), [NAME_C, 'Deadline'])) // F
        p.items.push(withPair(item(NAME_J, '🫠', 1, 6, '2026-10-19T00:00:00.000Z'), ['Toang', 'Deadline'])) // G
        p.items.push(item('Món Cũ', '📜', 1, 3, '2026-09-01T00:00:00.000Z')) // tiến độ cũ, thiếu cặp
      },
    })
    await mountReady()
    expect(plateCalls()).toHaveLength(0) // chưa đăng nhập: Đĩa chỉ ở cục bộ (AC-GAME-10)

    signIn()
    await waitFor(() => expect(merges()).toHaveLength(1))
    const items = (merges()[0]!.body as { items: Combo[] }).items
    expect(sorted(items.map((c) => c.result))).toEqual(sorted([NAME_D, NAME_J]))
    for (const c of items) {
      const want = c.result === NAME_D ? [NAME_C, 'Deadline'] : ['Toang', 'Deadline']
      expect(sorted([c.a, c.b])).toEqual(sorted(want))
      expect(Object.keys(c).sort()).toEqual(['a', 'b', 'result'])
    }
    expect(sentResults()).not.toContain('Món Cũ')
    expect(posts()).toHaveLength(0)

    await waitFor(() => expect(plateNames()).toContain(NAME_C))
    expect(sorted(plateNames())).toEqual(sorted([...STARTER_NAMES, NAME_C, NAME_D, NAME_J, 'Món Cũ']))
    expect(loadProgress(localStorage)!.items.map((i) => i.name)).toContain('Món Cũ')
  })

  // ============================================================== AC-SYNC-04
  it('AC-SYNC-04: server từ chối món (422) thì món chỉ ở lại cục bộ, không hiện lỗi chặn, không bị gửi lại ở lần ghép sau', async () => {
    await setup({ specs: [SPEC_C, SPEC_D] })
    server.reject.add(NAME_C)
    await mountReady()

    await potCombine('Cay', 'Cười')
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(plateNames()).toContain(NAME_C)
    expect(screen.queryByRole('alert')).toBeNull()

    await potCombine(NAME_C, 'Deadline')
    await waitFor(() => expect(posts()).toHaveLength(2))
    await advance(500)
    expect(sentResults()).toEqual([NAME_C, NAME_D]) // C không được gửi lại
    expect(merges()).toHaveLength(0)
    expect(server.acked).toEqual([NAME_D])
    expect(plateNames()).toEqual(expect.arrayContaining([NAME_C, NAME_D]))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-SYNC-04: merge trả skipped cho món không hợp lệ - món đó ở lại Đĩa cục bộ, không hiện lỗi', async () => {
    await setup({
      signedIn: false,
      specs: [SPEC_C, SPEC_D, SPEC_J],
      progress: (p) => {
        p.items.push(withPair(item(NAME_D, '🏃', 2, 7, '2026-10-18T00:00:00.000Z'), [NAME_C, 'Deadline']))
        p.items.push(withPair(item(NAME_J, '🫠', 1, 6, '2026-10-19T00:00:00.000Z'), ['Toang', 'Deadline']))
      },
    })
    server.reject.add(NAME_D)
    await mountReady()
    signIn()
    await waitFor(() => expect(merges()).toHaveLength(1))
    await advance(500)
    expect(plateNames()).toEqual(expect.arrayContaining([NAME_D, NAME_J]))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(server.acked).toEqual([NAME_J])
  })

  // ============================================================== AC-SYNC-05
  it('AC-SYNC-05: chưa đăng nhập thì không gọi API Đĩa, ghép vẫn lưu cục bộ', async () => {
    await setup({ signedIn: false, specs: [SPEC_C] })
    await mountReady()
    await potCombine('Cay', 'Cười')
    expect(plateNames()).toContain(NAME_C)
    expect(loadProgress(localStorage)!.items.map((i) => i.name)).toContain(NAME_C)
    await advance(500)
    expect(plateCalls()).toHaveLength(0)
  })

  it('AC-SYNC-05: đã đăng nhập nhưng chưa đồng ý play thì không gửi gì tới API Đĩa', async () => {
    await setup({ consent: 'declined', specs: [SPEC_C] })
    await mountReady()
    await potCombine('Cay', 'Cười')
    expect(plateNames()).toContain(NAME_C)
    await advance(500)
    expect(plateCalls()).toHaveLength(0)
  })

  it('AC-SYNC-05: GET Đĩa trả 401 (phiên hết hạn) thì client chơi tiếp cục bộ, không báo lỗi chặn, ngừng đồng bộ', async () => {
    await setup({ specs: [SPEC_C, SPEC_D] })
    server.getMode = '401'
    await mountReady()
    await waitFor(() => expect(plateGets().length).toBeGreaterThanOrEqual(1))

    await potCombine('Cay', 'Cười')
    await potCombine(NAME_C, 'Deadline')
    expect(plateNames()).toEqual(expect.arrayContaining([NAME_C, NAME_D]))
    expect(screen.queryByRole('alert')).toBeNull()
    await advance(500)
    expect(server.writes).toEqual([])
  })

  it('AC-SYNC-05: ghi trả 401 thì ngừng đồng bộ - lần ghép sau không gửi nữa, vẫn chơi cục bộ', async () => {
    await setup({ specs: [SPEC_C, SPEC_D] })
    server.mode = '401'
    await mountReady()

    await potCombine('Cay', 'Cười')
    await waitFor(() => expect(server.writes).toHaveLength(1))
    await potCombine(NAME_C, 'Deadline')
    await advance(500)
    expect(server.writes).toHaveLength(1)
    expect(plateNames()).toEqual(expect.arrayContaining([NAME_C, NAME_D]))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-SYNC-05: đăng xuất giữa chừng thì món ghép sau đó không được gửi', async () => {
    await setup({ specs: [SPEC_C] })
    await mountReady()
    await waitFor(() => expect(plateGets().length).toBeGreaterThanOrEqual(1))
    signOut()
    await potCombine('Cay', 'Cười')
    await advance(500)
    expect(plateNames()).toContain(NAME_C)
    expect(server.writes).toEqual([])
  })

  // ============================================================== AC-SYNC-06
  it('AC-SYNC-06: lỗi mạng lúc ghép C - C vào Đĩa cục bộ ngay, không báo lỗi; API sống lại thì gửi bù C cùng D ở lần ghép sau, mỗi món đúng một lần; tải lại không gửi lại', async () => {
    await setup({ specs: [SPEC_C, SPEC_D] })
    server.mode = 'network'
    await mountReady()

    await potCombine('Cay', 'Cười')
    expect(plateNames()).toContain(NAME_C)
    await waitFor(() => expect(server.writes.length).toBeGreaterThanOrEqual(1))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(server.acked).toEqual([])

    server.mode = 'ok'
    await potCombine(NAME_C, 'Deadline')
    await waitFor(() => expect(sorted(server.acked)).toEqual(sorted([NAME_C, NAME_D])))
    expect(server.plate.map((p) => p.element_id).sort()).toEqual(sorted([eid(NAME_C), eid(NAME_D)]))
    expect(screen.queryByRole('alert')).toBeNull()

    const before = server.writes.length
    await reload()
    await advance(500)
    expect(server.writes).toHaveLength(before)
    expect(sorted(server.acked)).toEqual(sorted([NAME_C, NAME_D]))
  })

  it('AC-SYNC-06: 5xx rồi tải lại trong lúc API còn lỗi thì dùng Đĩa cục bộ, không mất món; API sống lại và tải lại thì gửi bù đúng một lần', async () => {
    await setup({ specs: [SPEC_C, SPEC_J] })
    server.mode = '500'
    await mountReady()
    await potCombine('Cay', 'Cười')
    await potCombine('Toang', 'Deadline')
    await waitFor(() => expect(server.writes.length).toBeGreaterThanOrEqual(2))
    expect(server.acked).toEqual([])

    // tải lại khi API hỏng hoàn toàn
    server.mode = 'network'
    server.getMode = 'network'
    await reload()
    expect(plateNames()).toEqual(expect.arrayContaining([NAME_C, NAME_J]))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(loadProgress(localStorage)!.items.map((i) => i.name)).toEqual(expect.arrayContaining([NAME_C, NAME_J]))

    // API sống lại, tải lại
    server.mode = 'ok'
    server.getMode = 'ok'
    await reload()
    await waitFor(() => expect(sorted(server.acked)).toEqual(sorted([NAME_C, NAME_J])))
    expect(plateNames()).toEqual(expect.arrayContaining([NAME_C, NAME_J]))

    // đã nhận 200 thì lần tải sau không gửi nữa
    const before = server.writes.length
    await reload()
    await advance(500)
    expect(server.writes).toHaveLength(before)
  })

  // ============================================================== AC-SYNC-07
  it('AC-SYNC-07: Đĩa 30 món của T - "Dọn bàn" không gửi request nào tới me/plate, Đĩa giữ nguyên trước và sau khi tải lại, không có nút xóa Đĩa', async () => {
    const chain: Spec[] = Array.from({ length: 30 }, (_, i) => ({
      a: i === 0 ? 'Cay' : `Món Chuỗi ${i}`,
      b: STARTER_NAMES[i % 4]!,
      name: `Món Chuỗi ${i + 1}`,
      depth: i + 1,
      added_version: 6,
    }))
    await setup({
      specs: chain,
      plate: chain.map((s, i) => ({ element_id: eid(s.name), found_at: `2026-10-${String(1 + i).padStart(2, '0')}T00:00:00.000Z` })),
    })
    await mountReady()
    await waitFor(() => expect(plateItems()).toHaveLength(34), { timeout: 15_000 })

    drag(plateItem('Cay'), tableEl(), { x: 80, y: 90 })
    expect(tableNames()).toEqual(['Cay'])
    fetchMock.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Dọn bàn' }))
    await waitFor(() => expect(tableItems()).toHaveLength(0))
    expect(plateItems()).toHaveLength(34)
    expect(plateCalls()).toEqual([])

    for (const role of ['button', 'menuitem', 'link'] as const) {
      expect(screen.queryAllByRole(role, { name: noReset }), role).toHaveLength(0)
    }
    expect(document.body.textContent ?? '').not.toMatch(noReset)

    await reload()
    await waitFor(() => expect(plateItems()).toHaveLength(34), { timeout: 15_000 })
    expect(tableItems()).toHaveLength(0)
    const deletes = fetchMock.mock.calls.filter((c) => methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined) === 'DELETE')
    expect(deletes).toEqual([])
    expect(server.writes).toEqual([]) // server đã giữ đủ, không có gì để gửi
    expect(server.plate).toHaveLength(30)
  }, 60_000)

  // ============================================================== AC-SYNC-08
  it('AC-SYNC-08: món J của server bị chặn thì ẩn khỏi Đĩa; bỏ chặn thì hiện lại không cần ghép lại', async () => {
    await setup({
      specs: [SPEC_C, SPEC_J],
      blocklist: { elements: [eid(NAME_J)], recipes: [], images: [] },
      plate: [
        { element_id: eid(NAME_C), found_at: '2026-10-10T00:00:00.000Z' },
        { element_id: eid(NAME_J), found_at: '2026-10-12T00:00:00.000Z' },
      ],
    })
    await mountReady()
    await waitFor(() => expect(plateNames()).toContain(NAME_C))
    expect(plateNames()).not.toContain(NAME_J)
    expect(tableNames()).not.toContain(NAME_J)

    // bỏ chặn rồi tải lại: J hiện lại, không có lần ghép nào
    net.blocklist = () => json({ elements: [], recipes: [], images: [] })
    await reload()
    await waitFor(() => expect(plateNames()).toContain(NAME_J))
    expect(plateNames()).toContain(NAME_C)
    expect(tableItems()).toHaveLength(0)
    expect(pot().dataset.state).toBe('idle')
    expect(server.writes).toEqual([])
    expect(server.plate).toHaveLength(2) // server không hề mất J
  })

  it('AC-SYNC-08: manifest lên version 8, graph mới không còn J - Đĩa vẫn có đủ C và J, không hỏi gì, không gửi gì', async () => {
    await setup({
      version: 8,
      progressVersion: 7,
      specs: [{ ...SPEC_C, added_version: 6 }],
      plate: [
        { element_id: eid(NAME_C), found_at: '2026-10-10T00:00:00.000Z' },
        { element_id: eid(NAME_J), found_at: '2026-10-12T00:00:00.000Z' },
      ],
      progress: (p) => {
        p.items.push(withPair(item(NAME_C, '🔥', 1, 6, '2026-10-10T00:00:00.000Z'), ['Cay', 'Cười']))
        p.items.push(withPair(item(NAME_J, '🫠', 1, 6, '2026-10-12T00:00:00.000Z'), ['Toang', 'Deadline']))
      },
    })
    await mountReady()
    await waitFor(() => expect(plateGets().length).toBeGreaterThanOrEqual(1))
    await advance(500)
    expect(plateNames()).toEqual(expect.arrayContaining([NAME_C, NAME_J]))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(server.writes).toEqual([])
  })

  it('AC-SYNC-08: máy mới, graph hiện hành không còn J (không giải ra được) - không lỗi chặn, các món còn lại vẫn hiện', async () => {
    await setup({
      version: 8,
      specs: [{ ...SPEC_C, added_version: 6 }],
      plate: [
        { element_id: eid(NAME_C), found_at: '2026-10-10T00:00:00.000Z' },
        { element_id: eid(NAME_J), found_at: '2026-10-12T00:00:00.000Z' },
      ],
    })
    await mountReady()
    await waitFor(() => expect(plateNames()).toContain(NAME_C))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(server.writes).toEqual([])
  })

  // ============================================================== AC-SYNC-09
  it('AC-SYNC-09: 501 món cục bộ có cặp được gộp thành các lô <= 500 (không bỏ sót, không trùng)', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `Món Lô ${i}`)
    await setup({
      signedIn: false,
      progress: (p) => {
        for (const n of names) p.items.push(withPair(item(n, '🍲', 1, 6, '2026-10-01T00:00:00.000Z'), ['Cay', 'Cười']))
      },
    })
    await mountReady()
    signIn()
    await waitFor(() => expect(merges().length).toBeGreaterThanOrEqual(2), { timeout: 20_000 })
    await advance(500)
    const sizes = merges().map((m) => (m.body as { items: Combo[] }).items.length)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(501)
    expect(sorted(sentResults())).toEqual(sorted(names))
    expect(posts()).toHaveLength(0)
  }, 60_000)

  it('AC-SYNC-09: 429 kèm Retry-After 30 s - không gửi lại trước hạn, không báo lỗi; qua hạn thì gửi bù C, D cùng món mới, mỗi món đúng một lần', async () => {
    await setup({ specs: [SPEC_C, SPEC_D, SPEC_J] })
    server.mode = '429'
    server.retryAfter = 30
    await mountReady()

    await potCombine('Cay', 'Cười')
    await waitFor(() => expect(server.writes).toHaveLength(1))
    expect(screen.queryByRole('alert')).toBeNull()

    server.mode = 'ok' // API đã ổn nhưng chưa hết Retry-After
    await potCombine(NAME_C, 'Deadline')
    await advance(500)
    expect(server.writes).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()

    await advance(31_000)
    await potCombine('Toang', 'Deadline')
    await waitFor(() => expect(sorted(server.acked)).toEqual(sorted([NAME_C, NAME_D, NAME_J])))
    expect(plateNames()).toEqual(expect.arrayContaining([NAME_C, NAME_D, NAME_J]))
  })

  // ============================================================== AC-SYNC-10
  it('AC-SYNC-10: trang chính sách nêu thêm dữ liệu "danh sách món đã ghép ra theo tài khoản", mục đích "chơi tiếp trên nhiều máy", thời hạn "đến khi xóa tài khoản"', () => {
    render(<PolicyPage />)
    const text = (document.body.textContent ?? '').toLowerCase()
    expect(text).toContain('danh sách món đã ghép ra theo tài khoản')
    expect(text).toContain('chơi tiếp trên nhiều máy')
    expect(text).toContain('đến khi xóa tài khoản')
  })
})
