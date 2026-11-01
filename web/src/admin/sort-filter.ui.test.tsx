// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance test cho trang quản trị, phần web (thêm 2026-10-31):
 *   AC-ADMIN-19  "Sắp xếp" (Tên, Ngày tạo, Ngày cập nhật, Độ sâu, Tier) và chiều (Tăng dần, Giảm dần) gửi `sort`, `order`;
 *                bảng có cột Ngày tạo, Ngày cập nhật cho từng phần tử.
 *   AC-ADMIN-20  Bộ lọc "Ảnh" (Tất cả, Chưa có ảnh, Đang hiện, Đang ẩn) gửi `image` = none | active | hidden; "Tất cả" không gửi `image`.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (token ở sessionStorage 'laumeme-admin.token')
 *   - Mục "Nội dung": ô chọn (combobox) tên "Sắp xếp" với 5 lựa chọn Tên, Ngày tạo, Ngày cập nhật, Độ sâu, Tier;
 *     ô chọn tên bắt đầu bằng "Chiều" (ví dụ "Chiều sắp xếp") với 2 lựa chọn Tăng dần, Giảm dần;
 *     ô chọn tên "Ảnh" với 4 lựa chọn Tất cả, Chưa có ảnh, Đang hiện, Đang ẩn.
 *   - Mỗi lần đổi một ô, giao diện gọi lại GET /api/admin/elements với query tương ứng (kèm các bộ lọc còn lại).
 *   - Bảng có 2 tiêu đề cột (columnheader) "Ngày tạo" và "Ngày cập nhật"; mỗi dòng hiện ngày dạng dd/mm/yyyy của created_at, updated_at.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')

const id = (n: number) => String.fromCharCode(64 + n).repeat(43)
const element = (n: number, created_at: string, updated_at: string) => ({
  id: id(n),
  name: `Sx Món ${n}`,
  emoji: '🍲',
  depth: n,
  state: 'active',
  image_key: null,
  image_state: 'none',
  last_version: 1,
  tier: 1,
  tier_source: 'auto',
  auto_tier: 1,
  image_source: null,
  created_at,
  updated_at,
})
const ELEMENTS = [element(1, '2026-10-20T05:00:00.000Z', '2026-10-25T05:00:00.000Z'), element(2, '2026-10-21T05:00:00.000Z', '2026-10-27T05:00:00.000Z')]

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const page = (items: unknown[]) => reply({ items, page: 1, size: 50, total: items.length })

let elementCalls: URL[] = []
const lastCall = () => elementCalls[elementCalls.length - 1]!

beforeEach(() => {
  elementCalls = []
  sessionStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input), window.location.href)
      if (url.pathname === '/api/admin/reports') return page([])
      if (url.pathname === '/api/admin/elements') {
        elementCalls.push(url)
        return page(ELEMENTS)
      }
      return reply({ type: 'about:blank', title: 'Không tìm thấy', status: 404 }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const openContent = async () => {
  render(<AdminApp />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Nội dung' }))
  await screen.findByRole('button', { name: 'Sửa Sx Món 1' })
}
/** Picks the option with the given visible text in the combobox with the given accessible name. */
const choose = (name: string | RegExp, option: string) => {
  const select = screen.getByRole('combobox', { name })
  const opt = within(select).getByRole('option', { name: option }) as HTMLOptionElement
  fireEvent.change(select, { target: { value: opt.value } })
}
const optionNames = (name: string | RegExp) => within(screen.getByRole('combobox', { name })).getAllByRole('option').map((o) => o.textContent)

describe('AC-ADMIN-19 sắp xếp "Nội dung"', () => {
  it('AC-ADMIN-19: ô "Sắp xếp" có Tên, Ngày tạo, Ngày cập nhật, Độ sâu, Tier và ô chiều có Tăng dần, Giảm dần', async () => {
    await openContent()
    expect(optionNames('Sắp xếp')).toEqual(['Tên', 'Ngày tạo', 'Ngày cập nhật', 'Độ sâu', 'Tier'])
    expect(optionNames(/^Chiều/)).toEqual(['Tăng dần', 'Giảm dần'])
    // default is Tên, tăng dần (như trước)
    expect((screen.getByRole('combobox', { name: 'Sắp xếp' }) as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Tên')
    expect((screen.getByRole('combobox', { name: /^Chiều/ }) as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Tăng dần')
    const first = lastCall()
    expect(['name', null]).toContain(first.searchParams.get('sort'))
    expect(['asc', null]).toContain(first.searchParams.get('order'))
  })

  it('AC-ADMIN-19: chọn từng khóa sắp xếp gửi sort tương ứng, đổi chiều gửi order', async () => {
    await openContent()
    const keys: Array<[string, string]> = [
      ['Ngày tạo', 'created'],
      ['Ngày cập nhật', 'updated'],
      ['Độ sâu', 'depth'],
      ['Tier', 'tier'],
      ['Tên', 'name'],
    ]
    for (const [label, sort] of keys) {
      const before = elementCalls.length
      choose('Sắp xếp', label)
      await waitFor(() => expect(elementCalls.length).toBeGreaterThan(before))
      expect(lastCall().searchParams.get('sort'), label).toBe(sort)
      expect(['asc', null], label).toContain(lastCall().searchParams.get('order'))
    }

    choose('Sắp xếp', 'Ngày tạo')
    const before = elementCalls.length
    choose(/^Chiều/, 'Giảm dần')
    await waitFor(() => expect(elementCalls.length).toBeGreaterThan(before))
    expect(lastCall().searchParams.get('sort')).toBe('created')
    expect(lastCall().searchParams.get('order')).toBe('desc')

    const again = elementCalls.length
    choose(/^Chiều/, 'Tăng dần')
    await waitFor(() => expect(elementCalls.length).toBeGreaterThan(again))
    expect(lastCall().searchParams.get('order')).toBe('asc')
  })

  it('AC-ADMIN-19: bảng có cột Ngày tạo, Ngày cập nhật và mỗi dòng hiện ngày của phần tử', async () => {
    await openContent()
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim())
    expect(headers).toContain('Ngày tạo')
    expect(headers).toContain('Ngày cập nhật')
    const row1 = screen.getByRole('button', { name: 'Sửa Sx Món 1' }).closest('tr')!
    const row2 = screen.getByRole('button', { name: 'Sửa Sx Món 2' }).closest('tr')!
    expect(row1.textContent).toMatch(/20\/10\/2026/)
    expect(row1.textContent).toMatch(/25\/10\/2026/)
    expect(row2.textContent).toMatch(/21\/10\/2026/)
    expect(row2.textContent).toMatch(/27\/10\/2026/)
  })
})

describe('AC-ADMIN-20 lọc "Nội dung" theo ảnh', () => {
  it('AC-ADMIN-20: bộ lọc "Ảnh" có Tất cả, Chưa có ảnh, Đang hiện, Đang ẩn và gửi image none, active, hidden; Tất cả không gửi image', async () => {
    await openContent()
    expect(optionNames('Ảnh')).toEqual(['Tất cả', 'Chưa có ảnh', 'Đang hiện', 'Đang ẩn'])
    expect(lastCall().searchParams.get('image')).toBeNull()

    const cases: Array<[string, string | null]> = [
      ['Chưa có ảnh', 'none'],
      ['Đang hiện', 'active'],
      ['Đang ẩn', 'hidden'],
      ['Tất cả', null],
    ]
    for (const [label, image] of cases) {
      const before = elementCalls.length
      choose('Ảnh', label)
      await waitFor(() => expect(elementCalls.length).toBeGreaterThan(before))
      expect(lastCall().searchParams.get('image'), label).toBe(image)
    }
  })

  it('AC-ADMIN-20: lọc ảnh giữ nguyên sắp xếp đang chọn', async () => {
    await openContent()
    choose('Sắp xếp', 'Độ sâu')
    choose(/^Chiều/, 'Giảm dần')
    const before = elementCalls.length
    choose('Ảnh', 'Đang ẩn')
    await waitFor(() => expect(elementCalls.length).toBeGreaterThan(before))
    const url = lastCall()
    expect(url.searchParams.get('image')).toBe('hidden')
    expect(url.searchParams.get('sort')).toBe('depth')
    expect(url.searchParams.get('order')).toBe('desc')
  })
})
