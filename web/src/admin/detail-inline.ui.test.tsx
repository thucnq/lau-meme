// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance test cho trang quản trị, phần web (thêm 2026-10-31):
 *   AC-ADMIN-18  chi tiết hiện thành một dòng trải hết bảng ngay dưới dòng vừa bấm, không ở cuối trang.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (token ở sessionStorage 'laumeme-admin.token')
 *   - Mục "Nội dung": bấm "Sửa <tên>" thì <section aria-label="Sửa <tên>"> nằm trong <tr> liền sau <tr> của phần tử đó; ô chứa nó
 *     có colSpan bằng số cột của bảng. Bấm "Công thức" thì <section aria-label="Công thức của <tên>"> cũng nằm ngay dưới dòng đó.
 *     Bấm lại cùng nút thì phần đó đóng. Mở "Sửa" ở dòng khác thì dòng cũ đóng.
 *   - Mục "Bị chặn": bấm "Xem <tên>" thì <section aria-label="Chi tiết <tên>"> nằm trong <tr> liền sau <tr> của dòng đó.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')

const id = (n: number) => String.fromCharCode(64 + n).repeat(43)
const element = (n: number) => ({
  id: id(n),
  name: `Ui Món ${n}`,
  emoji: '🍲',
  depth: 1,
  state: 'active',
  image_key: null,
  image_state: 'none',
  last_version: 1,
  tier: 1,
  tier_source: 'auto',
  auto_tier: 1,
  image_source: null,
})
const rejected = (n: number) => ({
  id: `0190b1c2-0000-7000-8000-${String(n).padStart(12, '0')}`,
  name: `Ui K ${n}`,
  emoji: '😡',
  description: null,
  daily_hint: null,
  image_hint: null,
  source_name: 'Reddit',
  source_url: `https://example.com/bai-${n}`,
  context: `Ngữ cảnh ${n}`,
  reasons: [{ code: 'politics', label: 'Chính trị' }],
  step: 'layer2',
  status: 'blocked',
  seen_count: 1,
  first_batch_id: '0190b1c2-0000-7000-8000-00000000b001',
  last_batch_id: '0190b1c2-0000-7000-8000-00000000b001',
  first_seen_at: '2026-10-20T05:00:00.000Z',
  last_seen_at: '2026-10-28T05:00:00.000Z',
  edited_at: null,
  decided_at: null,
  element_id: null,
  a: null,
  b: null,
  tier: null,
})
const ELEMENTS = [1, 2, 3, 4, 5].map(element)
const REJECTED = [1, 2, 3, 4, 5].map(rejected)

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const page = (items: unknown[]) => reply({ items, page: 1, size: 50, total: items.length })

beforeEach(() => {
  sessionStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input), window.location.href)
      const path = url.pathname
      if (path === '/api/admin/reports') return page([])
      if (path === '/api/admin/elements') return page(ELEMENTS)
      if (path === '/api/admin/recipes') return page([])
      if (path === '/api/admin/rejected') return page(REJECTED)
      const el = ELEMENTS.find((e) => path === `/api/admin/elements/${e.id}`)
      if (el) {
        const published = { name: el.name, emoji: el.emoji, description: null, daily_hint: null, image_hint: null, origin: 'vn' }
        return reply({ id: el.id, published, edit: null, pending: false, aliases: [], state: 'active', tier: 1, tier_source: 'auto', image_key: null, image_source: null })
      }
      const rej = REJECTED.find((r) => path === `/api/admin/rejected/${r.id}`)
      if (rej) return reply(rej)
      return reply({ type: 'about:blank', title: 'Không tìm thấy', status: 404 }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The section must sit in the <tr> right after `row`, in one cell spanning every column of the table. */
function expectRightBelow(section: HTMLElement, row: HTMLElement) {
  const detailRow = section.closest('tr')
  expect(detailRow).not.toBeNull()
  expect(row.nextElementSibling).toBe(detailRow)
  const cell = section.closest('td')!
  const columns = row.closest('table')!.querySelectorAll('thead th').length
  expect(cell.colSpan).toBe(columns)
}

const openTab = async (name: string) => {
  render(<AdminApp />)
  fireEvent.click(await screen.findByRole('tab', { name }))
}

describe('AC-ADMIN-18 chi tiết ngay dưới dòng vừa bấm', () => {
  it('AC-ADMIN-18: "Sửa" và "Công thức" ở "Nội dung" hiện ngay dưới dòng giữa trang, bấm lại thì đóng', async () => {
    await openTab('Nội dung')
    const edit = await screen.findByRole('button', { name: 'Sửa Ui Món 3' })
    const row = edit.closest('tr')!
    fireEvent.click(edit)
    expectRightBelow(await screen.findByRole('region', { name: 'Sửa Ui Món 3' }), row)

    fireEvent.click(within(row).getByRole('button', { name: 'Công thức' }))
    expectRightBelow(await screen.findByRole('region', { name: 'Công thức của Ui Món 3' }), row)

    fireEvent.click(edit)
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Sửa Ui Món 3' })).toBeNull())
    fireEvent.click(within(row).getByRole('button', { name: 'Công thức' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Công thức của Ui Món 3' })).toBeNull())
    expect(row.nextElementSibling).toBe(screen.getByRole('button', { name: 'Sửa Ui Món 4' }).closest('tr'))

    // a second row's "Sửa" moves the form under that row
    fireEvent.click(edit)
    await screen.findByRole('region', { name: 'Sửa Ui Món 3' })
    const other = screen.getByRole('button', { name: 'Sửa Ui Món 5' })
    fireEvent.click(other)
    expectRightBelow(await screen.findByRole('region', { name: 'Sửa Ui Món 5' }), other.closest('tr')!)
    expect(screen.queryByRole('region', { name: 'Sửa Ui Món 3' })).toBeNull()
  })

  it('AC-ADMIN-18: "Xem" ở "Bị chặn" hiện chi tiết ngay dưới dòng giữa trang', async () => {
    await openTab('Bị chặn')
    const view = await screen.findByRole('button', { name: 'Xem Ui K 3' })
    fireEvent.click(view)
    expectRightBelow(await screen.findByRole('region', { name: 'Chi tiết Ui K 3' }), view.closest('tr')!)
  })
})
