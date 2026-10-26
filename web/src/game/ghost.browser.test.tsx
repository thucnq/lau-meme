/**
 * AC-GAME-02 (cập nhật 2026-10-25, góp ý "trên web khi kéo thì thẻ không theo chuột") in real Chromium
 * (Vitest browser mode + Playwright): trong lúc kéo bằng chuột, món bóng đi theo con trỏ.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES
 *   drag ghost   the floating copy while dragging: [data-testid="drag-ghost"] or, today, `.chip.ghost`. Exactly one while a
 *                drag is in progress, gone after pointerup. Its bounding-box centre is within 4 px of the pointer at every
 *                position (page scrolled or not). Its computed position must not be static/relative (a later
 *                `.chip:not(.on-table) { position: relative }` wins over `.ghost` on staging today).
 *   ghost look   carries the tier of the dragged element: data-tier on the ghost (or on a descendant), same background
 *                colour and same solid border as the source chip, and a badge role="img" name "Tier <tên>" holding an <svg>.
 *   plate-item   data-name, data-tier on itself or on a descendant (as tier.browser.test.tsx).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { initialProgress, saveProgress } from './engine'
import type { Manifest, Progress } from './engine'
import { Game } from './Game'

const VERSION = 7
const ITEMS = ['Món Xám', 'Món Lá', 'Món Dương', 'Món Vàng', 'Món Đỏ']
const TIER_NAMES = ['Xám', 'Xanh lá', 'Xanh dương', 'Vàng', 'Đỏ']

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

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/api/auth/session')) return reply({ title: 'Chưa đăng nhập', status: 401 }, 401)
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

function seed(): void {
  const p: Progress = initialProgress(manifest, new Date())
  p.tutorial_seen = true
  ITEMS.forEach((name, i) =>
    p.items.push({ id: `id-${i}`, name, emoji: '🍲', depth: 1, added_version: VERSION, image_key: null, discovered_at: '2026-10-01T00:00:00.000Z', tier: i + 1 } as unknown as Progress['items'][number]),
  )
  saveProgress(localStorage, p)
}

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

async function open(vp: { width: number; height: number }, theme: 'light' | 'dark'): Promise<void> {
  cleanup()
  localStorage.clear()
  seed()
  await page.viewport(vp.width, vp.height)
  document.documentElement.dataset.theme = theme
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  window.scrollTo(0, 0)
  await frame()
}

const plateItem = (name: string): HTMLElement => {
  const el = screen.getAllByTestId('plate-item').find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
  return el
}
const ghostEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="drag-ghost"], .chip.ghost, .ghost')
const tierBox = (el: HTMLElement): HTMLElement => (el.dataset.tier ? el : (el.querySelector<HTMLElement>('[data-tier]') ?? el))

const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }

async function followsPointer(label: string, points: Array<[number, number]>, src: HTMLElement): Promise<HTMLElement> {
  const r0 = src.getBoundingClientRect()
  const sx = r0.left + r0.width / 2
  const sy = r0.top + r0.height / 2
  fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: sx, clientY: sy })
  let ghost: HTMLElement | null = null
  for (const [x, y] of points) {
    fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x, clientY: y })
    await frame()
    ghost = ghostEl()
    expect(ghost, `${label}: không có món bóng khi con trỏ ở (${x}, ${y})`).not.toBeNull()
    const pos = getComputedStyle(ghost!).position
    expect(['static', 'relative'], `${label}: món bóng có position ${pos}, không thể theo con trỏ`).not.toContain(pos)
    const g = ghost!.getBoundingClientRect()
    const dx = g.left + g.width / 2 - x
    const dy = g.top + g.height / 2 - y
    expect(Math.abs(dx), `${label}: tâm món bóng lệch ngang ${dx.toFixed(1)} px tại (${x}, ${y})`).toBeLessThanOrEqual(4)
    expect(Math.abs(dy), `${label}: tâm món bóng lệch dọc ${dy.toFixed(1)} px tại (${x}, ${y})`).toBeLessThanOrEqual(4)
  }
  return ghost!
}

describe.each(['light', 'dark'] as const)('món bóng khi kéo bằng chuột (%s)', (theme) => {
  it(`AC-GAME-02: kéo chuột từ Đĩa, tâm món bóng cách con trỏ <= 4 px ở mọi vị trí (trang chưa cuộn) (${theme})`, async () => {
    await open({ width: 1366, height: 768 }, theme)
    const src = plateItem(ITEMS[3]!)
    const pts: Array<[number, number]> = [
      [src.getBoundingClientRect().left + 60, src.getBoundingClientRect().top + 60],
      [500, 300],
      [700, 400],
      [350, 600],
      [900, 150],
    ]
    const ghost = await followsPointer(theme, pts, src)
    expect(ghost).toBeTruthy()
    const last = pts[pts.length - 1]!
    fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: last[0], clientY: last[1] })
    await frame()
    await waitFor(() => expect(ghostEl(), 'món bóng phải biến mất sau khi thả').toBeNull())
  })

  it(`AC-GAME-02: sau khi trang đã cuộn, tâm món bóng vẫn cách con trỏ <= 4 px (${theme})`, async () => {
    await open({ width: 360, height: 640 }, theme)
    const src = plateItem(ITEMS[4]!)
    src.scrollIntoView({ block: 'center' })
    await frame()
    expect(window.scrollY, 'trang phải cuộn được để kiểm tra').toBeGreaterThan(0)
    const r = src.getBoundingClientRect()
    const pts: Array<[number, number]> = [
      [r.left + r.width / 2 + 20, r.top + r.height / 2 + 20],
      [200, 300],
      [120, 150],
      [300, 500],
    ]
    await followsPointer(`${theme} đã cuộn ${Math.round(window.scrollY)} px`, pts, src)
    const last = pts[pts.length - 1]!
    fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: last[0], clientY: last[1] })
  })

  it(`AC-GAME-02: món bóng mang nền, viền và hình nhỏ tier của món đang kéo (${theme})`, async () => {
    await open({ width: 1366, height: 768 }, theme)
    for (const tier of [1, 4, 5]) {
      await open({ width: 1366, height: 768 }, theme)
      const src = plateItem(ITEMS[tier - 1]!)
      const srcBox = tierBox(src)
      const srcCs = getComputedStyle(src)
      const ghost = await followsPointer(`${theme} tier ${tier}`, [[600, 300], [620, 320]], src)
      const box = tierBox(ghost)
      const label = `${theme} / tier ${tier}`
      expect(box.dataset.tier, `${label}: món bóng thiếu data-tier`).toBe(String(tier))
      const cs = getComputedStyle(ghost)
      expect(getComputedStyle(box).backgroundColor, `${label}: nền món bóng`).toBe(getComputedStyle(srcBox).backgroundColor)
      expect(cs.borderTopStyle, `${label}: viền món bóng phải liền`).toBe('solid')
      expect(cs.borderTopWidth, `${label}: độ dày viền`).toBe(srcCs.borderTopWidth)
      expect(cs.borderTopColor, `${label}: màu viền`).toBe(srcCs.borderTopColor)
      const badge = within(ghost).getByRole('img', { name: `Tier ${TIER_NAMES[tier - 1]}` })
      expect(badge.tagName.toLowerCase() === 'svg' || badge.querySelector('svg') !== null, `${label}: hình nhỏ`).toBe(true)
      fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: 620, clientY: 320 })
    }
  })
})
