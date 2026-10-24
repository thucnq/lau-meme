// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/admin.md, phần web: AC-ADMIN-11 (thống kê kết quả crawl trong mục "Đợt").
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (ngoài những gì admin.ui.test.tsx đã yêu cầu)
 *   AdminApp có tab (role="tab") mà tên bắt đầu bằng "Đợt" (hiện là "Đợt + Audit"). Mở tab gọi
 *   GET /api/admin/batches (hợp đồng BatchPage: items[].stats + summary) với Authorization: Bearer <token>.
 *   Nội dung tab hiện (văn bản, khớp không phân biệt hoa thường, giữa nhãn và số chỉ có ký tự không phải chữ số):
 *     - ô tổng: "Tổng khái niệm đã crawl <n>", "Tổng phần tử đã thêm <n>", "hàng chờ <n>" (số meme đang trong hàng chờ),
 *       "chưa có ảnh <n>" (số phần tử chưa có ảnh);
 *     - mỗi đợt full: "<tên nguồn> <số khái niệm>" cho từng nguồn, nguồn lỗi hiện "<tên nguồn> <loại lỗi>" (không có số),
 *       "thêm <n>", "hàng chờ <n>" (số vào hàng chờ của đợt), "<danh mục> <n>" cho mỗi mục bị chặn, "quota <n>",
 *       "vẽ <n>", "emoji <n>", "chờ vẽ <n>";
 *     - mỗi đợt core: "không crawl";
 *     - chưa có đợt nào: "Chưa có đợt nào".
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')

type Stats = Record<string, unknown>
const run = (i: number, mode: 'core' | 'full', stats: Stats, status = 'success') => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  version: status === 'success' ? 2026102300 + i : null,
  batch_at: `2026-10-2${i}T05:00:00.000Z`,
  mode,
  status,
  failed_step: null,
  rollback_to: null,
  stats,
  issue_url: null,
  created_at: `2026-10-2${i}T05:00:30.000Z`,
})

// Số liệu của từng đợt khác nhau để mỗi khẳng định chỉ có thể đến từ đúng đợt đó.
const OLD_FULL: Stats = {
  crawled: 31,
  added: 2,
  queued: 11,
  queue_size: 13,
  blocked: {},
  source_errors: [],
  quota_used: 17,
  sources: [
    { source: 'Reddit', concepts: 12, error: null },
    { source: 'RSS', concepts: 19, error: null },
  ],
  images: { drawn: 4, fallback: 1, pending: 2 },
  without_image: 77,
}
const LATEST_FULL: Stats = {
  crawled: 60,
  added: 6,
  queued: 50,
  queue_size: 88,
  blocked: { 'chính trị': 3, 'nhạy cảm': 1 },
  source_errors: [{ source: 'Reddit', error: 'RobotsDenied' }],
  quota_used: 42,
  sources: [
    { source: 'Reddit', concepts: null, error: 'RobotsDenied' },
    { source: 'Know Your Meme', concepts: 40, error: null },
    { source: 'Tuổi Trẻ', concepts: 20, error: null },
  ],
  images: { drawn: 20, fallback: 3, pending: 9 },
  without_image: 7,
}
const CORE: Stats = { crawled: 0, added: 0, queued: 0, source_errors: [], quota_used: 0, blocked: {} }

const FULL_PAGE = {
  page: 1,
  size: 50,
  total: 4,
  summary: { crawled_total: 143, added_total: 13, queue_size: 88, without_image: 7 },
  items: [run(4, 'core', CORE), run(3, 'full', LATEST_FULL), run(2, 'full', OLD_FULL), run(1, 'full', OLD_FULL)],
}
const EMPTY_PAGE = {
  page: 1,
  size: 50,
  total: 0,
  summary: { crawled_total: 0, added_total: 0, queue_size: null, without_image: null },
  items: [],
}

const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const emptyPage = () => jsonRes({ page: 1, size: 50, total: 0, items: [] })
const pathOf = (input: RequestInfo | URL): string => new URL(String(input instanceof Request ? input.url : input), window.location.href).pathname

let fetchMock: ReturnType<typeof vi.fn>
function serve(batches: unknown) {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => (pathOf(input) === '/api/admin/batches' ? jsonRes(batches) : emptyPage()))
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

async function openBatches(): Promise<string> {
  render(<AdminApp />)
  const tab = await screen.findByRole('tab', { name: /^Đợt/ })
  fireEvent.click(tab)
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => pathOf(u as RequestInfo | URL) === '/api/admin/batches')).toBe(true))
  return document.body.textContent ?? ''
}
// Chờ tới khi nội dung đợt hiện ra rồi trả về toàn bộ văn bản trang.
async function textWhen(pattern: RegExp): Promise<string> {
  await openBatches()
  await waitFor(() => expect(document.body.textContent ?? '').toMatch(pattern))
  return document.body.textContent ?? ''
}

describe('admin ui: mục Đợt - thống kê crawl', () => {
  it('AC-ADMIN-11: mở mục Đợt gọi API danh sách đợt kèm token quản trị', async () => {
    serve(FULL_PAGE)
    await textWhen(/Tuổi Trẻ/)
    const call = fetchMock.mock.calls.find(([u]) => pathOf(u as RequestInfo | URL) === '/api/admin/batches') as [RequestInfo | URL, RequestInit | undefined]
    const headers = new Headers(call[1]?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${GOOD}`)
  })

  it('AC-ADMIN-11: ô tổng hiện tổng khái niệm đã crawl, tổng phần tử đã thêm, số meme trong hàng chờ và số phần tử chưa có ảnh', async () => {
    serve(FULL_PAGE)
    const text = await textWhen(/Tuổi Trẻ/)
    expect(text).toMatch(/tổng khái niệm đã crawl\D{0,12}143(?!\d)/i)
    expect(text).toMatch(/tổng phần tử đã thêm\D{0,12}13(?!\d)/i)
    expect(text).toMatch(/hàng chờ\D{0,24}88(?!\d)/i)
    expect(text).toMatch(/chưa có ảnh\D{0,24}7(?!\d)/i)
  })

  it('AC-ADMIN-11: mỗi đợt full hiện số khái niệm theo từng nguồn; nguồn lỗi hiện loại lỗi thay vì số', async () => {
    serve(FULL_PAGE)
    const text = await textWhen(/Tuổi Trẻ/)
    expect(text).toMatch(/Know Your Meme\D{0,12}40(?!\d)/)
    expect(text).toMatch(/Tuổi Trẻ\D{0,12}20(?!\d)/)
    expect(text).toMatch(/Reddit\W{0,12}RobotsDenied/)
    // đợt mới nhất có Reddit lỗi nên sau "Reddit" của đợt đó không được có số; các đợt cũ có số riêng (12) nên không lẫn
    expect(text).not.toMatch(/Reddit\W{0,12}0(?!\d)/)
    expect(text).toMatch(/RSS\D{0,12}19(?!\d)/)
    expect(text).toMatch(/Reddit\D{0,12}12(?!\d)/)
  })

  it('AC-ADMIN-11: mỗi đợt hiện số thêm, số vào hàng chờ, bị chặn theo từng danh mục, quota Gemini và ảnh vẽ / về emoji / chờ vẽ', async () => {
    serve(FULL_PAGE)
    const text = await textWhen(/Tuổi Trẻ/)
    expect(text).toMatch(/thêm\D{0,12}6(?!\d)/i)
    expect(text).toMatch(/hàng chờ\D{0,24}50(?!\d)/i)
    expect(text).toMatch(/chính trị\D{0,12}3(?!\d)/i)
    expect(text).toMatch(/nhạy cảm\D{0,12}1(?!\d)/i)
    expect(text).toMatch(/quota\D{0,30}42(?!\d)/i)
    expect(text).toMatch(/vẽ\D{0,16}20(?!\d)/i)
    expect(text).toMatch(/emoji\D{0,16}3(?!\d)/i)
    expect(text).toMatch(/chờ vẽ\D{0,16}9(?!\d)/i)
  })

  it('AC-ADMIN-11: đợt core hiện "không crawl" (đúng 1 đợt core nên đúng 1 lần)', async () => {
    serve(FULL_PAGE)
    await textWhen(/Tuổi Trẻ/)
    expect(screen.getAllByText(/không crawl/i)).toHaveLength(1)
  })

  it('AC-ADMIN-11: chưa có đợt nào thì hiện "Chưa có đợt nào"', async () => {
    serve(EMPTY_PAGE)
    await textWhen(/Chưa có đợt nào/)
    expect(screen.getByText(/Chưa có đợt nào/)).toBeTruthy()
    expect(screen.queryByText(/không crawl/i)).toBeNull()
  })
})
