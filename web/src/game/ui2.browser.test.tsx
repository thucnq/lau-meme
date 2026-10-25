/**
 * UI2 layout acceptance tests in real Chromium (Vitest browser mode + Playwright), as AC-GAME-18:
 * AC-GAME-19 (nút điều khiển "Dọn bàn" và "?" trong khu bàn, không đè nồi; không còn "Chơi lại từ đầu" - cập nhật 2026-10-24), AC-GAME-20 (hàng lửa và quai nồi),
 * AC-GAME-21 (touch-action), AC-DAILY-16 (cỡ chữ và màu nền thẻ).
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (data-testid hooks for geometry, since roles carry no boxes)
 *   pot (existing), pot-slot-1/2 (existing), table (existing: the drop surface), plate-item, table-item (existing)
 *   pot-flames  the whole flame row under the pot (also while boiling)
 *   pot-body    the pot's body (below the rim)
 *   pot-handle-left, pot-handle-right  the two handles
 * Theme is read from document.documentElement.dataset.theme ('light' | 'dark').
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { fold } from '../graph/crypto'
import { Game } from './Game'

// ---------------------------------------------------------------- fixtures (graph encrypted with WebCrypto, ADR 0002)
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const sha = async (s: string): Promise<string> => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
const eid = (name: string): Promise<string> => sha('lm1|e|' + fold(name))

async function buildGraph(version: number): Promise<unknown> {
  const [x, y] = [fold('Cay'), fold('Cười')].sort()
  const key = await sha('lm1|k|' + x + '\0' + y)
  const plain = { added_version: version, depth: 1, emoji: '🔥', id: await eid('Tới Công Chuyện'), image_key: null, name: 'Tới Công Chuyện' }
  const ikm = await crypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + version), info: enc.encode('lm1|aes-gcm') },
      ikm,
      44 * 8,
    ),
  )
  const aes = await crypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt'])
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) }, aes, enc.encode(JSON.stringify(plain)))
  return { format: 1, version, entries: { [key]: b64u(new Uint8Array(ct)) } }
}

/** Most recent 05:00 or 17:00 UTC mark before now, so the next batch is always in the future (countdown "Mẻ mới sau"). */
function recentBatchMark(): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5))
  const marks = [-12, 0, 12, 24].map((h) => d.getTime() + h * 3_600_000).filter((t) => t < now.getTime())
  return new Date(Math.max(...marks)).toISOString()
}

async function manifestOf(): Promise<unknown> {
  return {
    version: 7,
    batch_at: recentBatchMark(),
    graph_url: '/api/graph/7',
    starters: [
      { id: await eid('Cay'), name: 'Cay', emoji: '🌶️' },
      { id: await eid('Cười'), name: 'Cười', emoji: '😂' },
      { id: await eid('Toang'), name: 'Toang', emoji: '💀' },
      { id: await eid('Deadline'), name: 'Deadline', emoji: '⏰' },
    ],
    miss_lines: ['Nồi trào rồi!'],
    daily: { element_id: await eid('Stonks'), emoji: '🍜', hint: 'gợi ý', depth: 4 },
    policy_version: 1,
  }
}

beforeEach(async () => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  const manifest = await manifestOf()
  const graph = await buildGraph(7)
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/manifest')) return reply(manifest)
      if (url.includes('/api/graph/')) return reply(graph)
      if (url.endsWith('/api/blocklist')) return reply({ elements: [], recipes: [], images: [] })
      if (url.includes('/daily/') && url.endsWith('/leaderboard')) return reply({ version: 7, rows: [], me: null })
      if (url.includes('/daily/leaderboard')) return reply({ period: 'x', starts_at: '2026-10-18T17:00:00.000Z', ends_at: '2026-10-25T17:00:00.000Z', batches: 0, rows: [], me: null })
      return reply({ title: 'Not found' }, 404)
    }),
  )
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

async function open(vp: { width: number; height: number }, theme?: 'light' | 'dark'): Promise<void> {
  await page.viewport(vp.width, vp.height)
  if (theme) document.documentElement.dataset.theme = theme
  render(<Game />)
  ;(await screen.findByRole('button', { name: 'Đóng' })).click()
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  await screen.findByRole('region', { name: 'Món đặc biệt hôm nay' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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

const inside = (inner: DOMRect, outer: DOMRect, tol = 0.5): boolean =>
  inner.top >= outer.top - tol && inner.left >= outer.left - tol && inner.bottom <= outer.bottom + tol && inner.right <= outer.right + tol
const overlap = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const rect = (el: Element): DOMRect => el.getBoundingClientRect()

// ================================================================ AC-GAME-19
describe.each([
  { name: 'PC', width: 1366, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
])('ui2 bố cục nút điều khiển ($name $width×$height)', (vp) => {
  it(`AC-GAME-19: "Dọn bàn" và "?" nằm trong khu bàn lẩu, không đè lên nồi, không có "Chơi lại từ đầu" (${vp.name})`, async () => {
    await open(vp)
    const table = rect(screen.getByTestId('table'))
    const potBox = rect(screen.getByTestId('pot'))
    expect(screen.queryAllByRole('button', { name: /chơi lại từ đầu/i })).toHaveLength(0)
    const buttons = ['Dọn bàn', '?'].map((n) => screen.getByRole('button', { name: n }))
    const header = screen.getByRole('banner')
    for (const b of buttons) {
      const r = rect(b)
      expect(r.width).toBeGreaterThan(0)
      expect(overlap(r, potBox), 'nút đè lên nồi').toBe(false)
      expect(overlap(r, rect(screen.getByTestId('pot-slot-1')))).toBe(false)
      expect(overlap(r, rect(screen.getByTestId('pot-slot-2')))).toBe(false)
      expect(header.contains(b)).toBe(false)
      expect(r.left).toBeGreaterThanOrEqual(0)
      expect(r.right).toBeLessThanOrEqual(window.innerWidth)
      if (vp.name === 'PC') {
        // góc trên bên phải mặt bàn
        expect(inside(r, table), 'nút nằm trong mặt bàn').toBe(true)
        expect(r.left + r.width / 2).toBeGreaterThan(table.left + table.width / 2)
        expect(r.top - table.top).toBeLessThan(table.height * 0.3)
      } else {
        // một hàng ngay trên mặt bàn
        expect(r.bottom).toBeLessThanOrEqual(table.top + 2)
        expect(table.top - r.bottom).toBeLessThan(100)
      }
    }
    if (vp.name !== 'PC') {
      const tops = buttons.map((b) => rect(b).top)
      expect(Math.max(...tops) - Math.min(...tops), 'hai nút cùng một hàng').toBeLessThan(8)
    }
  })

  it(`AC-GAME-19: đầu trang không chứa hai nút điều khiển và không bị đẩy ra ngoài khung nhìn (${vp.name})`, async () => {
    await open(vp)
    const header = screen.getByRole('banner')
    for (const n of ['Dọn bàn', '?']) expect(within(header).queryByRole('button', { name: n })).toBeNull()
    const r = rect(header)
    expect(r.right).toBeLessThanOrEqual(window.innerWidth + 0.5)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  })
})

// ================================================================ AC-GAME-20
describe.each(['light', 'dark'] as const)('ui2 nồi lẩu vẽ trọn (giao diện %s)', (theme) => {
  it.each(VIEWPORTS)(`AC-GAME-20: hàng lửa nằm trọn trong mặt bàn và quai nồi gắn nửa trên thân nồi, giao diện ${theme} ($name $width×$height)`, async (vp) => {
    await open(vp, theme)
    const check = (): void => {
      const table = rect(screen.getByTestId('table'))
      const flames = screen.getByTestId('pot-flames')
      const f = rect(flames)
      expect(f.height).toBeGreaterThan(0)
      expect(f.width).toBeGreaterThan(0)
      expect(inside(f, table), 'hàng lửa phải nằm trọn trong mặt bàn').toBe(true)
      // chỉ vẽ ngọn lửa nguyên: lặp kiểu space, hoặc bề rộng hàng chia hết cho bề rộng một ngọn
      const cs = getComputedStyle(flames)
      if (!cs.backgroundRepeat.trim().startsWith('space')) {
        const tile = parseFloat(cs.backgroundSize.split(/[\s,]+/)[0] ?? '')
        expect(Number.isFinite(tile) && tile > 0, `background-size phải là px, đang là "${cs.backgroundSize}"`).toBe(true)
        const ratio = f.width / tile
        expect(Math.abs(f.width - Math.round(ratio) * tile), `bề rộng ${f.width} không chia hết cho ${tile}`).toBeLessThanOrEqual(0.5)
      }
      // không khung nào ở giữa cắt: mọi tổ tiên có overflow khác visible cũng phải chứa trọn hàng lửa
      for (let el = flames.parentElement; el && el !== document.body; el = el.parentElement) {
        const o = getComputedStyle(el)
        if (o.overflowX !== 'visible' || o.overflowY !== 'visible') {
          expect(inside(f, rect(el)), `${el.tagName}.${el.className} cắt hàng lửa`).toBe(true)
        }
      }
      const body = rect(screen.getByTestId('pot-body'))
      const mid = body.top + body.height / 2
      for (const id of ['pot-handle-left', 'pot-handle-right']) {
        const h = rect(screen.getByTestId(id))
        expect(h.height).toBeGreaterThan(0)
        expect(h.top + h.height / 2, `tâm ${id} phải nằm trên đường giữa thân nồi`).toBeLessThan(mid)
        expect(h.top + h.height / 2).toBeGreaterThanOrEqual(body.top - 1)
      }
    }
    check() // vừa tải xong

    // khi nồi đang sôi
    drag(plateItem('Cay'), screen.getByTestId('pot-slot-1'))
    drag(plateItem('Cười'), screen.getByTestId('pot-slot-2'))
    await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('boiling'), { timeout: 2000, interval: 20 })
    check()
    await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'), { timeout: 3000 })
  })
})

// ================================================================ AC-GAME-21
describe('ui2 touch-action (AC-GAME-21)', () => {
  const allowsVerticalPan = (v: string): boolean => v !== 'none' && (v === 'auto' || v === 'manipulation' || v.split(/\s+/).includes('pan-y'))

  it('AC-GAME-21: 390×844, mặt bàn cho phép vuốt dọc để cuộn trang, còn món trên bàn và trong Đĩa giữ cử chỉ kéo (touch-action: none); Đĩa nằm dưới nồi', async () => {
    await open({ width: 390, height: 844 })
    const table = screen.getByTestId('table')
    drag(plateItem('Cay'), table)
    await waitFor(() => expect(screen.getAllByTestId('table-item').length).toBe(1))

    expect(allowsVerticalPan(getComputedStyle(table).touchAction), `mặt bàn: touch-action=${getComputedStyle(table).touchAction}`).toBe(true)
    expect(allowsVerticalPan(getComputedStyle(document.body).touchAction)).toBe(true)
    // cập nhật 2026-10-25 (góp ý "không trượt được màn hình khi đặt tay vào vùng có món"): món không còn touch-action: none,
    // phải cho vuốt dọc (pan-y) để cuộn trang; kéo món do giữ >= 250 ms hoặc kéo ngang quyết định.
    for (const el of screen.getAllByTestId('table-item')) expect(allowsVerticalPan(getComputedStyle(el).touchAction), `món trên bàn: touch-action=${getComputedStyle(el).touchAction}`).toBe(true)
    for (const el of screen.getAllByTestId('plate-item')) expect(allowsVerticalPan(getComputedStyle(el).touchAction), `món trong Đĩa: touch-action=${getComputedStyle(el).touchAction}`).toBe(true)

    // Đĩa nằm dưới nồi, phải cuộn mới thấy
    expect(rect(screen.getByRole('list', { name: 'Đĩa nhúng' })).top).toBeGreaterThanOrEqual(rect(screen.getByTestId('pot')).bottom - 1)
  })

  it('AC-GAME-21: kéo món vào nồi vẫn thả được sau khi đổi touch-action (như AC-GAME-02)', async () => {
    await open({ width: 390, height: 844 })
    drag(plateItem('Cay'), screen.getByTestId('pot-slot-1'))
    drag(plateItem('Cười'), screen.getByTestId('pot-slot-2'))
    await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('boiling'), { timeout: 2000, interval: 20 })
    await waitFor(() => expect(screen.getAllByTestId('table-item').map((e) => e.dataset.name)).toContain('Tới Công Chuyện'), { timeout: 3000 })
  })
})

// ================================================================ AC-DAILY-16
describe('ui2 thẻ thử thách nổi bật (AC-DAILY-16)', () => {
  it.each([
    { name: 'PC', width: 1366, height: 768 },
    { name: 'mobile', width: 390, height: 844 },
  ])('AC-DAILY-16: emoji và gợi ý cỡ chữ lớn hơn chữ thường của trang, nền thẻ khác nền trang ($name)', async (vp) => {
    await open(vp)
    const card = screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })
    const base = parseFloat(getComputedStyle(document.body).fontSize)
    const hint = within(card).getByText('gợi ý')
    expect(parseFloat(getComputedStyle(hint).fontSize), 'gợi ý phải lớn hơn chữ thường').toBeGreaterThan(base)
    const emoji = Array.from(card.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent?.trim() === '🍜')
    expect(emoji, 'thiếu emoji của món').toBeTruthy()
    expect(parseFloat(getComputedStyle(emoji!).fontSize)).toBeGreaterThan(base)

    const bg = getComputedStyle(card).backgroundColor
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')
    expect(bg).not.toBe(getComputedStyle(document.body).backgroundColor)

    const label = within(card).getByText('Thử thách')
    const lead = within(card).getByText('Ghép ra món bí ẩn này trên bàn lẩu')
    expect(rect(label).bottom).toBeLessThanOrEqual(rect(lead).top + 1)
    expect(within(card).getByText(/Mẻ mới sau/)).toBeTruthy()
  })
})

// ================================================================ AC-DAILY-17 (CSS thật: thuộc tính hidden phải ẩn được khu bàn)
describe('ui2 tab bảng xếp hạng (AC-DAILY-17)', () => {
  it('AC-DAILY-17: chọn tab "Bảng xếp hạng" thì mặt bàn và Đĩa không còn hiển thị; quay lại "Bàn lẩu" thì hiện lại', async () => {
    await open({ width: 1366, height: 768 })
    const table = screen.getByTestId('table')
    expect(rect(table).height).toBeGreaterThan(0)
    screen.getByRole('tab', { name: 'Bảng xếp hạng' }).click()
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Bảng xếp hạng' }).getAttribute('aria-selected')).toBe('true'))
    const box = rect(table)
    expect(box.width * box.height, 'mặt bàn vẫn hiện dưới tab Bảng xếp hạng').toBe(0)
    expect(table.checkVisibility()).toBe(false)
    screen.getByRole('tab', { name: 'Bàn lẩu' }).click()
    await waitFor(() => expect(rect(screen.getByTestId('table')).height).toBeGreaterThan(0))
  })
})
