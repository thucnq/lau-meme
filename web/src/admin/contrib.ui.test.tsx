// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho mục "Đề xuất meme" của trang quản trị: AC-CONTRIB-07 (xem, sửa) và AC-CONTRIB-08 (duyệt, từ chối).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (thêm vào AdminApp; token ở sessionStorage 'laumeme-admin.token', xem tier.ui.test.tsx)
 *   - Thẻ (role="tab") "Đề xuất meme". Mở thì GET /api/admin/contributions?status=pending&page=1&size=20 kèm Bearer (phân trang
 *     từ 1 như các mục khác).
 *   - <select> có nhãn "Trạng thái" với đúng 3 option pending / approved / rejected, nhãn "Chờ duyệt" / "Đã duyệt" / "Bị từ chối";
 *     đổi thì tải lại với status mới.
 *   - Bảng (<tr>) mỗi đề xuất: tên hai phần tử của cặp, tên, biểu tượng, mô tả, link ảnh DẠNG CHỮ (không <img>, không <a>, không
 *     fetch tới link), nickname, thời điểm tạo. Mỗi dòng đang chờ có nút "Sửa", "Duyệt", "Từ chối".
 *   - "Sửa": ô "Tên meme", "Biểu tượng", "Mô tả", "Link ảnh" (điền sẵn giá trị hiện tại) và nút "Lưu" -> PATCH
 *     /api/admin/contributions/<id> chỉ gồm trường đã đổi; lỗi -> role="alert" có `detail`.
 *   - "Duyệt": <textarea> "Gợi ý ảnh", <select> "Tier" (1-5, mặc định 1) và nút "Xác nhận duyệt" -> POST
 *     /api/admin/contributions/<id>/approve {image_hint, tier} (tier là số); lỗi -> role="alert".
 *   - "Từ chối": ô "Lý do" và nút "Xác nhận từ chối" -> POST .../<id>/reject {reason}; lỗi -> role="alert".
 *   - Thao tác thành công thì tải lại danh sách. Có phân trang khi total > size (nút sang trang sau).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')
const ID1 = '00000000-0000-4000-8000-000000000001'
const ID2 = '00000000-0000-4000-8000-000000000002'
const ID3 = '00000000-0000-4000-8000-000000000003'
const HINT = 'một ly cà phê đen đang chạy deadline'
const STATUS_LABELS: Array<[string, string]> = [
  ['pending', 'Chờ duyệt'],
  ['approved', 'Đã duyệt'],
  ['rejected', 'Bị từ chối'],
]

type Starter = { id: string; name: string; emoji: string }
type Row = {
  id: string
  a: Starter
  b: Starter
  name: string
  emoji: string | null
  description: string | null
  image_url: string | null
  status: 'pending' | 'approved' | 'rejected'
  reject_reason: string | null
  image_hint: string | null
  in_catalog: boolean
  tier: number
  element_id: string | null
  nickname: string
  created_at: string
  decided_at: string | null
}
const starter = (name: string, emoji: string): Starter => ({ id: name.padEnd(43, 'x').slice(0, 43), name, emoji })
const mk = (id: string, name: string, over: Partial<Row> = {}): Row => ({
  id,
  a: starter('Deadline', '⏰'),
  b: starter('Cà Phê', '🫖'),
  name,
  emoji: '☕',
  description: 'Uống để thức tới sáng',
  image_url: 'https://example.com/a.png',
  status: 'pending',
  reject_reason: null,
  image_hint: null,
  in_catalog: false,
  tier: 1,
  element_id: null,
  nickname: 'Bún Chả',
  created_at: '2026-10-20T08:00:00.000Z',
  decided_at: null,
  ...over,
})

const reply = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })
const problem = (status: number, title: string, detail?: string) =>
  reply({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) }, status, 'application/problem+json')
const urlOf = (input: RequestInfo | URL): URL => new URL(String(input instanceof Request ? input.url : input), window.location.href)

function authOf(init?: RequestInit): string | null {
  const h = init?.headers
  if (!h) return null
  if (h instanceof Headers) return h.get('Authorization')
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null
  const rec = h as Record<string, string>
  const key = Object.keys(rec).find((k) => k.toLowerCase() === 'authorization')
  return key ? (rec[key] ?? null) : null
}

let pending: Row[]
let approved: Row[]
let rejected: Row[]
let total: number | null // ép total (để thử phân trang)
let failNext: { method: string; re: RegExp; status: number; title: string; detail: string } | null
let fetchMock: ReturnType<typeof vi.fn>

type Call = { method: string; url: URL; body: unknown; auth: string | null }
const calls = (): Call[] =>
  fetchMock.mock.calls.map(([input, init]) => {
    const i = init as RequestInit | undefined
    let body: unknown = null
    if (typeof i?.body === 'string') {
      try {
        body = JSON.parse(i.body)
      } catch {
        body = i.body
      }
    }
    return { method: (i?.method ?? 'GET').toUpperCase(), url: urlOf(input as RequestInfo | URL), body, auth: authOf(i) }
  })
const listGets = () => calls().filter((c) => c.method === 'GET' && c.url.pathname === '/api/admin/contributions')
const patches = () => calls().filter((c) => c.method === 'PATCH' && /^\/api\/admin\/contributions\/[^/]+$/.test(c.url.pathname))
const approves = () => calls().filter((c) => c.method === 'POST' && /^\/api\/admin\/contributions\/[^/]+\/approve$/.test(c.url.pathname))
const rejects = () => calls().filter((c) => c.method === 'POST' && /^\/api\/admin\/contributions\/[^/]+\/reject$/.test(c.url.pathname))

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  pending = [mk(ID1, 'Cà Phê Chạy Deadline'), mk(ID2, 'Meme Thứ Hai', { emoji: null, description: null, image_url: null, nickname: 'Thực khách ẩn danh' })]
  approved = [mk(ID3, 'Meme Đã Duyệt', { status: 'approved', tier: 3, element_id: 'E'.repeat(43), image_hint: HINT, decided_at: '2026-10-20T09:00:00.000Z' })]
  rejected = []
  total = null
  failNext = null
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const path = url.pathname
    if (!path.startsWith('/api/admin/')) return problem(404, 'Không tìm thấy')
    if (authOf(init) !== `Bearer ${GOOD}`) return problem(401, 'Chưa xác thực')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (failNext && failNext.method === method && failNext.re.test(path)) {
      const f = failNext
      failNext = null
      return problem(f.status, f.title, f.detail)
    }
    if (method === 'GET' && path === '/api/admin/contributions') {
      const status = url.searchParams.get('status') ?? 'pending'
      const items = status === 'approved' ? approved : status === 'pending' ? pending : status === 'rejected' ? rejected : []
      const size = Number(url.searchParams.get('size') ?? 50)
      return reply({ page: Number(url.searchParams.get('page') ?? 1), size, total: total ?? items.length, items })
    }
    const edit = /^\/api\/admin\/contributions\/([^/]+)$/.exec(path)
    if (method === 'PATCH' && edit) {
      const row = pending.find((r) => r.id === edit[1])
      if (!row) return problem(404, 'Không tìm thấy')
      Object.assign(row, JSON.parse(String(init?.body ?? '{}')))
      return reply(row)
    }
    const decide = /^\/api\/admin\/contributions\/([^/]+)\/(approve|reject)$/.exec(path)
    if (method === 'POST' && decide) {
      const row = pending.find((r) => r.id === decide[1])
      if (!row) return problem(404, 'Không tìm thấy')
      pending = pending.filter((r) => r !== row)
      return reply({ ...row, status: decide[2] === 'approve' ? 'approved' : 'rejected' })
    }
    return reply({ page: 1, size: 50, total: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

const rowOf = (name: string): HTMLElement => {
  const row = screen.queryAllByRole('row').find((r) => (r.textContent ?? '').includes(name))
  if (!row) throw new Error(`Không có dòng "${name}"`)
  return row
}
async function openTab(): Promise<void> {
  render(<AdminApp />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Đề xuất meme' }))
  await waitFor(() => expect(rowOf('Cà Phê Chạy Deadline')).toBeTruthy())
}
const btn = (row: HTMLElement, name: string) => within(row).getByRole('button', { name })

describe('admin ui: đề xuất meme', () => {
  it('AC-CONTRIB-07: có thẻ "Đề xuất meme"; mở thì GET /api/admin/contributions?status=pending&page=1&size=20 kèm Bearer và liệt kê đề xuất chờ duyệt', async () => {
    await openTab()
    const [first] = listGets()
    expect(first).toBeTruthy()
    expect(first!.auth).toBe(`Bearer ${GOOD}`)
    expect(first!.url.searchParams.get('status')).toBe('pending')
    expect(first!.url.searchParams.get('page')).toBe('1')
    expect(first!.url.searchParams.get('size')).toBe('20')
    expect(rowOf('Meme Thứ Hai')).toBeTruthy()
    expect(() => rowOf('Meme Đã Duyệt')).toThrow()
  })

  it('AC-CONTRIB-07: mỗi dòng hiện cặp, tên, biểu tượng, mô tả, link ảnh dạng chữ (không <img>, không <a>, không tải ảnh), nickname và thời điểm', async () => {
    await openTab()
    const row = rowOf('Cà Phê Chạy Deadline')
    const text = row.textContent ?? ''
    for (const part of ['Deadline', 'Cà Phê', 'Cà Phê Chạy Deadline', '☕', 'Uống để thức tới sáng', 'https://example.com/a.png', 'Bún Chả']) {
      expect(text, part).toContain(part)
    }
    expect(text).toMatch(/2026|20\/10/)
    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('a')).toBeNull()
    expect(document.querySelector('img[src*="example.com"]')).toBeNull()
    expect(calls().some((c) => c.url.hostname === 'example.com')).toBe(false)
    expect(rowOf('Meme Thứ Hai').textContent).toContain('Thực khách ẩn danh')
    for (const name of ['Sửa', 'Duyệt', 'Từ chối']) expect(btn(row, name)).toBeTruthy()
  })

  it('AC-CONTRIB-07: ô chọn "Trạng thái" có 3 lựa chọn Chờ duyệt / Đã duyệt / Bị từ chối; đổi sang "approved" tải lại với status=approved', async () => {
    await openTab()
    const select = screen.getByLabelText('Trạng thái') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(Array.from(select.options).map((o) => [o.value, (o.textContent ?? '').trim()])).toEqual(STATUS_LABELS)
    expect(select.value).toBe('pending')

    fireEvent.change(select, { target: { value: 'approved' } })
    await waitFor(() => expect(listGets().some((c) => c.url.searchParams.get('status') === 'approved')).toBe(true))
    await waitFor(() => expect(rowOf('Meme Đã Duyệt')).toBeTruthy())
    expect(() => rowOf('Cà Phê Chạy Deadline')).toThrow()
  })

  it('AC-CONTRIB-07: nhiều hơn 20 đề xuất thì có phân trang và sang trang sau tải page=2 cùng size=20', async () => {
    total = 45
    await openTab()
    const next = screen.getAllByRole('button').find((b) => /trang sau|sau|tiếp|next|›|»/i.test((b.textContent ?? '') + (b.getAttribute('aria-label') ?? '')))
    expect(next, 'phải có nút sang trang sau khi total > size').toBeTruthy()
    fireEvent.click(next!)
    await waitFor(() => expect(listGets().some((c) => c.url.searchParams.get('page') === '2')).toBe(true))
    expect(listGets().find((c) => c.url.searchParams.get('page') === '2')!.url.searchParams.get('size')).toBe('20')
    expect(listGets().find((c) => c.url.searchParams.get('page') === '2')!.url.searchParams.get('status')).toBe('pending')
  })

  it('AC-CONTRIB-07: "Sửa" hiện 4 ô điền sẵn; đổi tên rồi "Lưu" gửi PATCH chỉ có trường đã đổi kèm Bearer, rồi tải lại danh sách', async () => {
    await openTab()
    fireEvent.click(btn(rowOf('Cà Phê Chạy Deadline'), 'Sửa'))
    const name = screen.getByLabelText('Tên meme') as HTMLInputElement
    for (const label of ['Biểu tượng', 'Mô tả', 'Link ảnh']) expect(screen.getByLabelText(label), label).toBeTruthy()
    expect(name.value).toBe('Cà Phê Chạy Deadline')
    expect((screen.getByLabelText('Biểu tượng') as HTMLInputElement).value).toBe('☕')

    const getsBefore = listGets().length
    fireEvent.change(name, { target: { value: 'Cà Phê Thức Đêm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    await waitFor(() => expect(patches()).toHaveLength(1))
    const [patch] = patches()
    expect(patch!.url.pathname).toBe(`/api/admin/contributions/${ID1}`)
    expect(patch!.body).toEqual({ name: 'Cà Phê Thức Đêm' })
    expect(patch!.auth).toBe(`Bearer ${GOOD}`)
    await waitFor(() => expect(listGets().length).toBeGreaterThan(getsBefore))
    await waitFor(() => expect(rowOf('Cà Phê Thức Đêm')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-CONTRIB-07: đổi nhiều trường (biểu tượng, mô tả, link) thì PATCH có đủ các trường đã đổi và không có trường chưa đổi', async () => {
    await openTab()
    fireEvent.click(btn(rowOf('Cà Phê Chạy Deadline'), 'Sửa'))
    fireEvent.change(screen.getByLabelText('Biểu tượng'), { target: { value: '🫖' } })
    fireEvent.change(screen.getByLabelText('Mô tả'), { target: { value: 'Mô tả mới' } })
    fireEvent.change(screen.getByLabelText('Link ảnh'), { target: { value: 'https://example.com/new.png' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]!.body).toEqual({ emoji: '🫖', description: 'Mô tả mới', image_url: 'https://example.com/new.png' })
  })

  it('AC-CONTRIB-07: sửa bị từ chối (409 hoặc 400) thì chi tiết lỗi hiện trong role="alert"', async () => {
    await openTab()
    failNext = { method: 'PATCH', re: /contributions\//, status: 409, title: 'Xung đột', detail: 'Tên trùng phần tử đã có' }
    fireEvent.click(btn(rowOf('Cà Phê Chạy Deadline'), 'Sửa'))
    fireEvent.change(screen.getByLabelText('Tên meme'), { target: { value: 'Stonks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Tên trùng phần tử đã có')
    expect(patches()).toHaveLength(1)
  })

  it('AC-CONTRIB-08: "Duyệt" hiện ô "Gợi ý ảnh" và ô chọn "Tier" 1-5 mặc định 1; xác nhận gửi POST approve {image_hint, tier: 1} rồi tải lại', async () => {
    await openTab()
    fireEvent.click(btn(rowOf('Cà Phê Chạy Deadline'), 'Duyệt'))
    const hint = screen.getByLabelText('Gợi ý ảnh') as HTMLTextAreaElement
    expect(hint.tagName).toBe('TEXTAREA')
    const tier = screen.getByLabelText('Tier') as HTMLSelectElement
    expect(Array.from(tier.options).map((o) => o.value)).toEqual(['1', '2', '3', '4', '5'])
    expect(tier.value).toBe('1')

    const getsBefore = listGets().length
    fireEvent.change(hint, { target: { value: HINT } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }))
    await waitFor(() => expect(approves()).toHaveLength(1))
    const [post] = approves()
    expect(post!.url.pathname).toBe(`/api/admin/contributions/${ID1}/approve`)
    expect(post!.body).toEqual({ image_hint: HINT, tier: 1 })
    expect(post!.auth).toBe(`Bearer ${GOOD}`)
    await waitFor(() => expect(listGets().length).toBeGreaterThan(getsBefore))
    await waitFor(() => expect(() => rowOf('Cà Phê Chạy Deadline')).toThrow())
  })

  it('AC-CONTRIB-08: chọn tier 3 thì POST approve mang tier là số 3', async () => {
    await openTab()
    fireEvent.click(btn(rowOf('Meme Thứ Hai'), 'Duyệt'))
    fireEvent.change(screen.getByLabelText('Gợi ý ảnh'), { target: { value: HINT } })
    fireEvent.change(screen.getByLabelText('Tier'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }))
    await waitFor(() => expect(approves()).toHaveLength(1))
    const body = approves()[0]!.body as { image_hint: string; tier: unknown }
    expect(approves()[0]!.url.pathname).toBe(`/api/admin/contributions/${ID2}/approve`)
    expect(body).toEqual({ image_hint: HINT, tier: 3 })
    expect(typeof body.tier).toBe('number')
  })

  it('AC-CONTRIB-08: duyệt bị từ chối (409 hoặc 400) thì chi tiết lỗi hiện trong role="alert"', async () => {
    await openTab()
    failNext = { method: 'POST', re: /\/approve$/, status: 409, title: 'Xung đột', detail: 'Cặp đã có công thức' }
    fireEvent.click(btn(rowOf('Cà Phê Chạy Deadline'), 'Duyệt'))
    fireEvent.change(screen.getByLabelText('Gợi ý ảnh'), { target: { value: HINT } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Cặp đã có công thức')
  })

  it('AC-CONTRIB-08: "Từ chối" hiện ô "Lý do"; xác nhận gửi POST reject {reason} rồi tải lại danh sách', async () => {
    await openTab()
    fireEvent.click(btn(rowOf('Meme Thứ Hai'), 'Từ chối'))
    const reason = screen.getByLabelText('Lý do') as HTMLInputElement
    const getsBefore = listGets().length
    fireEvent.change(reason, { target: { value: 'Trùng ý với Stonks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận từ chối' }))
    await waitFor(() => expect(rejects()).toHaveLength(1))
    const [post] = rejects()
    expect(post!.url.pathname).toBe(`/api/admin/contributions/${ID2}/reject`)
    expect(post!.body).toEqual({ reason: 'Trùng ý với Stonks' })
    expect(post!.auth).toBe(`Bearer ${GOOD}`)
    await waitFor(() => expect(listGets().length).toBeGreaterThan(getsBefore))
    await waitFor(() => expect(() => rowOf('Meme Thứ Hai')).toThrow())
  })

  it('AC-CONTRIB-14: duyệt xong hiện thông báo role="status" "Đã duyệt. Meme lên danh mục và game ở mẻ kế tiếp", vẫn còn sau khi danh sách tải lại', async () => {
    await openTab()
    const NOTICE = 'Đã duyệt. Meme lên danh mục và game ở mẻ kế tiếp'
    const notice = () => screen.queryAllByRole('status').find((el) => (el.textContent ?? '').trim() === NOTICE)
    expect(notice()).toBeUndefined() // chưa duyệt thì chưa có thông báo

    const getsBefore = listGets().length
    fireEvent.click(btn(rowOf('Cà Phê Chạy Deadline'), 'Duyệt'))
    fireEvent.change(screen.getByLabelText('Gợi ý ảnh'), { target: { value: HINT } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }))
    await waitFor(() => expect(approves()).toHaveLength(1))
    await waitFor(() => expect(notice()).toBeTruthy())
    // danh sách tải lại, dòng đã duyệt rời khỏi "Chờ duyệt", thông báo vẫn còn
    await waitFor(() => expect(listGets().length).toBeGreaterThan(getsBefore))
    await waitFor(() => expect(() => rowOf('Cà Phê Chạy Deadline')).toThrow())
    expect(notice()).toBeTruthy()
  })

  it('AC-CONTRIB-14: duyệt bị máy chủ từ chối thì không hiện thông báo thành công', async () => {
    await openTab()
    failNext = { method: 'POST', re: /\/approve$/, status: 409, title: 'Xung đột', detail: 'Cặp đã có công thức' }
    fireEvent.click(btn(rowOf('Cà Phê Chạy Deadline'), 'Duyệt'))
    fireEvent.change(screen.getByLabelText('Gợi ý ảnh'), { target: { value: HINT } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }))
    await screen.findByRole('alert')
    expect(screen.queryAllByRole('status').some((el) => (el.textContent ?? '').includes('Meme lên danh mục'))).toBe(false)
  })

  it('AC-CONTRIB-14: lọc "Đã duyệt": dòng in_catalog=false ghi "Chờ mẻ kế tiếp", dòng in_catalog=true thì không', async () => {
    const WAIT = 'Chờ mẻ kế tiếp'
    approved = [
      mk(ID3, 'Meme Chưa Lên Danh Mục', { status: 'approved', element_id: 'E'.repeat(43), image_hint: HINT, decided_at: '2026-10-26T09:00:00.000Z', in_catalog: false }),
      mk(ID2, 'Meme Đã Có Trong Danh Mục', { status: 'approved', element_id: 'F'.repeat(43), image_hint: HINT, decided_at: '2026-10-20T09:00:00.000Z', in_catalog: true }),
    ]
    await openTab()
    // đề xuất đang chờ duyệt không ghi nhãn này
    expect(rowOf('Cà Phê Chạy Deadline').textContent).not.toContain(WAIT)

    fireEvent.change(screen.getByLabelText('Trạng thái'), { target: { value: 'approved' } })
    await waitFor(() => expect(rowOf('Meme Chưa Lên Danh Mục')).toBeTruthy())
    expect(within(rowOf('Meme Chưa Lên Danh Mục')).getByText(WAIT)).toBeTruthy()
    expect(rowOf('Meme Đã Có Trong Danh Mục').textContent).not.toContain(WAIT)
  })

  it('AC-CONTRIB-14: lọc "Bị từ chối": dòng bị từ chối không bao giờ ghi "Chờ mẻ kế tiếp"', async () => {
    rejected = [mk(ID3, 'Meme Bị Loại', { status: 'rejected', reject_reason: 'Trùng ý với Stonks', decided_at: '2026-10-20T09:00:00.000Z', in_catalog: false })]
    await openTab()
    fireEvent.change(screen.getByLabelText('Trạng thái'), { target: { value: 'rejected' } })
    await waitFor(() => expect(rowOf('Meme Bị Loại')).toBeTruthy())
    expect(rowOf('Meme Bị Loại').textContent).not.toContain('Chờ mẻ kế tiếp')
  })

  it('AC-CONTRIB-08: từ chối bị máy chủ trả lỗi (400 thiếu lý do) thì chi tiết lỗi hiện trong role="alert"', async () => {
    await openTab()
    failNext = { method: 'POST', re: /\/reject$/, status: 400, title: 'Dữ liệu không hợp lệ', detail: 'Lý do phải từ 1 đến 200 ký tự' }
    fireEvent.click(btn(rowOf('Meme Thứ Hai'), 'Từ chối'))
    fireEvent.change(screen.getByLabelText('Lý do'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận từ chối' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Lý do phải từ 1 đến 200 ký tự')
  })
})
