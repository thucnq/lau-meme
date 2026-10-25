// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests (jsdom) for AC-GAME-28 (đổi kiểu mặt bàn, góp ý 2026-10-25).
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (reached through <Game /> with no props)
 *   - [data-testid="table"] carries data-table="plastic" | "wood".
 *   - A button inside [data-testid="table-tools"] named "Đổi sang bàn gỗ" while the table is plastic and
 *     "Đổi sang bàn nhựa" while it is wood.
 *   - localStorage key "laumeme:table" holds "plastic" | "wood"; anything else means plastic.
 */
import { webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialProgress, saveProgress } from './engine'
import type { Manifest } from './engine'
import { Game } from './Game'

const manifest = {
  version: 7,
  batch_at: '2026-10-20T00:00:00.000Z',
  graph_url: '/api/graph/7',
  starters: [
    { id: 'cay', name: 'Cay', emoji: '🌶️' },
    { id: 'cuoi', name: 'Cười', emoji: '😂' },
  ],
  miss_lines: ['Nồi trào rồi!'],
  daily: { element_id: 'x', emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
  policy_version: 1,
} as Manifest

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/lau-meme/')
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/manifest')) return json(manifest)
      if (url.includes('/graph/')) return json({ format: 1, version: 7, entries: {} })
      if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
      return new Response(null, { status: 204 })
    }),
  )
  const p = initialProgress(manifest, new Date('2026-10-20T03:00:00.000Z'))
  p.tutorial_seen = true
  saveProgress(localStorage, p)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount(): Promise<HTMLElement> {
  render(<Game />)
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  return screen.getByTestId('table')
}
const tools = () => within(screen.getByTestId('table-tools'))

describe('đổi kiểu mặt bàn (AC-GAME-28)', () => {
  it('AC-GAME-28: mặc định bàn nhựa; bấm nút đổi sang bàn gỗ rồi về bàn nhựa, tên nút nói kiểu sẽ đổi sang', async () => {
    const table = await mount()
    expect(table.dataset.table).toBe('plastic')
    fireEvent.click(tools().getByRole('button', { name: 'Đổi sang bàn gỗ' }))
    expect(table.dataset.table).toBe('wood')
    expect(localStorage.getItem('laumeme:table')).toBe('wood')
    fireEvent.click(tools().getByRole('button', { name: 'Đổi sang bàn nhựa' }))
    expect(table.dataset.table).toBe('plastic')
    expect(localStorage.getItem('laumeme:table')).toBe('plastic')
  })

  it('AC-GAME-28: lựa chọn bàn gỗ được giữ sau khi tải lại trang', async () => {
    localStorage.setItem('laumeme:table', 'wood')
    const table = await mount()
    expect(table.dataset.table).toBe('wood')
    expect(tools().getByRole('button', { name: 'Đổi sang bàn nhựa' })).toBeTruthy()
  })

  it('AC-GAME-28: giá trị lạ trong localStorage thì dùng bàn nhựa, không báo lỗi', async () => {
    localStorage.setItem('laumeme:table', 'kính cường lực')
    const table = await mount()
    expect(table.dataset.table).toBe('plastic')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-GAME-28: localStorage bị chặn thì vẫn đổi bàn được trong phiên, không báo lỗi', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const table = await mount()
    get.mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    set.mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    fireEvent.click(tools().getByRole('button', { name: 'Đổi sang bàn gỗ' }))
    expect(table.dataset.table).toBe('wood')
    expect(screen.queryByRole('alert')).toBeNull()
    get.mockRestore()
    set.mockRestore()
  })
})
