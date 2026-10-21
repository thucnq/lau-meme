// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/art.md, phần web: AC-ART-06, AC-ART-07, AC-ART-08.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (qua <Game /> không props, như Game.test.tsx)
 *   Ảnh trên Đĩa    mỗi plate-item luôn có emoji (chữ) ngay từ đầu. Phần tử có image_key (Item.image_key, lấy từ graph)
 *                   thì trong plate-item có một <img src="/lau-meme/img/<image_key>"> (chưa tải xong thì emoji vẫn hiện);
 *                   sự kiện `load` => emoji bị gỡ khỏi plate-item, <img> ở lại; sự kiện `error` => <img> bị gỡ khỏi DOM
 *                   (không có biểu tượng ảnh vỡ), emoji ở lại, không đặt lại src (không thử lại).
 *   Ảnh bị chặn     id phần tử nằm trong `images` của danh sách chặn (laumeme:blocklist hoặc GET /blocklist) =>
 *                   không có <img> nào, không gán src /img/..., không fetch /img/...; chỉ emoji.
 *   Phóng lớn       lần khám phá đầu (phần tử chưa có trong Đĩa) => [data-testid="discovery-zoom"]:
 *                     - chứa tên phần tử và emoji; nếu có image_key và không bị chặn thì có <img src=/lau-meme/img/...>;
 *                       ảnh chưa tải xong hoặc lỗi => emoji hiện; `load` => emoji gỡ khỏi lớp phủ, ảnh hiện
 *                     - data-motion="bounce"; khi prefers-reduced-motion: reduce => data-motion="static"
 *                     - tự gỡ sau 2500 ms; bấm vào lớp phủ hoặc phím Escape gỡ ngay
 *                     - không modal: không aria-modal, không role=dialog, không khóa Đĩa/Nồi
 *                     - có vùng aria-live (hoặc role=status) chứa tên phần tử
 *                     - cũng hiện khi ghép qua bàn thử thách (Daily), không đổi số bước
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialProgress, saveProgress } from '../game/engine'
import type { Item, Manifest, Progress } from '../game/engine'
import { Game } from '../game/Game'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7
const BLOCK_KEY = 'laumeme:blocklist'

const C = 'Tới Công Chuyện' // Cay + Cười, 🔥, có ảnh
const C_KEY = 'aaaaaaaaaaaa.webp'
const D = 'Lẩu Thập Cẩm' // Cay + Toang, 🥣, không ảnh
const H = 'Cơm Cháy' // Cay + Deadline, 🍚, dùng cho bàn thử thách
const H_KEY = 'bbbbbbbbbbbb.webp'
const SPECS = [
  { a: 'Cay', b: 'Cười', name: C, emoji: '🔥', image_key: C_KEY as string | null },
  { a: 'Cay', b: 'Toang', name: D, emoji: '🥣', image_key: null },
  { a: 'Cay', b: 'Deadline', name: H, emoji: '🍚', image_key: H_KEY as string | null },
]
const IMG_URL = (key: string) => `/lau-meme/img/${key}`

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
    daily: { element_id: eid('Stonks'), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    policy_version: 1,
  } as Manifest
}

async function buildGraph(): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of SPECS) {
    const plain: GraphResult = { added_version: VERSION, depth: 1, emoji: s.emoji, id: eid(s.name), image_key: s.image_key, name: s.name }
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

type Blocklist = { elements: string[]; recipes: string[]; images: string[] }
let fetchMock: ReturnType<typeof vi.fn>
let blocklistReply: () => Response

async function installNet(): Promise<void> {
  const manifest = manifestOf()
  const graph = await buildGraph()
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes('/manifest')) return json(manifest)
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return blocklistReply()
    if (url.includes('/health')) return json({ status: 'ok', env: 'test', schema: '1' })
    if (url.includes('/api/discoveries')) return json({ items: [] })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const fetchedImgUrls = () => fetchMock.mock.calls.map((c) => urlOf(c[0] as RequestInfo)).filter((u) => u.includes('/img/'))

// Ghi lại mọi lần gán src cho <img> (setter và setAttribute): phát hiện yêu cầu ảnh dù không đi qua fetch.
let srcSets: string[] = []
const originalSetAttribute = Element.prototype.setAttribute
const originalSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
function recordImgSrc(): void {
  srcSets = []
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (this instanceof HTMLImageElement && name.toLowerCase() === 'src') srcSets.push(String(value))
    return originalSetAttribute.call(this, name, value)
  }
  if (originalSrc?.get && originalSrc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get: originalSrc.get,
      set(this: HTMLImageElement, v: string) {
        srcSets.push(String(v))
        originalSrc.set!.call(this, v)
      },
    })
  }
}
function restoreImgSrc(): void {
  Element.prototype.setAttribute = originalSetAttribute
  if (originalSrc) Object.defineProperty(HTMLImageElement.prototype, 'src', originalSrc)
}
const srcSetsFor = (key: string) => srcSets.filter((s) => s.includes(key))

let reducedMotion = false
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
const plateNames = (): string[] => within(plateEl()).queryAllByTestId('plate-item').map((e) => (e as HTMLElement).dataset.name ?? '')
const plateItem = (name: string): HTMLElement => {
  const el = within(plateEl()).queryAllByTestId('plate-item').find((e) => (e as HTMLElement).dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa: ${plateNames().join(', ')}`)
  return el as HTMLElement
}
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')
async function potCombine(a: string, b: string): Promise<void> {
  drag(plateItem(a), slot(1))
  drag(plateItem(b), slot(2))
  await advance(1300)
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
const zoom = (): HTMLElement | null => screen.queryByTestId('discovery-zoom')
const imgIn = (el: Element): HTMLImageElement | null => el.querySelector('img')

function seed(mutate: (p: Progress) => void = () => {}): void {
  const p = initialProgress(manifestOf(), T0)
  p.tutorial_seen = true
  mutate(p)
  saveProgress(localStorage, p)
}
function owned(name: string, emoji: string, image_key: string | null): Item {
  return { id: eid(name), name, emoji, depth: 1, added_version: VERSION, image_key, discovered_at: '2026-10-01T00:00:00.000Z' }
}
const ownedC = () => seed((p) => p.items.push(owned(C, '🔥', C_KEY)))
const setBlocked = (images: string[]) => {
  const list: Blocklist = { elements: [], recipes: [], images }
  localStorage.setItem(BLOCK_KEY, JSON.stringify(list))
  blocklistReply = () => json(list)
}
async function mountGame(): Promise<void> {
  await installNet()
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
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
  reducedMotion = false
  blocklistReply = () => json({ elements: [], recipes: [], images: [] })
  recordImgSrc()
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: reducedMotion && q.includes('prefers-reduced-motion'),
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
  restoreImgSrc()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ AC-ART-06
describe('art: emoji trước, ảnh sau', () => {
  it('AC-ART-06: phần tử có khóa ảnh hiện emoji ngay, kèm <img> trỏ tới /lau-meme/img/<khóa>', async () => {
    ownedC()
    await mountGame()
    const item = plateItem(C)
    expect(item.textContent).toContain('🔥')
    const img = imgIn(item)
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(IMG_URL(C_KEY))
  })

  it('AC-ART-06: ảnh tải xong thì thay emoji (emoji gỡ khỏi phần tử, ảnh ở lại)', async () => {
    ownedC()
    await mountGame()
    const item = plateItem(C)
    fireEvent.load(imgIn(item)!)
    await waitFor(() => expect(item.textContent).not.toContain('🔥'))
    expect(imgIn(item)).not.toBeNull()
    expect(imgIn(item)!.getAttribute('src')).toBe(IMG_URL(C_KEY))
  })

  it('AC-ART-06: ảnh tải lỗi thì giữ emoji, không còn <img> (không biểu tượng ảnh vỡ), không thử lại liên tục', async () => {
    ownedC()
    await mountGame()
    const item = plateItem(C)
    fireEvent.error(imgIn(item)!)
    await waitFor(() => expect(imgIn(item)).toBeNull())
    expect(item.textContent).toContain('🔥')

    await advance(60_000)
    expect(imgIn(plateItem(C))).toBeNull()
    expect(plateItem(C).textContent).toContain('🔥')
    expect(srcSetsFor(C_KEY)).toHaveLength(1) // chỉ lần tải đầu, không đặt lại src
    expect(fetchedImgUrls()).toEqual([])
  })

  it('AC-ART-06: phần tử không có khóa ảnh chỉ có emoji, không có <img>', async () => {
    seed((p) => p.items.push(owned(D, '🥣', null)))
    await mountGame()
    expect(plateItem(D).textContent).toContain('🥣')
    expect(imgIn(plateItem(D))).toBeNull()
    expect(srcSets.filter((s) => s.includes('/img/'))).toEqual([])
  })

  it('AC-ART-06: phần tử khởi đầu (không ảnh) vẫn chỉ hiện emoji sau khi một phần tử khác lỗi ảnh', async () => {
    ownedC()
    await mountGame()
    fireEvent.error(imgIn(plateItem(C))!)
    await waitFor(() => expect(imgIn(plateItem(C))).toBeNull())
    expect(plateItem('Cay').textContent).toContain('🌶️')
    expect(imgIn(plateItem('Cay'))).toBeNull()
  })
})

// ================================================================ AC-ART-07
describe('art: ảnh bị chặn không được tải', () => {
  it('AC-ART-07: id phần tử có trong images của danh sách chặn thì chỉ hiện emoji, không <img>, không yêu cầu /img/...', async () => {
    ownedC()
    setBlocked([eid(C)])
    await mountGame()
    await waitFor(() => expect(localStorage.getItem(BLOCK_KEY)).toContain(eid(C)))
    await advance(1000)
    const item = plateItem(C)
    expect(item.textContent).toContain('🔥')
    expect(imgIn(item)).toBeNull()
    expect(srcSetsFor(C_KEY)).toEqual([])
    expect(fetchedImgUrls()).toEqual([])
  })

  it('AC-ART-07: danh sách chặn chỉ có từ mạng (chưa lưu) thì sau khi tải, ảnh bị chặn biến khỏi DOM và emoji ở lại', async () => {
    ownedC()
    blocklistReply = () => json({ elements: [], recipes: [], images: [eid(C)] })
    await mountGame()
    await waitFor(() => expect(imgIn(plateItem(C))).toBeNull())
    expect(plateItem(C).textContent).toContain('🔥')
    expect(fetchedImgUrls()).toEqual([])
  })

  it('AC-ART-07: chỉ ảnh của P bị chặn; phần tử khác có ảnh vẫn tải bình thường; phần tử P vẫn ở trên Đĩa (chặn ảnh khác chặn phần tử)', async () => {
    seed((p) => {
      p.items.push(owned(C, '🔥', C_KEY))
      p.items.push(owned(H, '🍚', H_KEY))
    })
    setBlocked([eid(C)])
    await mountGame()
    await advance(1000)
    expect(plateNames()).toContain(C)
    expect(imgIn(plateItem(C))).toBeNull()
    expect(imgIn(plateItem(H))).not.toBeNull()
    expect(imgIn(plateItem(H))!.getAttribute('src')).toBe(IMG_URL(H_KEY))
    expect(srcSetsFor(C_KEY)).toEqual([])
  })
})

// ================================================================ AC-ART-08
describe('art: phóng lớn khi ghép ra món lần đầu', () => {
  it('AC-ART-08: ghép ra phần tử chưa có thì lớp phủ hiện tên, emoji (ảnh chưa tải) và hiệu ứng bật ra', async () => {
    await mountGame()
    await potCombine('Cay', 'Cười')
    const overlay = await screen.findByTestId('discovery-zoom')
    expect(overlay.textContent).toContain(C)
    expect(overlay.textContent).toContain('🔥')
    expect(overlay.dataset.motion).toBe('bounce')
    expect(overlay.getAttribute('aria-modal')).not.toBe('true')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('AC-ART-08: phần tử có ảnh thì lớp phủ có <img> trỏ tới ảnh; tải xong thì ảnh thay emoji', async () => {
    await mountGame()
    await potCombine('Cay', 'Cười')
    const overlay = await screen.findByTestId('discovery-zoom')
    const img = imgIn(overlay)
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(IMG_URL(C_KEY))
    expect(overlay.textContent).toContain('🔥') // chưa tải xong
    fireEvent.load(img!)
    await waitFor(() => expect(overlay.textContent).not.toContain('🔥'))
    expect(overlay.textContent).toContain(C)
  })

  it('AC-ART-08: ảnh tải lỗi thì lớp phủ giữ emoji, không có <img>', async () => {
    await mountGame()
    await potCombine('Cay', 'Cười')
    const overlay = await screen.findByTestId('discovery-zoom')
    fireEvent.error(imgIn(overlay)!)
    await waitFor(() => expect(imgIn(overlay)).toBeNull())
    expect(overlay.textContent).toContain('🔥')
    expect(overlay.textContent).toContain(C)
  })

  it('AC-ART-08: phần tử không có ảnh thì phóng lớn emoji với tên, không <img>', async () => {
    await mountGame()
    await potCombine('Cay', 'Toang')
    const overlay = await screen.findByTestId('discovery-zoom')
    expect(overlay.textContent).toContain(D)
    expect(overlay.textContent).toContain('🥣')
    expect(imgIn(overlay)).toBeNull()
  })

  it('AC-ART-08: ảnh bị chặn thì lớp phủ chỉ có emoji và tên, không yêu cầu ảnh (AC-ART-07)', async () => {
    setBlocked([eid(C)])
    await mountGame()
    await potCombine('Cay', 'Cười')
    const overlay = await screen.findByTestId('discovery-zoom')
    expect(overlay.textContent).toContain('🔥')
    expect(overlay.textContent).toContain(C)
    expect(imgIn(overlay)).toBeNull()
    expect(srcSetsFor(C_KEY)).toEqual([])
    expect(fetchedImgUrls()).toEqual([])
  })

  it('AC-ART-08: tự thu về sau 2,5 s (chưa tới thì còn, quá thì mất)', async () => {
    await mountGame()
    await potCombine('Cay', 'Toang')
    await screen.findByTestId('discovery-zoom')
    await advance(1500)
    expect(zoom()).not.toBeNull()
    await advance(1500)
    await waitFor(() => expect(zoom()).toBeNull())
  })

  it('AC-ART-08: bấm vào lớp phủ thì thu về ngay', async () => {
    await mountGame()
    await potCombine('Cay', 'Toang')
    fireEvent.click(await screen.findByTestId('discovery-zoom'))
    await waitFor(() => expect(zoom()).toBeNull())
  })

  it('AC-ART-08: nhấn Esc thì thu về ngay', async () => {
    await mountGame()
    await potCombine('Cay', 'Toang')
    await screen.findByTestId('discovery-zoom')
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(zoom()).toBeNull())
  })

  it('AC-ART-08: không chặn thao tác kéo thả tiếp - ghép thêm một món khi lớp phủ còn hiện, Đĩa/Nồi không bị khóa', async () => {
    await mountGame()
    await potCombine('Cay', 'Cười')
    await screen.findByTestId('discovery-zoom')
    expect(plateEl().closest('[inert]')).toBeNull()
    expect(plateEl().closest('[aria-hidden="true"]')).toBeNull()
    expect(pot().dataset.state).toBe('idle')

    await potCombine('Cay', 'Toang')
    expect(plateNames()).toEqual(expect.arrayContaining([C, D]))
    const overlay = await screen.findByTestId('discovery-zoom')
    expect(overlay.textContent).toContain(D)
  })

  it('AC-ART-08: ghép lại ra món đã có trong Đĩa thì không phóng lớn', async () => {
    ownedC()
    await mountGame()
    await potCombine('Cay', 'Cười')
    await advance(300)
    expect(zoom()).toBeNull()
  })

  it('AC-ART-08: ghép lần hai ra cùng món vừa khám phá thì không phóng lớn lại', async () => {
    await mountGame()
    await potCombine('Cay', 'Toang')
    fireEvent.click(await screen.findByTestId('discovery-zoom'))
    await waitFor(() => expect(zoom()).toBeNull())
    await potCombine('Cay', 'Toang')
    await advance(300)
    expect(zoom()).toBeNull()
  })

  it('AC-ART-08: prefers-reduced-motion thì lớp phủ hiện tĩnh, không hiệu ứng bật ra', async () => {
    reducedMotion = true
    await mountGame()
    await potCombine('Cay', 'Toang')
    const overlay = await screen.findByTestId('discovery-zoom')
    expect(overlay.dataset.motion).toBe('static')
    expect(overlay.textContent).toContain(D)
  })

  it('AC-ART-08: tên phần tử được đọc qua vùng aria-live', async () => {
    await mountGame()
    await potCombine('Cay', 'Toang')
    await screen.findByTestId('discovery-zoom')
    const live = Array.from(document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]'))
    expect(live.some((el) => (el.textContent ?? '').includes(D))).toBe(true)
  })

  it('AC-ART-08: chế độ Thử thách (Daily) cũng phóng lớn, không chặn thao tác và không đổi số bước (câu hỏi mở 31)', async () => {
    seed()
    await installNet()
    render(<Game />)
    await screen.findByRole('region', { name: 'Món đặc biệt hôm nay' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: /thử thách/i }))
    const board = await screen.findByRole('region', { name: 'Bàn thử thách' })
    const ch = (label: string) => within(board).getByRole('button', { name: label })
    const steps = () => Number(/Bước: (\d+)/.exec(board.textContent ?? '')![1])

    fireEvent.click(ch('🌶️ Cay'))
    fireEvent.click(ch('⏰ Deadline'))
    await waitFor(() => expect(pot().dataset.state).toBe('boiling'), { timeout: 3000 })
    await advance(1100)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 3000 })

    const overlay = await screen.findByTestId('discovery-zoom')
    expect(overlay.textContent).toContain(H)
    expect(steps()).toBe(1)

    // không chặn: đặt tiếp một phần tử vào nồi khi lớp phủ còn hiện
    fireEvent.click(ch('🌶️ Cay'))
    expect(slot(1).textContent ?? '').toContain('Cay')
    expect(steps()).toBe(1)
  })
})
