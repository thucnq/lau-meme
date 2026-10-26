// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/contrib.md, phần web (người chơi): AC-CONTRIB-05 (giao diện), 06 (Đề xuất của tôi),
 * 10 (dòng "Meme của ..." trên phần tử), 11 (thẻ "Cống hiến" của bảng xếp hạng). Hộp đen qua <Game /> và <Leaderboards />,
 * mạng là fetch giả (cùng cách dựng graph mã hóa thật như sync.ui.test.tsx).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (mã production chưa có)
 *   Game      sau khi tải manifest, GET api/creators/<version> -> { "<element_id>": "<nickname>" | null }.
 *             Phần tử trong Đĩa (data-testid="plate-item") hoặc trên bàn (data-testid="table-item") có id nằm trong bản đồ thì
 *             có `aria-describedby` trỏ tới một dòng role="tooltip" có chữ "Meme của <nickname>" ("Meme của Thực khách ẩn
 *             danh" khi null). Dòng có thuộc tính `hidden` cho tới khi rê chuột lên phần tử (pointerenter/mouseenter), focus
 *             bàn phím, hoặc chạm giữ 500 ms (pointerType "touch", không di chuyển); rời chuột / blur / thả tay thì ẩn lại
 *             (chuột, focus). Chạm giữ không kéo thả và không đưa phần tử vào nồi. Phần tử lõi không có dòng và không có
 *             aria-describedby. Lỗi tải creators thì game vẫn chạy, không dòng nào, không báo lỗi.
 *   AC-CONTRIB-13 (2026-10-25): "Phần tử 1"/"Phần tử 2" là role="combobox" (tên truy cập = nhãn); danh sách role="option"
 *             ("<emoji> <tên>") chỉ gồm phần tử trong Đĩa, lọc theo fold; mỗi ô đã chọn có nút "Bỏ chọn Phần tử N"; thả món
 *             (Đĩa hoặc bàn) lên ô qua document.elementFromPoint chọn nó mà không đổi bàn/nồi; chưa chọn thì "Gửi đề xuất" hiện
 *             chữ có "chọn ... phần tử" và không POST.
 *   Game      nút "Đóng góp meme" ở thanh trên. Chưa đăng nhập: bấm hiện chữ "Đăng nhập bằng Google để đóng góp meme", không có
 *             form. Đã đăng nhập: mở vùng role="region" tên "Đóng góp meme" gồm form (ô "Phần tử 1", "Phần tử 2", "Tên meme",
 *             "Biểu tượng", "Mô tả", "Link ảnh", nút "Gửi đề xuất"), gửi POST api/contributions {a, b, name, emoji?, description?,
 *             image_url?} (trường tùy chọn rỗng thì bỏ), 201 -> "Đã gửi, chờ duyệt", 4xx problem+json -> role="alert" có `detail`,
 *             422 -> "Nội dung không phù hợp". Cùng vùng có mục tiêu đề "Đề xuất của tôi" đọc GET api/me/contributions: mỗi đề
 *             xuất hiện tên, biểu tượng, cặp "A + B", nhãn trạng thái ("Chờ duyệt" / "Đã duyệt" / "Bị từ chối") và lý do từ
 *             chối; rỗng thì "Bạn chưa đóng góp meme nào".
 *   Leaderboards({ version }) từ ../daily/DailyPanel: thẻ thứ 4 "Cống hiến" sau "Mẻ này", "Tuần", "Tháng"; đọc GET
 *             api/contributors/leaderboard, mỗi dòng là listitem "#<hạng> <nickname> - <số> meme", huy chương 🥇🥈🥉 cho hạng 1-3,
 *             dòng của mình (hạng = me.rank) có aria-current="true", me ngoài top thì thêm dòng bắt đầu "Bạn: ", rỗng thì "Chưa
 *             có meme đóng góp nào được duyệt".
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentSession } from '../auth/session'
import { Leaderboards } from '../daily/DailyPanel'
import { initialProgress, saveProgress } from '../game/engine'
import type { Item, Manifest, Progress } from '../game/engine'
import { Game } from '../game/Game'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
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
    entries[key] = Buffer.from(new Uint8Array(ct)).toString('base64url')
  }
  return { format: 1, version, entries }
}

const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7
const POLICY = 1
const STARTER_NAMES = ['Cay', 'Cười', 'Toang', 'Deadline']
const MISS_LINES = Array.from({ length: 30 }, (_, i) => `Nồi trào kiểu ${i}, khét rồi!`)
const NAME_CORE = 'Tới Công Chuyện'
const NAME_X = 'Cà Phê Chạy Deadline' // người tạo "Bún Chả"
const NAME_Y = 'Meme Ẩn Danh' // người tạo không có nickname
const SPECS: Spec[] = [
  { a: 'Cay', b: 'Cười', name: NAME_CORE, emoji: '🔥', depth: 1, added_version: 6 },
  { a: 'Cay', b: 'Toang', name: NAME_X, emoji: '☕', depth: 2, added_version: 7 },
  { a: 'Cười', b: 'Toang', name: NAME_Y, emoji: '🍲', depth: 2, added_version: 7 },
]
const CREATORS: Record<string, string | null> = { [eid(NAME_X)]: 'Bún Chả', [eid(NAME_Y)]: null }

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
    miss_lines: MISS_LINES,
    daily: { element_id: eid(NAME_CORE), emoji: '🍜', hint: 'gợi ý', depth: 4 },
    policy_version: POLICY,
  } as Manifest
}

function item(name: string, emoji: string, depth: number): Item {
  return { id: eid(name), name, emoji, depth, added_version: 7, image_key: null, discovered_at: '2026-10-20T01:00:00.000Z' }
}

// ---------------------------------------------------------------- mạng giả
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  })
const problem = (status: number, title: string, detail?: string): Response =>
  json({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) }, status)

const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const pathOf = (input: RequestInfo | URL): string => new URL(urlOf(input), 'https://example.com').pathname
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string =>
  (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

type SessionArg = Parameters<typeof setCurrentSession>[0]
const SESSION = { nickname: 'Lẩu Thủ', created_at: '2026-10-20T02:00:00.000Z' } as unknown as SessionArg

interface StarterRef {
  id: string
  name: string
  emoji: string
}
interface Mine {
  id: string
  a: StarterRef
  b: StarterRef
  name: string
  emoji: string | null
  description: string | null
  image_url: string | null
  status: 'pending' | 'approved' | 'rejected'
  reject_reason: string | null
  created_at: string
}
const ref = (name: string, emoji: string): StarterRef => ({ id: eid(name), name, emoji })

let fetchMock: ReturnType<typeof vi.fn>
let sessionNow: SessionArg | null = null
let creatorsMode: 'ok' | 'network' | '500' = 'ok'
let submitReply: () => Response
let mine: Mine[] = []
let contribBoard: () => Response

async function installNet(): Promise<void> {
  const manifest = manifestOf()
  const graph = await buildGraph(VERSION, SPECS)
  creatorsMode = 'ok'
  mine = []
  submitReply = () => json({ ...MINE_BASE, id: crypto.randomUUID() }, 201)
  contribBoard = () => json({ rows: [], me: null })
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input)
    const method = methodOf(input, init)
    if (path.endsWith('/auth/session')) return sessionNow ? json(sessionNow) : problem(401, 'Chưa đăng nhập')
    if (path.endsWith('/manifest')) return json(manifest)
    if (path.includes('/graph/')) return json(graph)
    if (path.endsWith('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    if (path.includes('/creators/')) {
      if (creatorsMode === 'network') throw new TypeError('Failed to fetch')
      if (creatorsMode === '500') return problem(500, 'Lỗi máy chủ')
      return json(CREATORS, 200)
    }
    if (path.endsWith('/me/contributions')) return json({ page: 1, size: 50, total: mine.length, items: mine })
    if (path.endsWith('/contributions') && method === 'POST') return submitReply()
    if (path.endsWith('/contributors/leaderboard')) return contribBoard()
    if (path.endsWith('/daily/leaderboard')) {
      return json({ period: '2026-W43', starts_at: '2026-10-18T17:00:00.000Z', ends_at: '2026-10-25T17:00:00.000Z', batches: 0, rows: [], me: null })
    }
    if (path.endsWith('/leaderboard')) return json({ version: VERSION, rows: [], me: null })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

const MINE_BASE: Mine = {
  id: '00000000-0000-4000-8000-000000000001',
  a: ref('Deadline', '⏰'),
  b: ref('Cà Phê', '🫖'),
  name: NAME_X,
  emoji: null,
  description: null,
  image_url: null,
  status: 'pending',
  reject_reason: null,
  created_at: '2026-10-20T02:30:00.000Z',
}

const calls = () =>
  fetchMock.mock.calls.map((c) => ({
    path: pathOf(c[0] as RequestInfo),
    method: methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined),
    player: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id'),
    body: (c[1] as RequestInit | undefined)?.body as string | undefined,
  }))
const creatorGets = () => calls().filter((c) => c.method === 'GET' && c.path.includes('/creators/'))
const submits = () => calls().filter((c) => c.method === 'POST' && c.path.endsWith('/contributions'))
const boardGets = () => calls().filter((c) => c.method === 'GET' && c.path.endsWith('/contributors/leaderboard'))

// ---------------------------------------------------------------- kéo thả và con trỏ
let dropTarget: Element | null = null

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const touch = (extra: Record<string, number> = {}) => ({ pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: 5, clientY: 5, ...extra })

// ---------------------------------------------------------------- truy vấn DOM
const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
const plateItems = (): HTMLElement[] => within(plateEl()).queryAllByTestId('plate-item')
const plateItem = (name: string): HTMLElement => {
  const el = plateItems().find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa: ${plateItems().map((e) => e.dataset.name).join(', ')}`)
  return el
}
const tableItems = (): HTMLElement[] => screen.queryAllByTestId('table-item')
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')

/** Dòng "Meme của ..." mà aria-describedby của phần tử trỏ tới. */
function lineOf(el: HTMLElement): HTMLElement {
  const id = el.getAttribute('aria-describedby')
  expect(id, `"${el.dataset.name}" phải có aria-describedby`).toBeTruthy()
  const line = document.getElementById(id as string)
  expect(line, `không có phần tử id="${id}"`).not.toBeNull()
  return line as HTMLElement
}
const waitForLine = (el: HTMLElement) => waitFor(() => expect(el.getAttribute('aria-describedby')).toBeTruthy())

async function mountReady(): Promise<void> {
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}

function seed(mutate: (p: Progress) => void = () => {}): void {
  const p = initialProgress(manifestOf(), T0)
  p.tutorial_seen = true
  mutate(p)
  saveProgress(localStorage, p)
}
const withContributed = (p: Progress): void => {
  p.items.push(item(NAME_CORE, '🔥', 1), item(NAME_X, '☕', 2), item(NAME_Y, '🍲', 2))
}
/** Đĩa có thêm "Cà Phê" (AC-CONTRIB-13: chỉ chọn được phần tử có trong Đĩa). */
const withCafe = (p: Progress): void => {
  withContributed(p)
  p.items.push(item('Cà Phê', '🫖', 1))
}

async function setup(o: { signedIn?: boolean; progress?: (p: Progress) => void } = {}): Promise<void> {
  await installNet()
  saveConsent(localStorage, POLICY, 'granted')
  seed(o.progress ?? withContributed)
  if (o.signedIn) {
    sessionNow = SESSION
    act(() => setCurrentSession(SESSION))
  } else {
    sessionNow = null
    act(() => setCurrentSession(null))
  }
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
  // jsdom cũ không có PointerEvent: dựng bản tối thiểu để pointerType/pointerId đi cùng sự kiện.
  if (typeof (window as unknown as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
    class PointerEventShim extends MouseEvent {
      pointerId: number
      pointerType: string
      isPrimary: boolean
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 0
        this.pointerType = init.pointerType ?? ''
        this.isPrimary = init.isPrimary ?? false
      }
    }
    Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: PointerEventShim })
  }
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
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ AC-CONTRIB-10: người tạo trên phần tử
describe('contrib ui: người tạo trên phần tử', () => {
  it('AC-CONTRIB-10: sau khi tải manifest game gọi GET api/creators/<version>; phần tử đóng góp có dòng "Meme của Bún Chả" / "Meme của Thực khách ẩn danh" nối bằng aria-describedby, ẩn sẵn; phần tử lõi và khởi đầu không có', async () => {
    await setup()
    await mountReady()
    await waitFor(() => expect(creatorGets().length).toBeGreaterThanOrEqual(1))
    expect(creatorGets()[0]!.path).toMatch(new RegExp(`/api/creators/${VERSION}$`))

    const x = plateItem(NAME_X)
    const y = plateItem(NAME_Y)
    await waitForLine(x)
    await waitForLine(y)
    expect(lineOf(x).textContent?.trim()).toBe('Meme của Bún Chả')
    expect(lineOf(y).textContent?.trim()).toBe('Meme của Thực khách ẩn danh')
    expect(lineOf(x).getAttribute('role')).toBe('tooltip')
    expect(lineOf(x).hidden).toBe(true)
    expect(lineOf(y).hidden).toBe(true)

    for (const name of [NAME_CORE, ...STARTER_NAMES]) {
      expect(plateItem(name).hasAttribute('aria-describedby'), name).toBe(false)
    }
    expect(screen.queryByText('Meme của Bún Chả', { ignore: '[hidden]' })).toBeNull()
  })

  it('AC-CONTRIB-10: rê chuột lên phần tử hiện dòng (role="tooltip", không hidden), rời chuột thì ẩn lại', async () => {
    await setup()
    await mountReady()
    const x = plateItem(NAME_X)
    await waitForLine(x)
    const line = lineOf(x)

    fireEvent.pointerEnter(x, { pointerType: 'mouse', pointerId: 1 })
    fireEvent.mouseEnter(x)
    await waitFor(() => expect(line.hidden).toBe(false))
    expect(screen.getAllByRole('tooltip')).toContain(line)
    expect(line.textContent?.trim()).toBe('Meme của Bún Chả')

    fireEvent.pointerLeave(x, { pointerType: 'mouse', pointerId: 1 })
    fireEvent.mouseLeave(x)
    await waitFor(() => expect(line.hidden).toBe(true))
  })

  it('AC-CONTRIB-10: dùng bàn phím đưa focus vào phần tử thì hiện dòng, blur thì ẩn', async () => {
    await setup()
    await mountReady()
    const y = plateItem(NAME_Y)
    await waitForLine(y)
    const line = lineOf(y)
    expect(line.hidden).toBe(true)

    fireEvent.focus(y)
    await waitFor(() => expect(line.hidden).toBe(false))
    expect(screen.getAllByRole('tooltip')).toContain(line)
    expect(line.textContent?.trim()).toBe('Meme của Thực khách ẩn danh')

    fireEvent.blur(y)
    await waitFor(() => expect(line.hidden).toBe(true))
  })

  it('AC-CONTRIB-10: chạm giữ 500 ms (không di chuyển) hiện dòng; chạm giữ không kéo thả và không đưa phần tử vào nồi', async () => {
    await setup()
    await mountReady()
    const x = plateItem(NAME_X)
    await waitForLine(x)
    const line = lineOf(x)
    const tablesBefore = tableItems().length
    dropTarget = slot(1) // nếu lỡ coi là kéo thả thì phần tử sẽ rơi vào ô nồi

    fireEvent.pointerDown(x, touch())
    await advance(450)
    expect(line.hidden).toBe(true) // chưa đủ 500 ms
    await advance(100)
    await waitFor(() => expect(line.hidden).toBe(false))
    expect(screen.getAllByRole('tooltip')).toContain(line)

    fireEvent.pointerUp(x, touch({ buttons: 0 }))
    await advance(1500)
    expect(pot().dataset.state).toBe('idle')
    expect(slot(1).textContent ?? '').not.toContain(NAME_X)
    expect(slot(2).textContent ?? '').not.toContain(NAME_X)
    expect(tableItems()).toHaveLength(tablesBefore)
    expect(plateItem(NAME_X)).toBeTruthy()
  })

  it('AC-CONTRIB-10: chạm nhanh dưới 500 ms hoặc di chuyển ngón tay trước 500 ms thì không hiện dòng', async () => {
    await setup()
    await mountReady()
    const x = plateItem(NAME_X)
    await waitForLine(x)
    const line = lineOf(x)

    fireEvent.pointerDown(x, touch())
    await advance(200)
    fireEvent.pointerUp(x, touch({ buttons: 0 }))
    await advance(800)
    expect(line.hidden).toBe(true)

    fireEvent.pointerDown(x, touch())
    await advance(100)
    fireEvent.pointerMove(x, touch({ clientX: 80, clientY: 80 }))
    await advance(800)
    expect(line.hidden).toBe(true)
    fireEvent.pointerUp(x, touch({ buttons: 0, clientX: 80, clientY: 80 }))
  })

  it('AC-CONTRIB-10: phần tử đóng góp đang ở trên bàn cũng có dòng "Meme của ..." khi rê chuột; phần tử lõi trên bàn thì không', async () => {
    await setup({
      progress: (p) => {
        withContributed(p)
        p.table = [
          { uid: 't1', id: eid(NAME_X), name: NAME_X, emoji: '☕', x: 40, y: 50 },
          { uid: 't2', id: eid(NAME_CORE), name: NAME_CORE, emoji: '🔥', x: 120, y: 50 },
        ]
      },
    })
    await mountReady()
    const onTable = (name: string) => tableItems().find((e) => e.dataset.name === name) as HTMLElement
    await waitFor(() => expect(onTable(NAME_X).getAttribute('aria-describedby')).toBeTruthy())
    const line = lineOf(onTable(NAME_X))
    expect(line.hidden).toBe(true)
    fireEvent.pointerEnter(onTable(NAME_X), { pointerType: 'mouse', pointerId: 1 })
    fireEvent.mouseEnter(onTable(NAME_X))
    await waitFor(() => expect(line.hidden).toBe(false))
    expect(line.textContent?.trim()).toBe('Meme của Bún Chả')
    expect(onTable(NAME_CORE).hasAttribute('aria-describedby')).toBe(false)
  })

  it('AC-CONTRIB-10: lỗi mạng hoặc 500 khi tải creators thì game vẫn chơi được, không có dòng nào, không báo lỗi', async () => {
    for (const mode of ['network', '500'] as const) {
      await setup()
      creatorsMode = mode
      await mountReady()
      await waitFor(() => expect(creatorGets().length).toBeGreaterThanOrEqual(1))
      await advance(1000)
      for (const name of [NAME_X, NAME_Y, NAME_CORE]) expect(plateItem(name).hasAttribute('aria-describedby'), `${mode}: ${name}`).toBe(false)
      expect(screen.queryAllByRole('tooltip', { hidden: true })).toHaveLength(0)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(pot().dataset.state).toBe('idle')
      cleanup()
    }
  })
})

// ================================================================ AC-CONTRIB-05 (giao diện) và AC-CONTRIB-06
describe('contrib ui: đóng góp meme', () => {
  const openButton = (): HTMLElement => screen.getByRole('button', { name: 'Đóng góp meme' })
  const region = async (): Promise<HTMLElement> => screen.findByRole('region', { name: 'Đóng góp meme' })
  const fill = (root: HTMLElement, label: string, value: string): void => {
    fireEvent.change(within(root).getByLabelText(label), { target: { value } })
  }
  // AC-CONTRIB-13: "Phần tử 1/2" là combobox, chỉ chọn trong Đĩa (chuột: gõ rồi bấm vào mục trong danh sách)
  const flat = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim()
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const combo = (root: HTMLElement, label: string): HTMLElement => within(root).getByRole('combobox', { name: label })
  // chỉ lấy mục trong listbox của combobox, không lấy <option> gốc của ô chọn sắp xếp Đĩa
  const listOptions = (): HTMLElement[] => screen.queryAllByRole('listbox').flatMap((lb) => within(lb).queryAllByRole('option'))
  const optionFor = (name: string): HTMLElement | undefined =>
    listOptions().find((o) => new RegExp(`^\\S*\\s*${escapeRe(name)}$`).test(flat(o.textContent)))
  const choose = async (root: HTMLElement, label: string, name: string): Promise<void> => {
    const box = combo(root, label)
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: name } })
    await waitFor(() => expect(optionFor(name), `không có mục "${name}" trong danh sách "${label}"`).toBeTruthy())
    fireEvent.click(optionFor(name)!)
    await waitFor(() => expect(within(root).getByRole('button', { name: `Bỏ chọn ${label}` })).toBeTruthy())
  }
  const clearButton = (root: HTMLElement, label: string): HTMLElement | null => within(root).queryByRole('button', { name: `Bỏ chọn ${label}` })
  /** Chữ (và giá trị ô nhập) của khối chứa ô combobox và nút "Bỏ chọn": phải có cả emoji lẫn tên đã chọn. */
  const fieldText = (root: HTMLElement, label: string): string => {
    const clear = within(root).getByRole('button', { name: `Bỏ chọn ${label}` })
    const box = combo(root, label)
    let el: HTMLElement | null = clear
    while (el && !el.contains(box)) el = el.parentElement
    return flat(`${el?.textContent ?? ''} ${(box as HTMLInputElement).value ?? ''}`)
  }
  const mouse = (extra: Record<string, number> = {}) => ({ pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 5, clientY: 5, ...extra })
  const dragOnto = async (src: HTMLElement, target: Element): Promise<void> => {
    dropTarget = target
    fireEvent.pointerDown(src, mouse())
    fireEvent.pointerMove(src, mouse({ clientX: 60, clientY: 60 }))
    fireEvent.pointerMove(src, mouse({ clientX: 120, clientY: 120 }))
    fireEvent.pointerUp(src, mouse({ buttons: 0, clientX: 120, clientY: 120 }))
    await advance(1500)
    dropTarget = null
  }

  it('AC-CONTRIB-05: chưa đăng nhập vẫn có nút "Đóng góp meme"; bấm hiện lời mời đăng nhập, không có form, không gửi gì', async () => {
    await setup({ signedIn: false })
    await mountReady()
    expect(openButton()).toBeTruthy()
    fireEvent.click(openButton())
    expect(await screen.findByText('Đăng nhập bằng Google để đóng góp meme')).toBeTruthy()
    expect(screen.queryByLabelText('Tên meme')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Gửi đề xuất' })).toBeNull()
    expect(submits()).toEqual([])
  })

  it('AC-CONTRIB-05: đã đăng nhập, bấm nút mở vùng "Đóng góp meme" có form đủ 6 ô và nút "Gửi đề xuất"', async () => {
    await setup({ signedIn: true })
    await mountReady()
    fireEvent.click(openButton())
    const panel = await region()
    for (const label of ['Phần tử 1', 'Phần tử 2', 'Tên meme', 'Biểu tượng', 'Mô tả', 'Link ảnh']) {
      expect(within(panel).getByLabelText(label), label).toBeTruthy()
    }
    expect(within(panel).getByRole('button', { name: 'Gửi đề xuất' })).toBeTruthy()
    expect(screen.queryByText('Đăng nhập bằng Google để đóng góp meme')).toBeNull()
  })

  it('AC-CONTRIB-01: gửi chỉ với tên -> POST api/contributions {a, b, name} (trường tùy chọn rỗng bị bỏ) kèm X-Player-Id, hiện "Đã gửi, chờ duyệt"', async () => {
    await setup({ signedIn: true, progress: withCafe })
    await mountReady()
    fireEvent.click(openButton())
    const panel = await region()
    await choose(panel, 'Phần tử 1', 'Deadline')
    await choose(panel, 'Phần tử 2', 'Cà Phê')
    fill(panel, 'Tên meme', NAME_X)
    fireEvent.click(within(panel).getByRole('button', { name: 'Gửi đề xuất' }))

    await waitFor(() => expect(submits()).toHaveLength(1))
    expect(JSON.parse(submits()[0]!.body!)).toEqual({ a: 'Deadline', b: 'Cà Phê', name: NAME_X })
    expect(submits()[0]!.player).toBe(getPlayerId(localStorage))
    expect(await screen.findByText('Đã gửi, chờ duyệt')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-CONTRIB-01: gửi kèm biểu tượng, mô tả, link ảnh thì thân POST có đủ emoji, description, image_url', async () => {
    await setup({ signedIn: true, progress: withCafe })
    await mountReady()
    fireEvent.click(openButton())
    const panel = await region()
    await choose(panel, 'Phần tử 1', 'Cà Phê')
    await choose(panel, 'Phần tử 2', 'Deadline')
    fill(panel, 'Tên meme', 'Cà Phê Thức Đêm')
    fill(panel, 'Biểu tượng', '☕')
    fill(panel, 'Mô tả', 'Uống để thức tới sáng')
    fill(panel, 'Link ảnh', 'https://example.com/a.png')
    fireEvent.click(within(panel).getByRole('button', { name: 'Gửi đề xuất' }))

    await waitFor(() => expect(submits()).toHaveLength(1))
    expect(JSON.parse(submits()[0]!.body!)).toEqual({
      a: 'Cà Phê',
      b: 'Deadline',
      name: 'Cà Phê Thức Đêm',
      emoji: '☕',
      description: 'Uống để thức tới sáng',
      image_url: 'https://example.com/a.png',
    })
  })

  it('AC-CONTRIB-03: máy chủ trả 409 problem+json thì chi tiết lỗi hiện trong role="alert", không hiện "Đã gửi"', async () => {
    await setup({ signedIn: true })
    submitReply = () => problem(409, 'Xung đột', 'Cặp này đã có công thức')
    await mountReady()
    fireEvent.click(openButton())
    const panel = await region()
    await choose(panel, 'Phần tử 1', 'Cười')
    await choose(panel, 'Phần tử 2', 'Toang')
    fill(panel, 'Tên meme', 'Cười Mới')
    fireEvent.click(within(panel).getByRole('button', { name: 'Gửi đề xuất' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Cặp này đã có công thức')
    expect(screen.queryByText('Đã gửi, chờ duyệt')).toBeNull()
  })

  it('AC-CONTRIB-04: máy chủ trả 422 thì hiện "Nội dung không phù hợp" và không nêu từ nào', async () => {
    await setup({ signedIn: true, progress: withCafe })
    submitReply = () => problem(422, 'Nội dung không phù hợp')
    await mountReady()
    fireEvent.click(openButton())
    const panel = await region()
    await choose(panel, 'Phần tử 1', 'Deadline')
    await choose(panel, 'Phần tử 2', 'Cà Phê')
    fill(panel, 'Tên meme', 'Tên Bị Chặn')
    fireEvent.click(within(panel).getByRole('button', { name: 'Gửi đề xuất' }))
    expect(await screen.findByText('Nội dung không phù hợp', { exact: false })).toBeTruthy()
    expect(screen.queryByText('Đã gửi, chờ duyệt')).toBeNull()
  })

  // ---------------------------------------------------------------- AC-CONTRIB-13: chọn hai phần tử
  const optionNames = (): string[] => listOptions().map((o) => flat(o.textContent))
  const openForm = async (progress: (p: Progress) => void = withCafe): Promise<HTMLElement> => {
    await setup({ signedIn: true, progress })
    await mountReady()
    fireEvent.click(openButton())
    return region()
  }

  it('AC-CONTRIB-13: "Phần tử 1" và "Phần tử 2" là combobox có nhãn; focus hiện danh sách phần tử trong Đĩa (emoji và tên)', async () => {
    const panel = await openForm()
    expect(combo(panel, 'Phần tử 1')).toBeTruthy()
    expect(combo(panel, 'Phần tử 2')).toBeTruthy()
    fireEvent.focus(combo(panel, 'Phần tử 1'))
    await waitFor(() => expect(optionNames().length).toBeGreaterThan(0))
    const names = optionNames()
    expect(names.some((n) => /^\S*\s*Deadline$/.test(n)), names.join(' | ')).toBe(true)
    expect(names.some((n) => /^\S*\s*Cà Phê$/.test(n)), names.join(' | ')).toBe(true)
    expect(names.some((n) => n.startsWith('⏰')), 'mục có emoji').toBe(true)
  })

  it('AC-CONTRIB-13: gõ "dead" lọc danh sách theo fold (không phân biệt dấu và hoa thường): còn Deadline, mất Cười', async () => {
    const panel = await openForm()
    const box = combo(panel, 'Phần tử 1')
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'dead' } })
    await waitFor(() => expect(optionNames().some((n) => /^\S*\s*Deadline$/.test(n))).toBe(true))
    expect(optionNames().some((n) => n.includes('Cười'))).toBe(false)
    fireEvent.change(box, { target: { value: '  CA   PHE ' } })
    await waitFor(() => expect(optionNames().some((n) => /^\S*\s*Cà Phê$/.test(n))).toBe(true))
    expect(optionNames().some((n) => n.includes('Cười'))).toBe(false)
    fireEvent.change(box, { target: { value: 'CUOI' } })
    await waitFor(() => expect(optionNames().some((n) => /^\S*\s*Cười$/.test(n))).toBe(true))
    expect(optionNames().some((n) => n.includes('Deadline'))).toBe(false)
  })

  it('AC-CONTRIB-13: gõ "dead" rồi bấm "Deadline" trong danh sách thì ô hiện emoji và tên, có nút bỏ chọn; bấm nút thì ô trống lại', async () => {
    const panel = await openForm()
    await choose(panel, 'Phần tử 1', 'Deadline')
    const text = fieldText(panel, 'Phần tử 1')
    expect(text).toContain('Deadline')
    expect(text).toContain('⏰')
    expect(clearButton(panel, 'Phần tử 2')).toBeNull()
    fireEvent.click(clearButton(panel, 'Phần tử 1')!)
    await waitFor(() => expect(clearButton(panel, 'Phần tử 1')).toBeNull())
  })

  it('AC-CONTRIB-13: chọn bằng bàn phím: gõ rồi ArrowDown + Enter chọn mục đầu tiên của danh sách', async () => {
    const panel = await openForm()
    const box = combo(panel, 'Phần tử 1')
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'TOA' } }) // chỉ khớp "Toang"
    await waitFor(() => expect(optionNames()).toHaveLength(1))
    fireEvent.keyDown(box, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(clearButton(panel, 'Phần tử 1')).toBeTruthy())
    const text = fieldText(panel, 'Phần tử 1')
    expect(text).toContain('Toang')
    expect(text).toContain('💀')
  })

  it('AC-CONTRIB-13: kéo "Cà Phê" từ Đĩa thả vào ô "Phần tử 2" thì chọn nó; món không vào nồi và không lên bàn', async () => {
    const panel = await openForm()
    const tablesBefore = tableItems().length
    await dragOnto(plateItem('Cà Phê'), combo(panel, 'Phần tử 2'))
    await waitFor(() => expect(clearButton(panel, 'Phần tử 2')).toBeTruthy())
    const text = fieldText(panel, 'Phần tử 2')
    expect(text).toContain('Cà Phê')
    expect(text).toContain('🫖')
    expect(clearButton(panel, 'Phần tử 1')).toBeNull()
    expect(pot().dataset.state).toBe('idle')
    expect(slot(1).textContent ?? '').not.toContain('Cà Phê')
    expect(slot(2).textContent ?? '').not.toContain('Cà Phê')
    expect(tableItems()).toHaveLength(tablesBefore)
    expect(plateItem('Cà Phê')).toBeTruthy()
  })

  it('AC-CONTRIB-13: kéo "Deadline" từ bàn thả vào ô "Phần tử 2" thì chọn nó, món vẫn ở trên bàn, không vào nồi', async () => {
    const panel = await openForm((p) => {
      withCafe(p)
      p.table = [{ uid: 't1', id: eid('Deadline'), name: 'Deadline', emoji: '⏰', x: 40, y: 50 }]
    })
    const onTable = (): HTMLElement | undefined => tableItems().find((e) => e.dataset.name === 'Deadline')
    expect(onTable()).toBeTruthy()
    await dragOnto(onTable()!, combo(panel, 'Phần tử 2'))
    await waitFor(() => expect(clearButton(panel, 'Phần tử 2')).toBeTruthy())
    expect(fieldText(panel, 'Phần tử 2')).toContain('Deadline')
    expect(onTable(), 'món phải còn trên bàn').toBeTruthy()
    expect(tableItems()).toHaveLength(1)
    expect(pot().dataset.state).toBe('idle')
    expect(slot(1).textContent ?? '').not.toContain('Deadline')
    expect(slot(2).textContent ?? '').not.toContain('Deadline')
  })

  it('AC-CONTRIB-13: gõ tên không có trong Đĩa thì ô vẫn trống, "Gửi đề xuất" báo cần chọn phần tử và không gửi POST', async () => {
    const panel = await openForm()
    await choose(panel, 'Phần tử 2', 'Deadline')
    const box = combo(panel, 'Phần tử 1')
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'Tên Không Có Trong Đĩa' } })
    await advance(100)
    expect(optionNames().some((n) => n.includes('Tên Không Có'))).toBe(false)
    fireEvent.blur(box)
    expect(clearButton(panel, 'Phần tử 1'), 'gõ tên lạ không được coi là đã chọn').toBeNull()
    fill(panel, 'Tên meme', 'Meme Thiếu Phần Tử')
    fireEvent.click(within(panel).getByRole('button', { name: 'Gửi đề xuất' }))
    expect((await screen.findAllByText(/chọn.*phần tử|phần tử.*chọn/i)).length).toBeGreaterThan(0)
    await advance(300)
    expect(submits()).toEqual([])
    expect(screen.queryByText('Đã gửi, chờ duyệt')).toBeNull()
  })

  it('AC-CONTRIB-13: chưa chọn gì mà bấm "Gửi đề xuất" cũng báo cần chọn phần tử, không gửi POST', async () => {
    const panel = await openForm()
    fill(panel, 'Tên meme', 'Meme Rỗng')
    fireEvent.click(within(panel).getByRole('button', { name: 'Gửi đề xuất' }))
    expect((await screen.findAllByText(/chọn.*phần tử|phần tử.*chọn/i)).length).toBeGreaterThan(0)
    await advance(300)
    expect(submits()).toEqual([])
  })

  it('AC-CONTRIB-13: thân POST vẫn là tên hai phần tử {a, b, name} khi chọn ô 1 bằng chuột và ô 2 bằng kéo thả', async () => {
    const panel = await openForm()
    await choose(panel, 'Phần tử 1', 'Deadline')
    await dragOnto(plateItem('Cà Phê'), combo(panel, 'Phần tử 2'))
    await waitFor(() => expect(clearButton(panel, 'Phần tử 2')).toBeTruthy())
    fill(panel, 'Tên meme', 'Cà Phê Thức Khuya')
    fireEvent.click(within(panel).getByRole('button', { name: 'Gửi đề xuất' }))
    await waitFor(() => expect(submits()).toHaveLength(1))
    expect(JSON.parse(submits()[0]!.body!)).toEqual({ a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Thức Khuya' })
    expect(await screen.findByText('Đã gửi, chờ duyệt')).toBeTruthy()
  })

  it('AC-CONTRIB-06: mục "Đề xuất của tôi" liệt kê tên, biểu tượng, cặp "A + B", nhãn trạng thái và lý do từ chối của từng đề xuất', async () => {
    await setup({ signedIn: true })
    mine = [
      { ...MINE_BASE, id: '00000000-0000-4000-8000-000000000003', name: 'Mới Nhất Bị Loại', emoji: null, a: ref('Cười', '😂'), b: ref('Toang', '💀'), status: 'rejected', reject_reason: 'Trùng ý với Stonks' },
      { ...MINE_BASE, id: '00000000-0000-4000-8000-000000000002', name: 'Ở Giữa Chờ Duyệt', emoji: '☕', status: 'pending' },
      { ...MINE_BASE, id: '00000000-0000-4000-8000-000000000001', name: 'Cũ Nhất Đã Duyệt', emoji: '🔥', a: ref('Cay', '🌶️'), b: ref('Toang', '💀'), status: 'approved' },
    ]
    await mountReady()
    fireEvent.click(openButton())
    const panel = await region()
    expect(within(panel).getByRole('heading', { name: 'Đề xuất của tôi' })).toBeTruthy()
    await within(panel).findByText('Mới Nhất Bị Loại', { exact: false })
    expect(calls().some((c) => c.method === 'GET' && c.path.endsWith('/me/contributions'))).toBe(true)

    const names = mine.map((m) => m.name)
    const boxOf = (name: string): string => {
      const leaf = Array.from(panel.querySelectorAll<HTMLElement>('*')).find((e) => e.children.length === 0 && (e.textContent ?? '').includes(name))
      expect(leaf, `thiếu đề xuất "${name}"`).toBeTruthy()
      let el = leaf as HTMLElement
      while (el.parentElement && el.parentElement !== panel) {
        const parent = el.parentElement
        if (names.some((o) => o !== name && (parent.textContent ?? '').includes(o))) break
        el = parent
      }
      return el.textContent ?? ''
    }
    const rejected = boxOf('Mới Nhất Bị Loại')
    expect(rejected).toContain('Cười + Toang')
    expect(rejected).toContain('Bị từ chối')
    expect(rejected).toContain('Trùng ý với Stonks')
    expect(rejected).not.toContain('null')
    const pending = boxOf('Ở Giữa Chờ Duyệt')
    expect(pending).toContain('☕')
    expect(pending).toContain('Deadline + Cà Phê')
    expect(pending).toContain('Chờ duyệt')
    expect(pending).not.toContain('Trùng ý với Stonks')
    const approved = boxOf('Cũ Nhất Đã Duyệt')
    expect(approved).toContain('🔥')
    expect(approved).toContain('Cay + Toang')
    expect(approved).toContain('Đã duyệt')
    expect(approved).not.toContain('Trùng ý với Stonks')
  })

  it('AC-CONTRIB-06: chưa có đề xuất nào thì hiện "Bạn chưa đóng góp meme nào"', async () => {
    await setup({ signedIn: true })
    await mountReady()
    fireEvent.click(openButton())
    const panel = await region()
    expect(await within(panel).findByText('Bạn chưa đóng góp meme nào')).toBeTruthy()
  })
})

// ================================================================ AC-CONTRIB-11: thẻ "Cống hiến"
describe('contrib ui: thẻ Cống hiến của bảng xếp hạng', () => {
  const norm = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim()
  const stripMedal = (s: string): string => s.replace(/^[🥇🥈🥉]\s*/u, '')
  const hasText = (re: RegExp): boolean => Array.from(document.body.querySelectorAll('*')).some((e) => re.test(norm(e.textContent)))
  const rowsNow = (): Array<{ el: HTMLElement; text: string }> =>
    screen.queryAllByRole('listitem').map((el) => ({ el, text: norm(el.textContent) })).filter((r) => /#\d+/.test(r.text))
  const openContribTab = async (): Promise<void> => {
    render(<Leaderboards version={VERSION} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Cống hiến' }))
    await waitFor(() => expect(boardGets().length).toBeGreaterThanOrEqual(1))
  }

  beforeEach(async () => {
    await installNet()
    act(() => setCurrentSession(null))
  })

  it('AC-CONTRIB-11: có 4 thẻ theo thứ tự "Mẻ này", "Tuần", "Tháng", "Cống hiến"; bấm "Cống hiến" gọi GET api/contributors/leaderboard và chọn thẻ đó', async () => {
    render(<Leaderboards version={VERSION} />)
    await screen.findByRole('tab', { name: 'Mẻ này' })
    expect(screen.getAllByRole('tab').map((t) => norm(t.textContent))).toEqual(['Mẻ này', 'Tuần', 'Tháng', 'Cống hiến'])
    fireEvent.click(screen.getByRole('tab', { name: 'Cống hiến' }))
    await waitFor(() => expect(boardGets().length).toBeGreaterThanOrEqual(1))
    expect(screen.getByRole('tab', { name: 'Cống hiến' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Mẻ này' }).getAttribute('aria-selected')).toBe('false')
  })

  it('AC-CONTRIB-11: mỗi dòng "#<hạng> <nickname> - <số> meme", huy chương 🥇🥈🥉 cho hạng 1-3 và không có cho hạng 4', async () => {
    contribBoard = () =>
      json({
        rows: [
          { rank: 1, nickname: 'Bếp A', approved: 5 },
          { rank: 2, nickname: 'Thực khách ẩn danh', approved: 5 },
          { rank: 3, nickname: 'Bếp C', approved: 2 },
          { rank: 4, nickname: 'Bếp D', approved: 1 },
        ],
        me: null,
      })
    await openContribTab()
    await waitFor(() => expect(rowsNow()).toHaveLength(4))
    const rows = rowsNow()
    expect(rows.map((r) => stripMedal(r.text))).toEqual(['#1 Bếp A - 5 meme', '#2 Thực khách ẩn danh - 5 meme', '#3 Bếp C - 2 meme', '#4 Bếp D - 1 meme'])
    expect(rows[0]!.text).toContain('🥇')
    expect(rows[1]!.text).toContain('🥈')
    expect(rows[2]!.text).toContain('🥉')
    expect(rows[3]!.text).not.toMatch(/[🥇🥈🥉]/u)
    expect(hasText(/^Bạn: /)).toBe(false)
  })

  it('AC-CONTRIB-11: dòng của mình (hạng = me.rank) có aria-current="true", các dòng khác thì không', async () => {
    contribBoard = () =>
      json({
        rows: [
          { rank: 1, nickname: 'Bếp A', approved: 5 },
          { rank: 2, nickname: 'Tôi', approved: 3 },
          { rank: 3, nickname: 'Bếp C', approved: 2 },
        ],
        me: { rank: 2, nickname: 'Tôi', approved: 3 },
      })
    await openContribTab()
    await waitFor(() => expect(rowsNow()).toHaveLength(3))
    const current = rowsNow().filter((r) => r.el.getAttribute('aria-current') === 'true')
    expect(current.map((r) => stripMedal(r.text))).toEqual(['#2 Tôi - 3 meme'])
    expect(hasText(/^Bạn: /)).toBe(false)
  })

  it('AC-CONTRIB-11: hạng của mình ngoài top 20 thì thêm dòng bắt đầu "Bạn: " kèm hạng, nickname và số meme', async () => {
    contribBoard = () =>
      json({
        rows: [{ rank: 1, nickname: 'Bếp A', approved: 5 }],
        me: { rank: 25, nickname: 'Tôi', approved: 1 },
      })
    await openContribTab()
    await waitFor(() => expect(hasText(/^Bạn: /)).toBe(true))
    const mineRow = Array.from(document.body.querySelectorAll('*'))
      .map((e) => norm(e.textContent))
      .find((t) => /^Bạn: /.test(t) && !t.includes('Bếp A'))
    expect(mineRow).toMatch(/#25/)
    expect(mineRow).toContain('Tôi')
    expect(mineRow).toMatch(/1 meme/)
  })

  it('AC-CONTRIB-11: bảng rỗng và me null thì hiện "Chưa có meme đóng góp nào được duyệt"', async () => {
    contribBoard = () => json({ rows: [], me: null })
    await openContribTab()
    await waitFor(() => expect(hasText(/^Chưa có meme đóng góp nào được duyệt$/)).toBe(true))
    expect(rowsNow()).toHaveLength(0)
  })
})
