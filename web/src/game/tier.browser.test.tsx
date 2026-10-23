/**
 * AC-TIER-02 in real Chromium (Vitest browser mode + Playwright), as AC-GAME-18/19/20: tier colour, shape, contrast.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (on top of game.ui2 hooks: plate-item, table-item, pot-slot-1/2, pot, table, discovery-zoom)
 *   - Every rendered element (plate-item, table-item, the element held in a pot slot, the element in discovery-zoom)
 *     is, or contains, one box with attribute data-tier="1".."5" and its own background-color (the tier colour).
 *     For plate-item and table-item the box is the testid element itself; for pot-slot-N and discovery-zoom it is the
 *     first descendant [data-tier].
 *   - Inside that box, one badge with role="img" and accessible name "Tier <tên>" (Xám, Xanh lá, Xanh dương, Vàng, Đỏ)
 *     holding an <svg>: tier 1 a <circle>, tier 2..5 a <polygon> with 3, 4, 5, 6 points. The shape fill is in the same
 *     hue family as the background, centred horizontally at the bottom edge of the box, not over the emoji.
 *   - Item (progress) carries `tier` (1-5); GraphResult carries `tier`; manifest.starters carry none (tier 1).
 *   - The daily card (region "Món đặc biệt hôm nay") never shows a tier badge while the dish is unsolved.
 * Theme is read from document.documentElement.dataset.theme ('light' | 'dark').
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { fold } from '../graph/crypto'
import { initialProgress, saveProgress } from './engine'
import type { Manifest, Progress } from './engine'
import { Game } from './Game'

// ---------------------------------------------------------------- fixtures
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const sha = async (s: string): Promise<string> => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
const eid = (name: string): Promise<string> => sha('lm1|e|' + fold(name))

const VERSION = 7
const TIER_NAMES = ['Xám', 'Xanh lá', 'Xanh dương', 'Vàng', 'Đỏ'] as const
const SIDES = [0, 3, 4, 5, 6] // tier 1 is a circle (no polygon)
const ITEMS = ['Món Xám', 'Món Lá', 'Món Dương', 'Món Vàng', 'Món Đỏ']
const RESULT = 'Tới Công Chuyện' // Cay + Cười, tier 4 in the graph

async function buildGraph(): Promise<unknown> {
  const [x, y] = [fold('Cay'), fold('Cười')].sort()
  const key = await sha('lm1|k|' + x + '\0' + y)
  const plain = { added_version: VERSION, depth: 1, emoji: '🔥', id: await eid(RESULT), image_key: null, name: RESULT, tier: 4 }
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
})

async function seedTierItems(): Promise<void> {
  const p: Progress = initialProgress(manifest, new Date())
  p.tutorial_seen = true
  for (let i = 0; i < ITEMS.length; i++) {
    p.items.push({ id: await eid(ITEMS[i]!), name: ITEMS[i]!, emoji: '🍲', depth: 1, added_version: VERSION, image_key: null, discovered_at: '2026-10-01T00:00:00.000Z', tier: i + 1 } as unknown as Progress['items'][number])
  }
  saveProgress(localStorage, p)
}

async function open(theme: 'light' | 'dark', vp = { width: 1366, height: 768 }): Promise<void> {
  cleanup()
  localStorage.clear()
  await seedTierItems()
  await page.viewport(vp.width, vp.height)
  document.documentElement.dataset.theme = theme
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  await waitFor(() => expect(plateItem(ITEMS[0]!)).toBeTruthy())
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
const rect = (el: Element): DOMRect => el.getBoundingClientRect()

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
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
function hueClass([r, g, b]: Rgb): 'grey' | 'red' | 'yellow' | 'green' | 'blue' | 'other' {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = (max - min) / 255
  if (chroma < 0.15) return 'grey'
  let h: number
  if (max === r) h = 60 * (((g - b) / (max - min)) % 6)
  else if (max === g) h = 60 * ((b - r) / (max - min) + 2)
  else h = 60 * ((r - g) / (max - min) + 4)
  if (h < 0) h += 360
  if (h >= 345 || h <= 15) return 'red'
  if (h >= 38 && h <= 70) return 'yellow'
  if (h >= 85 && h <= 165) return 'green'
  if (h >= 190 && h <= 255) return 'blue'
  return 'other'
}
// Hue of the tier colour: tier 1 grey, 2 green, 3 blue, 4 yellow, 5 red (the table in tier.md)

function pageBackground(): Rgb {
  const probe = (el: Element): string => getComputedStyle(el).backgroundColor
  for (const el of [document.body, document.documentElement]) {
    const c = toRgb(probe(el), [0, 0, 0])
    const alpha = toRgb(probe(el), [255, 255, 255])
    if (c.join() === alpha.join()) return c // opaque
  }
  return document.documentElement.dataset.theme === 'dark' ? [0, 0, 0] : [255, 255, 255]
}
const tierBox = (el: HTMLElement): HTMLElement => {
  if (el.dataset.tier) return el
  const inner = el.querySelector<HTMLElement>('[data-tier]')
  if (!inner) throw new Error('Không có phần tử data-tier trong ' + (el.dataset.testid ?? el.tagName))
  return inner
}
const leafWithText = (root: Element, text: string): HTMLElement => {
  const el = Array.from(root.querySelectorAll<HTMLElement>('*')).find((e) => e.children.length === 0 && e.textContent?.trim() === text)
  if (!el) throw new Error(`Không thấy chữ "${text}"`)
  return el
}

/** One element on the page: colour of the background, the little shape, its place and the text contrast. */
function assertTier(holder: HTMLElement, name: string, tier: number, theme: 'light' | 'dark', where: string, emojiText = '🍲'): void {
  const box = tierBox(holder)
  const label = `${where} / ${name} / tier ${tier} / ${theme}`
  expect(box.dataset.tier, label).toBe(String(tier))

  // background colour of the tier
  const page0 = pageBackground()
  const bg = toRgb(getComputedStyle(box).backgroundColor, page0)
  expect(getComputedStyle(box).backgroundColor, `${label}: thiếu màu nền`).not.toBe('rgba(0, 0, 0, 0)')
  expect(hueClass(bg), `${label}: màu nền ${bg}`).toBe(tier === 1 ? 'grey' : (['green', 'blue', 'yellow', 'red'] as const)[tier - 2])

  // shape: exact figure
  const badge = within(box).getByRole('img', { name: `Tier ${TIER_NAMES[tier - 1]}` })
  const svg = badge.tagName.toLowerCase() === 'svg' ? badge : badge.querySelector('svg')
  expect(svg, `${label}: thiếu <svg>`).not.toBeNull()
  const polygons = svg!.querySelectorAll('polygon')
  if (tier === 1) {
    expect(svg!.querySelectorAll('circle').length, `${label}: tier 1 là hình tròn`).toBe(1)
    expect(polygons.length).toBe(0)
  } else {
    expect(polygons.length, `${label}: một đa giác`).toBe(1)
    const pts = (polygons[0]!.getAttribute('points') ?? '').trim().split(/[\s,]+/).filter(Boolean)
    expect(pts.length % 2, `${label}: points lẻ`).toBe(0)
    expect(pts.length / 2, `${label}: số cạnh`).toBe(SIDES[tier - 1])
  }
  const shape = svg!.querySelector<SVGElement>(tier === 1 ? 'circle' : 'polygon')!
  const fill = toRgb(getComputedStyle(shape).fill, bg)
  expect(fill.join(), `${label}: hình phải khác màu nền`).not.toBe(bg.join())
  expect(hueClass(fill), `${label}: hình cùng họ màu với nền`).toBe(hueClass(bg))
  if (theme === 'light') expect(lum(fill), `${label}: hình đậm hơn nền`).toBeLessThan(lum(bg))

  // place: bottom centre, inside the box, not over the emoji, box not bloated
  const bx = rect(box)
  const bb = rect(badge)
  expect(bb.width, label).toBeGreaterThan(0)
  expect(Math.abs(bb.left + bb.width / 2 - (bx.left + bx.width / 2)), `${label}: chính giữa`).toBeLessThanOrEqual(2)
  expect(bb.bottom, `${label}: mép dưới`).toBeLessThanOrEqual(bx.bottom + 1)
  expect(bb.top, `${label}: nửa dưới`).toBeGreaterThanOrEqual(bx.top + bx.height / 2)
  expect(bb.width, `${label}: hình nhỏ`).toBeLessThan(bx.width / 2)
  const emoji = leafWithText(box, emojiText).getBoundingClientRect()
  const over = emoji.left < bb.right && bb.left < emoji.right && emoji.top < bb.bottom && bb.top < emoji.bottom
  expect(over, `${label}: hình che emoji`).toBe(false)

  // text contrast >= 4.5 on the tier background
  const text = leafWithText(box, name)
  const fg = toRgb(getComputedStyle(text).color, bg)
  expect(contrast(fg, bg), `${label}: tương phản chữ ${fg} trên ${bg}`).toBeGreaterThanOrEqual(4.5)
}

// ================================================================ AC-TIER-02
describe.each(['light', 'dark'] as const)('tier hiển thị (giao diện %s)', (theme) => {
  it(`AC-TIER-02: Đĩa nhúng - 5 phần tử, mỗi tier đúng màu nền, đúng hình, nhãn "Tier <tên>", chữ đạt tương phản 4,5:1 (${theme})`, async () => {
    await open(theme)
    const bgs = new Set<string>()
    for (let tier = 1; tier <= 5; tier++) {
      const name = ITEMS[tier - 1]!
      assertTier(plateItem(name), name, tier, theme, 'Đĩa nhúng')
      bgs.add(getComputedStyle(tierBox(plateItem(name))).backgroundColor)
    }
    expect(bgs.size, 'năm tier phải có năm màu nền khác nhau').toBe(5)
    // phần tử khởi đầu là tier 1 (Xám)
    expect(tierBox(plateItem('Cay')).dataset.tier).toBe('1')
    // đều cao bằng nhau: hình nhỏ không làm phần tử to hơn
    const heights = ITEMS.map((n) => rect(plateItem(n)).height)
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
  })

  it(`AC-TIER-02: trên bàn - phần tử thả lên mặt bàn giữ đúng màu nền, hình, nhãn và tương phản của tier (${theme})`, async () => {
    for (let tier = 1; tier <= 5; tier++) {
      await open(theme)
      const name = ITEMS[tier - 1]!
      drag(plateItem(name), screen.getByTestId('table'))
      await waitFor(() => expect(screen.getAllByTestId('table-item').length).toBe(1))
      assertTier(screen.getByTestId('table-item'), name, tier, theme, 'bàn')
    }
  })

  it(`AC-TIER-02: trong nồi - phần tử ở chỗ thả số 1 giữ đúng màu nền, hình, nhãn và tương phản của tier (${theme})`, async () => {
    for (let tier = 1; tier <= 5; tier++) {
      await open(theme)
      const name = ITEMS[tier - 1]!
      drag(plateItem(name), screen.getByTestId('pot-slot-1'))
      await waitFor(() => expect(within(screen.getByTestId('pot-slot-1')).queryByText(name)).not.toBeNull())
      assertTier(screen.getByTestId('pot-slot-1'), name, tier, theme, 'nồi')
    }
  })

  it(`AC-TIER-02: thẻ kết quả khi ghép ra - phần tử mới (tier 4 từ graph) hiện nền vàng, ngũ giác, "Tier Vàng" (${theme})`, async () => {
    await open(theme)
    drag(plateItem('Cay'), screen.getByTestId('pot-slot-1'))
    drag(plateItem('Cười'), screen.getByTestId('pot-slot-2'))
    const zoom = await waitFor(
      () => {
        const z = screen.getByTestId('discovery-zoom')
        expect(within(z).queryByText(RESULT)).not.toBeNull()
        return z
      },
      { timeout: 5000, interval: 20 },
    )
    assertTier(zoom, RESULT, 4, theme, 'thẻ kết quả', '🔥')
  })
})

describe('tier hiển thị (không lộ, không phình)', () => {
  it('AC-TIER-02: Món đặc biệt chưa giải không lộ tier: thẻ thử thách không có nhãn "Tier ..." và không có hình tier', async () => {
    await open('light')
    const card = screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })
    expect(within(card).queryByRole('img', { name: /^Tier / })).toBeNull()
    expect(card.querySelector('[data-tier]')).toBeNull()
    expect(card.textContent ?? '').not.toMatch(/Tier/)
  })

  it('AC-TIER-02: ở bề rộng 390 px nồi vẫn nằm trọn trong khung nhìn và trang không tràn ngang (như AC-GAME-18)', async () => {
    await open('light', { width: 390, height: 844 })
    const pot = rect(screen.getByTestId('pot'))
    expect(pot.left).toBeGreaterThanOrEqual(0)
    expect(pot.right).toBeLessThanOrEqual(window.innerWidth)
    expect(pot.bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    for (let tier = 1; tier <= 5; tier++) {
      const name = ITEMS[tier - 1]!
      plateItem(name).scrollIntoView()
      assertTier(plateItem(name), name, tier, 'light', 'mobile 390')
    }
  })
})
