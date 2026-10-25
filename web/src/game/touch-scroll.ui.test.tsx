// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests (jsdom) for AC-GAME-21, cập nhật 2026-10-25 (góp ý "không trượt được màn hình khi đặt tay vào vùng có món"):
 * cử chỉ con trỏ cảm ứng trên món. Phần CSS (touch-action, overscroll-behavior) nằm ở mobile-fit.browser.test.tsx.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (everything is reached through <Game /> with no props, as in ui2.ui.test.tsx)
 *   - plate-item / table-item receive pointerdown/pointermove/pointerup with pointerType 'touch'.
 *   - "món bóng" (ghost chip shown while dragging) is detected without a test id: it is one more element whose own text
 *     is the item's name, on top of the one in the plate.
 *   - A cancelable 'touchmove' dispatched on the document is defaultPrevented only while a hold-drag is active (the page
 *     must not scroll then); without a hold it is left alone so the browser can scroll.
 *   - Quick tap (no move, < 500 ms) puts the item into the first free pot slot (AC-GAME-24).
 */
import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function setTouch(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: /pointer:\s*coarse|hover:\s*none/.test(q),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 })
}

let dropTarget: Element | null = null

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-20T03:00:00.000Z'))
  localStorage.clear()
  dropTarget = null
  window.history.pushState({}, '', '/lau-meme/')
  Element.prototype.scrollIntoView = vi.fn()
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  setTouch()
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

async function mountReady(): Promise<void> {
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const plateItem = (name: string): HTMLElement => {
  const el = within(screen.getByRole('list', { name: 'Đĩa nhúng' }))
    .getAllByTestId('plate-item')
    .find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
  return el
}
/** Elements whose own text is exactly the item name: plate copy, table copy and (while dragging) the ghost chip. */
const copiesOf = (name: string): number =>
  Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter((e) =>
    Array.from(e.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim() === name),
  ).length

const base = { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 }
const START = { x: 100, y: 300 }
function down(el: Element): void {
  fireEvent.pointerDown(el, { ...base, buttons: 1, clientX: START.x, clientY: START.y })
}
function move(el: Element, dx: number, dy: number): void {
  fireEvent.pointerMove(el, { ...base, buttons: 1, clientX: START.x + dx / 2, clientY: START.y + dy / 2 })
  fireEvent.pointerMove(el, { ...base, buttons: 1, clientX: START.x + dx, clientY: START.y + dy })
}
function up(el: Element, dx = 0, dy = 0): void {
  fireEvent.pointerUp(el, { ...base, buttons: 0, clientX: START.x + dx, clientY: START.y + dy })
}
/** Dispatch a cancelable touchmove on the document and say whether the page was stopped from scrolling. */
function touchMovePrevented(): boolean {
  const ev = new Event('touchmove', { bubbles: true, cancelable: true })
  document.dispatchEvent(ev)
  return ev.defaultPrevented
}

describe('touch-scroll: vuốt trên món (AC-GAME-21, cập nhật 2026-10-25)', () => {
  it('AC-GAME-21: cảm ứng, vuốt dọc (>= 6 px) bắt đầu ngay trên món trong Đĩa, không giữ trước, thì không kéo món và không hiện món bóng', async () => {
    await mountReady()
    const cay = plateItem('Cay')
    const before = copiesOf('Cay')
    down(cay)
    move(cay, 3, 40)
    expect(copiesOf('Cay'), 'không được hiện món bóng khi vuốt dọc').toBe(before)
    up(cay, 3, 40)
    expect(screen.queryAllByTestId('table-item')).toHaveLength(0)
    expect(copiesOf('Cay')).toBe(before)
  })

  it('AC-GAME-21: cảm ứng, vuốt dọc bắt đầu trên món ở bàn cũng không kéo món (cuộn trang như ở chỗ trống)', async () => {
    await mountReady()
    dropTarget = screen.getByTestId('table')
    // đặt một món lên bàn bằng chuột
    const m = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
    fireEvent.pointerDown(plateItem('Cay'), { ...m, buttons: 1, clientX: 5, clientY: 5 })
    fireEvent.pointerMove(plateItem('Cay'), { ...m, buttons: 1, clientX: 40, clientY: 45 })
    fireEvent.pointerMove(plateItem('Cay'), { ...m, buttons: 1, clientX: 80, clientY: 90 })
    fireEvent.pointerUp(plateItem('Cay'), { ...m, buttons: 0, clientX: 80, clientY: 90 })
    const onTable = await screen.findByTestId('table-item')
    const before = copiesOf('Cay')
    fireEvent.pointerDown(onTable, { ...base, buttons: 1, clientX: START.x, clientY: START.y })
    fireEvent.pointerMove(onTable, { ...base, buttons: 1, clientX: START.x, clientY: START.y + 15 })
    fireEvent.pointerMove(onTable, { ...base, buttons: 1, clientX: START.x + 2, clientY: START.y + 40 })
    expect(copiesOf('Cay'), 'không được hiện món bóng khi vuốt dọc').toBe(before)
    fireEvent.pointerUp(onTable, { ...base, buttons: 0, clientX: START.x + 2, clientY: START.y + 40 })
    expect(screen.getAllByTestId('table-item')).toHaveLength(1)
  })

  it('AC-GAME-21: cảm ứng, kéo ngang món thì kéo ngay (hiện món bóng) mà không cần giữ', async () => {
    await mountReady()
    const cay = plateItem('Cay')
    const before = copiesOf('Cay')
    down(cay)
    move(cay, 40, 3)
    expect(copiesOf('Cay'), 'kéo ngang phải hiện món bóng').toBeGreaterThan(before)
    up(cay, 40, 3)
  })

  it('AC-GAME-21: cảm ứng, giữ yên món >= 250 ms rồi kéo dọc thì kéo món (hiện món bóng)', async () => {
    await mountReady()
    const cay = plateItem('Cay')
    const before = copiesOf('Cay')
    down(cay)
    await advance(300)
    move(cay, 2, 40)
    expect(copiesOf('Cay'), 'giữ rồi kéo dọc phải hiện món bóng').toBeGreaterThan(before)
    up(cay, 2, 40)
  })

  it('AC-GAME-21: trong lúc kéo sau khi giữ, touchmove hủy được trên document bị chặn (trang không cuộn); không giữ thì không chặn', async () => {
    await mountReady()
    const cay = plateItem('Cay')

    // không giữ: vuốt dọc, trang được phép cuộn
    down(cay)
    move(cay, 2, 40)
    expect(touchMovePrevented(), 'không giữ thì không được chặn cuộn').toBe(false)
    up(cay, 2, 40)

    // giữ >= 250 ms rồi kéo: trang không cuộn
    down(cay)
    await advance(300)
    move(cay, 2, 40)
    expect(touchMovePrevented(), 'đang kéo sau khi giữ thì phải chặn cuộn').toBe(true)
    up(cay, 2, 40)

    // thả ra rồi thì trang cuộn lại bình thường
    expect(touchMovePrevented(), 'sau khi thả không còn chặn cuộn').toBe(false)
  })

  it('AC-GAME-21: cảm ứng, bấm nhanh (không di chuyển, nhả < 500 ms) vẫn cho món vào nồi như AC-GAME-24', async () => {
    await mountReady()
    const cay = plateItem('Cay')
    down(cay)
    await advance(80)
    up(cay)
    await waitFor(() => expect(screen.getByTestId('pot-slot-1').textContent).toContain('Cay'))
    expect(screen.queryAllByTestId('table-item')).toHaveLength(0)
  })
})
