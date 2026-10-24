/**
 * AC-GAME-18 (docs/acceptance/game.md): nồi lẩu nằm trọn trong màn hình đầu tiên. Chạy trong Chromium thật
 * (Vitest browser mode + Playwright) vì jsdom không tính bố cục; CSS của trang được nạp như trong main.tsx.
 * Game là phần đầu của trang (Root đặt mọi thứ khác bên dưới), nên dựng riêng Game là đủ để đo màn hình đầu.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { Game } from './Game'

const manifest = {
  version: 7,
  batch_at: '2026-10-20T00:00:00.000Z',
  graph_url: '/api/graph/7',
  starters: [
    { id: 'cay', name: 'Cay', emoji: '🌶️' },
    { id: 'cuoi', name: 'Cười', emoji: '😂' },
    { id: 'toang', name: 'Toang', emoji: '💀' },
    { id: 'deadline', name: 'Deadline', emoji: '⏰' },
  ],
  miss_lines: ['Nồi trào rồi!'],
  daily: { element_id: 'tcc', emoji: '🍜', hint: 'gợi ý', depth: 4 },
  policy_version: 1,
}

function respond(url: string): Response {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/api/manifest')) return json(manifest)
  if (url.includes('/api/graph/')) return json({ format: 1, version: 7, entries: {} })
  if (url.endsWith('/api/blocklist')) return json({ elements: [], recipes: [], images: [] })
  return json({ title: 'Not found' }, 404)
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => respond(String(input))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const VIEWPORTS = [
  { name: 'PC', width: 1366, height: 768 },
  { name: 'tablet ngang', width: 1024, height: 768 },
  { name: 'tablet dọc', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'mobile nhỏ', width: 360, height: 640 },
]

it.each(VIEWPORTS)('AC-GAME-18: nồi lẩu nằm trọn trong màn hình đầu tiên ($name $width×$height)', async (vp) => {
  await page.viewport(vp.width, vp.height)
  render(<Game />)
  // Lần đầu: đóng hướng dẫn; chờ tải xong và thẻ Món đặc biệt hiện.
  ;(await screen.findByRole('button', { name: 'Đóng' })).click()
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  await screen.findByRole('region', { name: 'Món đặc biệt hôm nay' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  window.scrollTo(0, 0)

  for (const el of [screen.getByTestId('pot'), screen.getByTestId('pot-slot-1'), screen.getByTestId('pot-slot-2')]) {
    const box = el.getBoundingClientRect()
    expect(box.height).toBeGreaterThan(0)
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(box.right).toBeLessThanOrEqual(window.innerWidth)
  }
})

// ================================================================ AC-GAME-18 (cập nhật 2026-10-24: mặt bàn lấp khung nhìn đầu tiên)
const MOBILE_NAMES = new Set(['mobile', 'mobile nhỏ'])
const minTableRatio = (name: string): number => (MOBILE_NAMES.has(name) ? 0.55 : 0.6)
const tableBox = (): DOMRect => screen.getByTestId('table').getBoundingClientRect()

async function openFirstScreen(vp: { width: number; height: number }): Promise<void> {
  await page.viewport(vp.width, vp.height)
  render(<Game />)
  ;(await screen.findByRole('button', { name: 'Đóng' })).click()
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  await screen.findByRole('region', { name: 'Món đặc biệt hôm nay' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  window.scrollTo(0, 0)
}

it.each(VIEWPORTS)(
  'AC-GAME-18: mép dưới mặt bàn cách đáy khung nhìn không quá 24 px (không tràn), mặt bàn đủ cao ($name $width×$height)',
  async (vp) => {
    await openFirstScreen(vp)
    const box = tableBox()
    expect(box.bottom, 'mặt bàn không được tràn khỏi đáy khung nhìn').toBeLessThanOrEqual(window.innerHeight)
    expect(window.innerHeight - box.bottom, 'khoảng cách từ mép dưới mặt bàn tới đáy khung nhìn').toBeLessThanOrEqual(24)
    expect(box.height, 'chiều cao mặt bàn so với khung nhìn').toBeGreaterThanOrEqual(minTableRatio(vp.name) * window.innerHeight)
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(window.innerWidth)
  },
)

/** Thả món từ Đĩa vào điểm (x, y) của khung nhìn; Pointer Events như các test khác. */
function dropAt(name: string, x: number, y: number): void {
  const src = screen.getAllByTestId('plate-item').find((e) => e.dataset.name === name)
  if (!src) throw new Error(`Không có "${name}" trong Đĩa`)
  const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
  fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x / 2, clientY: y / 2 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: x, clientY: y })
  fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: x, clientY: y })
}

const insideBox = (inner: DOMRect, outer: DOMRect, tol = 1): boolean =>
  inner.top >= outer.top - tol && inner.left >= outer.left - tol && inner.bottom <= outer.bottom + tol && inner.right <= outer.right + tol

const RESIZES = [
  { from: VIEWPORTS[0]!, to: VIEWPORTS[4]! },
  { from: VIEWPORTS[3]!, to: VIEWPORTS[1]! },
  { from: VIEWPORTS[2]!, to: VIEWPORTS[0]! },
]

it.each(RESIZES)(
  'AC-GAME-18: đổi cỡ khung nhìn $from.name -> $to.name thì mặt bàn đổi theo và món trên bàn không rơi ra ngoài mặt bàn',
  async ({ from, to }) => {
    await openFirstScreen(from)
    const t = tableBox()
    // món ở ba chỗ: góc dưới phải, góc trên trái, giữa
    dropAt('Cay', t.right - 10, t.bottom - 10)
    dropAt('Cười', t.left + 10, t.top + 10)
    dropAt('Toang', t.left + t.width / 2, t.top + t.height / 2)
    await waitFor(() => expect(screen.getAllByTestId('table-item')).toHaveLength(3))
    for (const el of screen.getAllByTestId('table-item')) {
      expect(insideBox(el.getBoundingClientRect(), tableBox()), `${el.dataset.name} phải nằm trong mặt bàn trước khi đổi cỡ`).toBe(true)
    }

    await page.viewport(to.width, to.height)
    window.scrollTo(0, 0)
    await waitFor(() => {
      const box = tableBox()
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
      expect(window.innerHeight - box.bottom).toBeLessThanOrEqual(24)
      expect(box.height).toBeGreaterThanOrEqual(minTableRatio(to.name) * window.innerHeight)
    })
    await waitFor(() => {
      const box = tableBox()
      for (const el of screen.getAllByTestId('table-item')) {
        expect(insideBox(el.getBoundingClientRect(), box), `${el.dataset.name} ra ngoài mặt bàn sau khi đổi cỡ`).toBe(true)
      }
    })
    expect(screen.getAllByTestId('table-item')).toHaveLength(3)
  },
)
