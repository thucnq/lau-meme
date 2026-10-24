/**
 * UI3 layout acceptance tests in real Chromium (Vitest browser mode + Playwright), as AC-GAME-18/19/20:
 * AC-GAME-22 (vùng cấm đặt món), AC-GAME-23 (Đĩa nhúng cao bằng bàn, thanh cuộn mỏng), AC-GAME-25 (hiệu ứng không chặn chuột).
 * AC-GAME-18 (cập nhật 2026-10-24) lives in Game.browser.test.tsx. The jsdom ACs (24, 25, 26) live in ui3.ui.test.tsx.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (data-testid hooks for geometry, on top of the ui2 hooks:
 * pot, pot-slot-1/2, table, plate-item, table-item, miss-line, miss-hint, discovery-zoom)
 *   table-tools   the row holding "Dọn bàn" and "?" (and the speaker button of AC-GAME-26 when it sits there). Always present.
 *                 Its bounding box is a forbidden zone (PC: top-right corner of the table; mobile: the row right above it).
 *   miss-area     wrapper of [data-testid="miss-line"] and, when there is one, [data-testid="miss-hint"]. Present only while a
 *                 miss line is showing. Its bounding box is a forbidden zone.
 *   touch-hint    the hint "Giữ món để kéo, vuốt chỗ trống để cuộn" (AC-GAME-21), present while it shows. Forbidden zone.
 *                 It shows when matchMedia('(pointer: coarse)') matches (this file sets that, and navigator.maxTouchPoints) and
 *                 it hides after the first successful drop (AC-GAME-21).
 *   plate-panel   the whole plate region: search box, sort select and the list (role "list" "Đĩa nhúng"). One ancestor of the
 *                 list inside it (or the list itself) has overflow-y auto/scroll and is the scroll container.
 *   celebrate     the effect layer of AC-GAME-25 (attributes as in ui3.ui.test.tsx); computed pointer-events must be "none".
 * Theme is read from document.documentElement.dataset.theme ('light' | 'dark').
 * Progress is seeded in localStorage with tutorial_seen = true, so no tutorial dialog opens.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { fold } from '../graph/crypto'
import { initialProgress, saveProgress } from './engine'
import type { Manifest, Progress } from './engine'
import { Game } from './Game'

// ---------------------------------------------------------------- fixtures (graph encrypted with WebCrypto, ADR 0002)
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const sha = async (s: string): Promise<string> => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
const eid = (name: string): Promise<string> => sha('lm1|e|' + fold(name))
const VERSION = 7
const HIT = 'Tới Công Chuyện' // Cay + Cười, tier 4

async function buildGraph(): Promise<unknown> {
  const [x, y] = [fold('Cay'), fold('Cười')].sort()
  const key = await sha('lm1|k|' + x + '\0' + y)
  const plain = { added_version: VERSION, depth: 1, emoji: '🔥', id: await eid(HIT), image_key: null, name: HIT, tier: 4 }
  const ikm = await crypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + VERSION), info: enc.encode('lm1|aes-gcm') },
      ikm,
      44 * 8,
    ),
  )
  const aes = await crypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt'])
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) }, aes, enc.encode(JSON.stringify(plain)))
  return { format: 1, version: VERSION, entries: { [key]: b64u(new Uint8Array(ct)) } }
}

/** Most recent 05:00 or 17:00 UTC mark before now, so the next batch is always in the future. */
function recentBatchMark(): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5))
  const marks = [-12, 0, 12, 24].map((h) => d.getTime() + h * 3_600_000).filter((t) => t < now.getTime())
  return new Date(Math.max(...marks)).toISOString()
}

async function manifestOf(): Promise<Manifest> {
  return {
    version: VERSION,
    batch_at: recentBatchMark(),
    graph_url: `/api/graph/${VERSION}`,
    starters: [
      { id: await eid('Cay'), name: 'Cay', emoji: '🌶️' },
      { id: await eid('Cười'), name: 'Cười', emoji: '😂' },
      { id: await eid('Toang'), name: 'Toang', emoji: '💀' },
      { id: await eid('Deadline'), name: 'Deadline', emoji: '⏰' },
    ],
    miss_lines: ['Nồi trào rồi!'],
    daily: { element_id: await eid('Stonks'), emoji: '🍜', hint: 'gợi ý', depth: 4 },
    policy_version: 1,
  } as Manifest
}

const realMatchMedia = window.matchMedia.bind(window)
let manifest: Manifest

beforeEach(async () => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  manifest = await manifestOf()
  const graph = await buildGraph()
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/manifest')) return reply(manifest)
      if (url.includes('/api/graph/')) return reply(graph)
      if (url.endsWith('/api/blocklist')) return reply({ elements: [], recipes: [], images: [] })
      if (url.includes('/daily/') && url.endsWith('/leaderboard')) return reply({ version: VERSION, rows: [], me: null })
      if (url.includes('/daily/leaderboard')) return reply({ period: 'x', starts_at: '2026-10-18T17:00:00.000Z', ends_at: '2026-10-25T17:00:00.000Z', batches: 0, rows: [], me: null })
      return reply({ title: 'Not found' }, 404)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia })
  Reflect.deleteProperty(navigator, 'maxTouchPoints')
})

const VIEWPORTS = [
  { name: 'PC', width: 1366, height: 768 },
  { name: 'tablet ngang', width: 1024, height: 768 },
  { name: 'tablet dọc', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'mobile nhỏ', width: 360, height: 640 },
]
type Vp = { width: number; height: number }

// ---------------------------------------------------------------- environment helpers
function setTouch(on: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) =>
      on && /pointer:\s*coarse|hover:\s*none/.test(q)
        ? { matches: true, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }
        : realMatchMedia(q),
  })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: on ? 5 : 0 })
}

/** Seeds `extra` owned items besides the 4 starters (names "Món 001".."Món 120"), tutorial already seen. */
async function seedProgress(extra: number): Promise<void> {
  const p: Progress = initialProgress(manifest, new Date())
  p.tutorial_seen = true
  for (let i = 0; i < extra; i++) {
    const name = `Món ${String(i + 1).padStart(3, '0')}`
    p.items.push({
      id: await eid(name),
      name,
      emoji: '🍲',
      depth: 1 + (i % 7),
      added_version: 6,
      image_key: null,
      discovered_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
      tier: 1 + (i % 3),
    } as unknown as Progress['items'][number])
  }
  saveProgress(localStorage, p)
}

async function open(vp: Vp, o: { theme?: 'light' | 'dark'; extra?: number; touch?: boolean } = {}): Promise<void> {
  cleanup()
  localStorage.clear()
  await seedProgress(o.extra ?? 0)
  await page.viewport(vp.width, vp.height)
  if (o.theme) document.documentElement.dataset.theme = o.theme
  else delete document.documentElement.dataset.theme
  setTouch(o.touch ?? false)
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  await screen.findByRole('region', { name: 'Món đặc biệt hôm nay' })
  window.scrollTo(0, 0)
}

function drag(src: Element, dest: Element): void {
  const r = dest.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
  fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x / 2, clientY: y / 2 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x, clientY: y })
  fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: x, clientY: y })
}
const plateItem = (name: string): HTMLElement => {
  const el = screen.getAllByTestId('plate-item').find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
  return el
}
const tableItem = (name: string): HTMLElement => {
  const el = screen.getAllByTestId('table-item').find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trên bàn`)
  return el
}
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')

/** Real-time combine through the pot: waits for boiling to start and to end. */
async function combine(a: string, b: string): Promise<void> {
  drag(plateItem(a), slot(1))
  drag(plateItem(b), slot(2))
  await waitFor(() => expect(pot().dataset.state).toBe('boiling'), { timeout: 3000, interval: 20 })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 4000 })
}

const rect = (el: Element): DOMRect => el.getBoundingClientRect()
const inside = (inner: DOMRect, outer: DOMRect, tol = 1): boolean =>
  inner.top >= outer.top - tol && inner.left >= outer.left - tol && inner.bottom <= outer.bottom + tol && inner.right <= outer.right + tol
const overlap = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

// ================================================================ AC-GAME-22
interface Zone {
  name: string
  box: DOMRect
}
function captureZones(): Zone[] {
  const out: Zone[] = []
  for (const id of ['table-tools', 'miss-area', 'touch-hint']) {
    const el = screen.queryByTestId(id)
    if (!el) continue
    const box = rect(el)
    if (box.width * box.height > 0) out.push({ name: id, box })
  }
  return out
}
/** Every table item is fully inside the table and outside every zone. */
function expectClear(label: string, zones: Zone[] = captureZones()): void {
  const table = rect(screen.getByTestId('table'))
  for (const it of screen.queryAllByTestId('table-item')) {
    const r = rect(it)
    expect(r.width * r.height, `${label}: ${it.dataset.name} không có kích thước`).toBeGreaterThan(0)
    expect(inside(r, table), `${label}: ${it.dataset.name} ra ngoài mặt bàn`).toBe(true)
    for (const z of zones) expect(overlap(r, z.box), `${label}: ${it.dataset.name} đè lên vùng cấm ${z.name}`).toBe(false)
  }
}

describe.each([
  { name: 'PC', width: 1366, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
])('ui3 vùng cấm đặt món ($name $width×$height)', (vp) => {
  it(`AC-GAME-22: món thả vào vùng nút / gợi ý và món tự đặt sau ghép trượt, ghép trúng đều nằm ngoài vùng cấm, trong mặt bàn (${vp.name})`, async () => {
    await open(vp, { touch: true })
    const tools = screen.getByTestId('table-tools')
    expect(within(tools).getByRole('button', { name: 'Dọn bàn' })).toBeTruthy()
    expect(within(tools).getByRole('button', { name: '?' })).toBeTruthy()
    expect(captureZones().find((z) => z.name === 'table-tools'), 'vùng nút phải có kích thước').toBeTruthy()

    // B1: thả vào giữa gợi ý vuốt cuộn (lần thả thành công đầu tiên - gợi ý sẽ ẩn sau đó)
    const hint = await screen.findByTestId('touch-hint')
    const hintZones = captureZones()
    expect(hintZones.map((z) => z.name)).toContain('touch-hint')
    const tableBefore = rect(screen.getByTestId('table'))
    drag(plateItem('Toang'), hint)
    await waitFor(() => expect(screen.getAllByTestId('table-item')).toHaveLength(1))
    const tableAfter = rect(screen.getByTestId('table'))
    if (Math.abs(tableAfter.top - tableBefore.top) < 1 && Math.abs(tableAfter.height - tableBefore.height) < 1) expectClear('thả vào gợi ý', hintZones)
    expectClear('sau khi thả vào gợi ý')

    // B2: thả vào giữa hàng nút, từ Đĩa và từ trên bàn
    drag(plateItem('Deadline'), tools)
    await waitFor(() => expect(screen.getAllByTestId('table-item')).toHaveLength(2))
    expectClear('thả từ Đĩa vào hàng nút')
    drag(tableItem('Toang'), screen.getByTestId('table-tools'))
    expect(screen.getAllByTestId('table-item')).toHaveLength(2)
    expectClear('kéo món trên bàn vào hàng nút')

    // C: 3 lần ghép trượt liên tiếp, A và B tự trở lại bàn; sau lần 3 có gợi ý (AC-GAME-06)
    for (let i = 1; i <= 3; i++) {
      await combine('Toang', 'Deadline')
      const area = await screen.findByTestId('miss-area')
      expect(within(area).getByTestId('miss-line')).toBeTruthy()
      expectClear(`sau lần trượt ${i}`)
    }
    const area = screen.getByTestId('miss-area')
    expect(within(area).getByTestId('miss-hint')).toBeTruthy()
    expectClear('sau lần trượt 3 có gợi ý')

    // D: thả vào giữa vùng câu Nồi trào + gợi ý, từ Đĩa và từ trên bàn
    drag(plateItem('Cay'), area)
    expectClear('thả từ Đĩa vào vùng Nồi trào')
    drag(screen.getAllByTestId('table-item')[0]!, screen.getByTestId('miss-area'))
    expectClear('kéo món trên bàn vào vùng Nồi trào')

    // E: nút vẫn bấm được (không món nào đè lên nút)
    for (const name of ['Dọn bàn', '?']) {
      const b = within(screen.getByTestId('table-tools')).getByRole('button', { name })
      const r = rect(b)
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      expect(Boolean(top && b.contains(top)), `"${name}" bị che bởi ${top?.tagName}.${top?.className}`).toBe(true)
    }

    // F: ghép trúng đặt món mới lên bàn, vẫn tránh vùng cấm; sau đó nút vẫn bấm được
    await combine('Cay', 'Cười')
    expect(screen.getAllByTestId('table-item').map((e) => e.dataset.name)).toContain(HIT)
    expectClear('sau ghép trúng')
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('discovery-zoom')).toBeNull())
    for (const name of ['Dọn bàn', '?']) {
      const b = within(screen.getByTestId('table-tools')).getByRole('button', { name })
      const r = rect(b)
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      expect(Boolean(top && b.contains(top)), `"${name}" bị che sau ghép trúng`).toBe(true)
    }
  })
})

// ================================================================ AC-GAME-23
const allowsVerticalPan = (v: string): boolean => v !== 'none' && (v === 'auto' || v === 'manipulation' || v.split(/\s+/).includes('pan-y'))

function scrollerOf(): HTMLElement {
  const panel = screen.getByTestId('plate-panel')
  const list = screen.getByRole('list', { name: 'Đĩa nhúng' })
  for (let el: HTMLElement | null = list; el && panel.contains(el); el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY
    if (oy === 'auto' || oy === 'scroll') return el
  }
  throw new Error('Đĩa nhúng không có vùng cuộn bên trong (overflow-y auto/scroll)')
}
function metrics(): { panel: number; table: number; page: number } {
  return {
    panel: rect(screen.getByTestId('plate-panel')).height,
    table: rect(screen.getByTestId('table')).height,
    page: document.documentElement.scrollHeight,
  }
}
/** Authored thin scrollbar: `scrollbar-width: thin`, or a ::-webkit-scrollbar of 1-8 px. */
function authoredThin(el: HTMLElement): boolean {
  const cs = getComputedStyle(el)
  if (cs.scrollbarWidth === 'thin') return true
  const w = parseFloat(getComputedStyle(el, '::-webkit-scrollbar').width)
  return Number.isFinite(w) && w > 0 && w <= 8
}
const scrollbarSignature = (el: HTMLElement): string =>
  `${getComputedStyle(el).scrollbarColor}|${getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor}`

describe.each(['light', 'dark'] as const)('ui3 Đĩa nhúng cao bằng bàn lẩu (giao diện %s)', (theme) => {
  it.each(VIEWPORTS)(`AC-GAME-23: 120 phần tử - vùng Đĩa cao bằng mặt bàn, không đổi theo số phần tử, cuộn bên trong, thanh cuộn <= 8 px, giao diện ${theme} ($name $width×$height)`, async (vp) => {
    await open(vp, { theme, extra: 0 })
    const few = metrics()

    await open(vp, { theme, extra: 120 })
    expect(screen.getAllByTestId('plate-item').length).toBeGreaterThan(50)
    const many = metrics()
    const panel = screen.getByTestId('plate-panel')
    expect(within(panel).getByRole('searchbox', { name: 'Tìm trong Đĩa nhúng' })).toBeTruthy()
    expect(within(panel).getByRole('combobox', { name: 'Sắp xếp' })).toBeTruthy()
    expect(within(panel).getByRole('list', { name: 'Đĩa nhúng' })).toBeTruthy()

    expect(Math.abs(many.panel - many.table), `vùng Đĩa ${many.panel} px so với mặt bàn ${many.table} px`).toBeLessThanOrEqual(2)
    expect(Math.abs(many.panel - few.panel), 'chiều cao vùng Đĩa đổi theo số phần tử').toBeLessThanOrEqual(1)
    expect(Math.abs(many.page - few.page), 'trang dài thêm theo số phần tử').toBeLessThanOrEqual(1)

    // danh sách cuộn bên trong vùng đó
    const scroller = scrollerOf()
    expect(scroller.scrollHeight, 'danh sách phải dài hơn vùng nhìn thấy').toBeGreaterThan(scroller.clientHeight + 100)
    expect(rect(scroller).height).toBeLessThanOrEqual(many.panel + 1)

    // thanh cuộn mỏng, không bị ẩn
    const cs = getComputedStyle(scroller)
    const bar = scroller.offsetWidth - scroller.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)
    expect(bar, 'bề rộng thanh cuộn đo được').toBeLessThanOrEqual(8)
    expect(authoredThin(scroller), `scrollbar-width=${cs.scrollbarWidth}`).toBe(true)
    expect(cs.scrollbarWidth).not.toBe('none')
    expect(getComputedStyle(scroller, '::-webkit-scrollbar').display).not.toBe('none')

    // cuộn xong, vùng Đĩa vẫn cao bằng bàn
    scroller.scrollTop = 600
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0))
    expect(Math.abs(rect(panel).height - metrics().table)).toBeLessThanOrEqual(2)
    expect(Math.abs(document.documentElement.scrollHeight - many.page)).toBeLessThanOrEqual(1)

    // kéo món từ Đĩa đã cuộn vào nồi vẫn chạy như AC-GAME-02
    const s = rect(scroller)
    const visible = screen.getAllByTestId('plate-item').filter((e) => {
      const r = rect(e)
      return r.height > 0 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1
    })
    expect(visible.length).toBeGreaterThanOrEqual(2)
    const [a, b] = [visible[0]!, visible[1]!]
    drag(a, slot(1))
    expect(slot(1).textContent).toContain(a.dataset.name)
    drag(b, slot(2))
    expect(slot(2).textContent).toContain(b.dataset.name)
    await waitFor(() => expect(pot().dataset.state).toBe('boiling'), { timeout: 3000, interval: 20 })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 4000 })
  })
})

describe('ui3 thanh cuộn của Đĩa: màu theo giao diện, vuốt trên cảm ứng', () => {
  it('AC-GAME-23: màu thanh cuộn khác nhau giữa giao diện sáng và tối, đều được đặt rõ (không để mặc định)', async () => {
    const sig: Record<string, string> = {}
    for (const theme of ['light', 'dark'] as const) {
      await open({ width: 1366, height: 768 }, { theme, extra: 120 })
      sig[theme] = scrollbarSignature(scrollerOf())
      expect(sig[theme], `${theme}: thanh cuộn chưa đặt màu`).not.toBe('auto|rgba(0, 0, 0, 0)')
    }
    expect(sig.light).not.toBe(sig.dark)
  })

  it('AC-GAME-23: 390×844, vùng cuộn của Đĩa cho phép vuốt dọc (touch-action không phải none) và Đĩa nằm dưới nồi', async () => {
    await open({ width: 390, height: 844 }, { extra: 120, touch: true })
    const scroller = scrollerOf()
    expect(allowsVerticalPan(getComputedStyle(scroller).touchAction), `touch-action=${getComputedStyle(scroller).touchAction}`).toBe(true)
    expect(['auto', 'scroll']).toContain(getComputedStyle(scroller).overflowY)
    expect(rect(screen.getByTestId('plate-panel')).top).toBeGreaterThanOrEqual(rect(pot()).bottom - 1)
  })
})

// ================================================================ AC-GAME-25 (hiệu ứng không chặn chuột)
describe('ui3 hiệu ứng Vàng/Đỏ không chặn kéo thả (AC-GAME-25)', () => {
  it('AC-GAME-25: lớp hiệu ứng có pointer-events: none và không che chỗ thả của nồi', async () => {
    await open({ width: 1366, height: 768 })
    await combine('Cay', 'Cười')
    const c = await screen.findByTestId('celebrate', undefined, { timeout: 3000 })
    expect(c.dataset.kind).toBe('gold')
    expect(getComputedStyle(c).pointerEvents).toBe('none')
    for (const n of [1, 2] as const) {
      const r = rect(slot(n))
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      expect(Boolean(top && c.contains(top)), `lớp hiệu ứng che chỗ thả ${n}`).toBe(false)
    }
    // vẫn kéo thả tiếp được khi hiệu ứng còn hiện
    drag(plateItem('Toang'), slot(1))
    expect(slot(1).textContent).toContain('Toang')
  })
})
