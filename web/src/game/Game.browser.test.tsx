/**
 * AC-GAME-18 (docs/acceptance/game.md): nồi lẩu nằm trọn trong màn hình đầu tiên. Chạy trong Chromium thật
 * (Vitest browser mode + Playwright) vì jsdom không tính bố cục; CSS của trang được nạp như trong main.tsx.
 * Game là phần đầu của trang (Root đặt mọi thứ khác bên dưới), nên dựng riêng Game là đủ để đo màn hình đầu.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
