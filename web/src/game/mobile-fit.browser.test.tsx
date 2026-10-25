/**
 * Cập nhật 2026-10-25 (góp ý) in real Chromium (Vitest browser mode + Playwright):
 *   - AC-GAME-27: 360 px, đã đăng nhập với nickname dài: không cuộn ngang, nickname cắt bằng "…", tên đầy đủ còn trong DOM
 *     (trình đọc màn hình) và ở thuộc tính title (rê chuột);
 *   - AC-TIER-02: viền phần tử (.chip) liền >= 1,5 px cùng màu viền hình nhỏ; lúc thường tối hơn --color-badge-ring;
 *     khi rê chuột cả hai bằng --color-badge-ring (trắng ở sáng, #f4eee8 ở tối);
 *   - AC-GAME-21: 390 px, món cho phép vuốt dọc (touch-action có pan-y) và danh sách Đĩa không chặn chuỗi cuộn sang trang.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (as tier.browser.test.tsx / ui3.browser.test.tsx)
 *   plate-item, table-item (the chip itself, carrying data-tier, or containing one [data-tier]), plate-panel,
 *   badge role="img" name "Tier <tên>" holding an <svg> whose shape (circle or polygon) carries the ring as CSS stroke.
 *   Signed in: GET /api/auth/session answers 200 with { nickname, created_at }; the account area shows
 *   "Đã đăng nhập: <nickname>".
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../index.css'
import { initialProgress, saveProgress } from './engine'
import type { Manifest, Progress } from './engine'
import { Game } from './Game'

const VERSION = 7
const NICK = 'Nguyễn Văn Lẩu Thủ Đại Vương Bếp Trưởng Ngàn Năm Nhúng Mãi Không Chán'
const ITEMS = ['Món Xám', 'Món Lá', 'Món Dương', 'Món Vàng', 'Món Đỏ']

const manifest = {
  version: VERSION,
  batch_at: new Date(Date.now() - 3_600_000).toISOString(),
  graph_url: `/api/graph/${VERSION}`,
  starters: [
    { id: 'cay', name: 'Cay', emoji: '🌶️' },
    { id: 'cuoi', name: 'Cười', emoji: '😂' },
    { id: 'toang', name: 'Toang', emoji: '💀' },
    { id: 'deadline', name: 'Deadline', emoji: '⏰' },
  ],
  miss_lines: ['Nồi trào rồi!'],
  daily: { element_id: 'x', emoji: '🍜', hint: 'gợi ý', depth: 4 },
  policy_version: 1,
} as Manifest

let signedIn = false
beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  signedIn = false
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/api/auth/session') && method === 'GET')
        return signedIn ? reply({ nickname: NICK, created_at: '2026-10-19T01:00:00.000Z' }) : reply({ title: 'Chưa đăng nhập', status: 401 }, 401)
      if (url.endsWith('/api/manifest')) return reply(manifest)
      if (url.includes('/api/graph/')) return reply({ format: 1, version: VERSION, entries: {} })
      if (url.endsWith('/api/blocklist')) return reply({ elements: [], recipes: [], images: [] })
      if (url.includes('/daily/') && url.endsWith('/leaderboard')) return reply({ version: VERSION, rows: [], me: null })
      if (url.includes('/daily/leaderboard')) return reply({ period: 'x', starts_at: '2026-10-18T17:00:00.000Z', ends_at: '2026-10-25T17:00:00.000Z', batches: 0, rows: [], me: null })
      return reply({ title: 'Not found' }, 404)
    }),
  )
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await page.viewport(1366, 768)
})

function seed(withTiers: boolean): void {
  const p: Progress = initialProgress(manifest, new Date())
  p.tutorial_seen = true
  if (withTiers)
    ITEMS.forEach((name, i) =>
      p.items.push({ id: `id-${i}`, name, emoji: '🍲', depth: 1, added_version: VERSION, image_key: null, discovered_at: '2026-10-01T00:00:00.000Z', tier: i + 1 } as unknown as Progress['items'][number]),
    )
  saveProgress(localStorage, p)
}

async function settled(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(r))
  await Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined)))
}

async function open(vp: { width: number; height: number }, theme: 'light' | 'dark' = 'light', withTiers = false): Promise<void> {
  cleanup()
  localStorage.clear()
  seed(withTiers)
  await page.viewport(vp.width, vp.height)
  document.documentElement.dataset.theme = theme
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  window.scrollTo(0, 0)
  await settled()
}

const rect = (el: Element): DOMRect => el.getBoundingClientRect()
const plateItem = (name: string): HTMLElement => {
  const el = screen.getAllByTestId('plate-item').find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
  return el
}
const allowsVerticalPan = (v: string): boolean => v !== 'none' && (v === 'auto' || v === 'manipulation' || v.split(/\s+/).includes('pan-y'))

// ---------------------------------------------------------------- colour maths (canvas resolves any CSS colour syntax)
type Rgb = [number, number, number]
const ctx2d = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 1
  return c.getContext('2d', { willReadFrequently: true })!
})()
function toRgb(css: string, under: Rgb = [255, 255, 255]): Rgb {
  ctx2d.clearRect(0, 0, 1, 1)
  ctx2d.fillStyle = `rgb(${under.join(',')})`
  ctx2d.fillRect(0, 0, 1, 1)
  ctx2d.fillStyle = css
  ctx2d.fillRect(0, 0, 1, 1)
  const d = ctx2d.getImageData(0, 0, 1, 1).data
  return [d[0]!, d[1]!, d[2]!]
}
const lum = ([r, g, b]: Rgb): number => {
  const f = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

// ================================================================ AC-GAME-27
describe.each(['light', 'dark'] as const)('mobile-fit: nickname dài ở 360 px (%s)', (theme) => {
  it(`AC-GAME-27: 360 px, đã đăng nhập với nickname dài - không cuộn ngang, nickname cắt bằng dấu "…", tên đầy đủ có cho trình đọc màn hình và khi rê chuột (${theme})`, async () => {
    signedIn = true
    await open({ width: 360, height: 640 }, theme)
    const header = screen.getByRole('banner')
    await waitFor(() => expect(header.textContent).toContain('Đã đăng nhập'))
    await settled()

    expect(document.documentElement.scrollWidth, 'cuộn ngang').toBeLessThanOrEqual(document.documentElement.clientWidth)
    expect(rect(header).right).toBeLessThanOrEqual(window.innerWidth + 0.5)
    expect(rect(header).left).toBeGreaterThanOrEqual(-0.5)

    // deepest element holding the nickname text
    const holders = Array.from(header.querySelectorAll<HTMLElement>('*')).filter((e) => (e.textContent ?? '').includes(NICK))
    const leaf = holders.find((e) => !Array.from(e.children).some((c) => (c.textContent ?? '').includes(NICK)))
    expect(leaf, 'tên đầy đủ phải còn trong DOM cho trình đọc màn hình').toBeTruthy()
    for (const e of [leaf!, ...holders]) expect(rect(e).right, 'phần tử tên tràn khỏi khung nhìn').toBeLessThanOrEqual(window.innerWidth + 0.5)

    // truncated with an ellipsis: some element on the chain (leaf up to header) clips with text-overflow: ellipsis
    const chain: HTMLElement[] = []
    for (let e: HTMLElement | null = leaf!; e && e !== header; e = e.parentElement) chain.push(e)
    const clip = chain.find((e) => getComputedStyle(e).textOverflow === 'ellipsis')
    expect(clip, 'thiếu text-overflow: ellipsis').toBeTruthy()
    expect(getComputedStyle(clip!).overflowX, 'ellipsis cần overflow ẩn').not.toBe('visible')
    expect(clip!.scrollWidth, 'nickname dài phải thực sự bị cắt').toBeGreaterThan(clip!.clientWidth)

    // full name on hover (title) or via an aria-label
    const named = chain.find((e) => (e.getAttribute('title') ?? '').includes(NICK) || (e.getAttribute('aria-label') ?? '').includes(NICK))
    const hoverTitle = [...chain, header].some((e) => (e.getAttribute('title') ?? '').includes(NICK))
    expect(hoverTitle, 'thiếu title có tên đầy đủ khi rê chuột').toBe(true)
    expect(named !== undefined || (leaf!.textContent ?? '').includes(NICK)).toBe(true)
  })
})

// ================================================================ AC-TIER-02
describe.each(['light', 'dark'] as const)('mobile-fit: viền phần tử và viền hình nhỏ (%s)', (theme) => {
  const tierBox = (el: HTMLElement): HTMLElement => el.dataset.tier ? el : (el.querySelector<HTMLElement>('[data-tier]') ?? el)
  const shapeOf = (box: HTMLElement, tier: number): SVGElement => {
    const names = ['Xám', 'Xanh lá', 'Xanh dương', 'Vàng', 'Đỏ']
    const badge = within(box).getByRole('img', { name: `Tier ${names[tier - 1]}` })
    const svg = badge.tagName.toLowerCase() === 'svg' ? badge : badge.querySelector('svg')
    const shape = svg?.querySelector<SVGElement>(tier === 1 ? 'circle' : 'polygon')
    if (!shape) throw new Error('Không thấy hình nhỏ của tier ' + tier)
    return shape
  }
  const ring = (): Rgb => toRgb(getComputedStyle(document.documentElement).getPropertyValue('--color-badge-ring').trim())

  it(`AC-TIER-02: --color-badge-ring là trắng ở chế độ sáng và #f4eee8 ở chế độ tối (${theme})`, async () => {
    await open({ width: 1366, height: 768 }, theme, true)
    expect(ring().join()).toBe(theme === 'light' ? '255,255,255' : '244,238,232')
  })

  it(`AC-TIER-02: viền phần tử liền >= 1,5 px, cùng màu viền hình nhỏ, lúc thường tối hơn màu viền sáng (${theme})`, async () => {
    await open({ width: 1366, height: 768 }, theme, true)
    const page0 = theme === 'dark' ? ([0, 0, 0] as Rgb) : ([255, 255, 255] as Rgb)
    for (let tier = 1; tier <= 5; tier++) {
      const holder = plateItem(ITEMS[tier - 1]!)
      const box = tierBox(holder)
      const cs = getComputedStyle(holder)
      const label = `${theme} / tier ${tier}`
      for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
        expect(cs.getPropertyValue(`border-${side.toLowerCase()}-style`), `${label}: viền ${side} phải liền`).toBe('solid')
        expect(Number.parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)), `${label}: viền ${side} quá mảnh`).toBeGreaterThanOrEqual(1.5)
      }
      const border = toRgb(cs.borderTopColor, page0)
      const stroke = toRgb(getComputedStyle(shapeOf(box, tier)).stroke, page0)
      expect(border.join(), `${label}: viền phần tử phải cùng màu viền hình nhỏ`).toBe(stroke.join())
      expect(lum(border), `${label}: lúc thường viền phải tối hơn màu viền sáng`).toBeLessThan(lum(ring()))
    }
  })

  it(`AC-TIER-02: rê chuột lên phần tử thì viền phần tử và viền hình nhỏ cùng đổi sang --color-badge-ring (${theme})`, async () => {
    await open({ width: 1366, height: 768 }, theme, true)
    const page0 = theme === 'dark' ? ([0, 0, 0] as Rgb) : ([255, 255, 255] as Rgb)
    for (let tier = 1; tier <= 5; tier++) {
      const holder = plateItem(ITEMS[tier - 1]!)
      holder.scrollIntoView({ block: 'center' })
      await userEvent.hover(holder)
      await settled()
      const box = tierBox(holder)
      const label = `${theme} / tier ${tier} / hover`
      const border = toRgb(getComputedStyle(holder).borderTopColor, page0)
      const stroke = toRgb(getComputedStyle(shapeOf(box, tier)).stroke, page0)
      expect(border.join(), `${label}: viền phần tử`).toBe(ring().join())
      expect(stroke.join(), `${label}: viền hình nhỏ`).toBe(ring().join())
      await userEvent.unhover(holder)
      await settled()
    }
  })

  it(`AC-TIER-02: món trên bàn cũng có viền liền >= 1,5 px cùng màu viền hình nhỏ (${theme})`, async () => {
    await open({ width: 1366, height: 768 }, theme, true)
    const table = screen.getByTestId('table')
    const t = rect(table)
    const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
    const src = plateItem(ITEMS[3]!)
    const x = t.left + t.width / 2
    const y = t.top + t.height / 2
    fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
    fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x / 2, clientY: y / 2 })
    fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x, clientY: y })
    fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: x, clientY: y })
    const el = await screen.findByTestId('table-item')
    await settled()
    const cs = getComputedStyle(el)
    expect(cs.borderTopStyle).toBe('solid')
    expect(Number.parseFloat(cs.borderTopWidth)).toBeGreaterThanOrEqual(1.5)
    const page0 = theme === 'dark' ? ([0, 0, 0] as Rgb) : ([255, 255, 255] as Rgb)
    const stroke = toRgb(getComputedStyle(shapeOf(tierBox(el), 4)).stroke, page0)
    expect(toRgb(cs.borderTopColor, page0).join()).toBe(stroke.join())
  })
})

// ================================================================ AC-GAME-21 (CSS)
describe('mobile-fit: vuốt cuộn trên món (AC-GAME-21, 390 px)', () => {
  it('AC-GAME-21: 390×844, món trong Đĩa và trên bàn cho phép vuốt dọc (touch-action có pan-y), không phải none', async () => {
    await open({ width: 390, height: 844 })
    const src = plateItem('Cay')
    const t = rect(screen.getByTestId('table'))
    const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
    const x = t.left + t.width / 2
    const y = t.top + t.height / 2
    fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
    fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x / 2, clientY: y / 2 })
    fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x, clientY: y })
    fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: x, clientY: y })
    await waitFor(() => expect(screen.getAllByTestId('table-item').length).toBe(1))
    for (const el of [...screen.getAllByTestId('plate-item'), ...screen.getAllByTestId('table-item')]) {
      const ta = getComputedStyle(el).touchAction
      expect(ta, 'touch-action: none chặn cuộn khi đặt tay lên món').not.toBe('none')
      expect(allowsVerticalPan(ta), `touch-action=${ta}`).toBe(true)
    }
  })

  it('AC-GAME-21: 390×844, danh sách Đĩa cuộn đến đầu/cuối thì chuyển sang cuộn trang (overscroll-behavior-y không phải contain)', async () => {
    await open({ width: 390, height: 844 })
    const panel = screen.getByTestId('plate-panel')
    const list = screen.getByRole('list', { name: 'Đĩa nhúng' })
    let scroller: HTMLElement | null = null
    for (let el: HTMLElement | null = list; el && panel.contains(el); el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY
      if (oy === 'auto' || oy === 'scroll') {
        scroller = el
        break
      }
    }
    // the list itself or the panel scrolls; either way, check the nearest scroll container (fallback: the list)
    const target = scroller ?? list
    const ob = getComputedStyle(target).overscrollBehaviorY
    expect(ob, `overscroll-behavior-y=${ob}`).not.toBe('contain')
    expect(ob).not.toBe('none')
  })
})
