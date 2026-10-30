// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho trang quản trị, phần web (thêm 2026-10-30, ADR 0022): mục "Bị chặn" và sửa phần tử trong "Nội dung".
 *   AC-ADMIN-13  mục "Bị chặn": danh sách, lọc, tìm theo tên, chi tiết, trạng thái rỗng "Chưa có nội dung bị chặn".
 *   AC-ADMIN-14  sửa tay (Lưu) và "Bỏ chặn"; dòng "Đã thêm" / "Đã duyệt tay" chỉ xem.
 *   AC-ADMIN-15  "Duyệt luôn" chọn A, B, tên, emoji.
 *   AC-ADMIN-16  mục "Nội dung": sửa mọi thuộc tính của phần tử, nhãn "Chờ mẻ kế tiếp".
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (thêm vào AdminApp; token ở sessionStorage 'laumeme-admin.token')
 *   Mục "Bị chặn" (AC-ADMIN-13)
 *   - Tab role="tab" tên "Bị chặn". Mở tab gọi GET /api/admin/rejected (hợp đồng AdminRejectedPage) kèm Authorization Bearer.
 *     Không có dòng nào thì hiện chữ "Chưa có nội dung bị chặn".
 *   - Bảng: mỗi dòng là một <tr> chứa tên, nhãn lý do (reasons[].label), bước ("Lớp 1" / "Lớp 2", không phân biệt hoa thường),
 *     tên nguồn, số lần gặp, và nhãn trạng thái: "Bị chặn", "Đã bỏ chặn - chờ mẻ", "Đã thêm", "Đã duyệt tay".
 *   - Bộ lọc: <select aria-label="Lý do"> (option "Tất cả" và option mang nhãn lý do với value = mã lý do), <select aria-label="Bước">
 *     (option "Tất cả", "Lớp 1" = layer1, "Lớp 2" = layer2), <select aria-label="Trạng thái"> (option "Tất cả", "Bị chặn" = blocked,
 *     "Đã bỏ chặn - chờ mẻ" = unblocked, "Đã thêm" = added, "Đã duyệt tay" = approved), <input aria-label="Tìm theo tên">. Đổi giá
 *     trị (hoặc bấm nút "Tìm" nếu có) thì GET lại với reason / step / status / q tương ứng; "Tất cả" thì không gửi tham số đó.
 *   - Mỗi dòng có nút "Xem <tên>": gọi GET /api/admin/rejected/<id> rồi hiện chi tiết: ngữ cảnh, nguồn, và link nguồn là <a> có
 *     href = source_url, target="_blank", rel chứa "noopener".
 *   Sửa và Bỏ chặn (AC-ADMIN-14), trong chi tiết của dòng "Bị chặn" hoặc "Đã bỏ chặn - chờ mẻ"
 *   - Ô nhập có nhãn "Tên", "Emoji", "Mô tả", "Gợi ý Daily", "Gợi ý ảnh" điền sẵn giá trị hiện tại; nút "Lưu" gửi PATCH
 *     /api/admin/rejected/<id> chỉ gồm trường đã đổi; thành công thì bảng hiện giá trị mới. Nút "Bỏ chặn" gửi POST
 *     /api/admin/rejected/<id>/unblock rồi dòng hiện "Đã bỏ chặn - chờ mẻ". Lỗi problem+json hiện tiêu đề trong role="alert".
 *   - Dòng "Đã thêm" / "Đã duyệt tay": không có nút "Lưu", "Bỏ chặn", "Duyệt luôn" và không có ô nhập sửa được.
 *   Duyệt luôn (AC-ADMIN-15), cùng khu chi tiết, dùng chung các ô "Tên", "Emoji", "Mô tả", "Gợi ý Daily", "Gợi ý ảnh"
 *   - <input aria-label="Tìm phần tử A"> / <input aria-label="Tìm phần tử B"> tìm bằng GET /api/admin/elements?q=<chữ>; mỗi kết quả
 *     có nút "Chọn A <tên>" / "Chọn B <tên>". Nút "Duyệt luôn" bị vô hiệu cho tới khi đã chọn cả A và B, tên và emoji không rỗng;
 *     bấm gửi POST /api/admin/rejected/<id>/approve thân {a, b, name, emoji, ...}; thành công thì dòng hiện "Đã duyệt tay".
 *   Mục "Nội dung" (AC-ADMIN-16)
 *   - Mỗi dòng phần tử có nút "Sửa <tên>": gọi GET /api/admin/elements/<id> (AdminElementDetail) rồi hiện form có "Tên", "Emoji",
 *     "Mô tả", "Gợi ý Daily", "Gợi ý ảnh" và <select aria-label="Nguồn gốc"> (option "VN" = vn, "Quốc tế" = intl), điền sẵn giá trị
 *     đã sửa nếu có, không thì giá trị mẻ gần nhất. "Lưu" gửi PATCH /api/admin/elements/<id> chỉ gồm trường đã đổi. Khi chi tiết có
 *     pending = true thì hiện chữ "Chờ mẻ kế tiếp". Lỗi problem+json hiện trong role="alert".
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')
const EMPTY = 'Chưa có nội dung bị chặn'
const PERMANENT = 'Tên đang bị chặn vĩnh viễn, gỡ chặn tên trước'
const A_ID = 'A'.repeat(43)
const B_ID = 'B'.repeat(43)
const P_ID = 'P'.repeat(43)

type Reason = { code: string; label: string }
type Rej = {
  id: string
  name: string
  emoji: string | null
  description: string | null
  daily_hint: string | null
  image_hint: string | null
  source_name: string
  source_url: string | null
  context: string | null
  reasons: Reason[]
  step: 'layer1' | 'layer2'
  status: 'blocked' | 'unblocked' | 'added' | 'approved'
  seen_count: number
  first_batch_id: string
  last_batch_id: string
  first_seen_at: string
  last_seen_at: string
  edited_at: string | null
  decided_at: string | null
  element_id: string | null
  a: string | null
  b: string | null
  tier: number | null
}
type Detail = {
  id: string
  published: { name: string; emoji: string; description: string | null; daily_hint: string | null; image_hint: string | null; origin: 'vn' | 'intl' | null }
  edit: Record<string, unknown> | null
  pending: boolean
  aliases: string[]
  state: string
  tier: number
  tier_source: string
  image_key: string | null
  image_source: string | null
}

const rej = (n: number, name: string, over: Partial<Rej> = {}): Rej => ({
  id: `0190b1c2-0000-7000-8000-${String(n).padStart(12, '0')}`,
  name,
  emoji: '😡',
  description: 'Mô tả cũ',
  daily_hint: 'Gợi ý Daily cũ',
  image_hint: 'Gợi ý ảnh cũ',
  source_name: 'Reddit',
  source_url: `https://example.com/bai-${n}`,
  context: `Ngữ cảnh của bài ${n}`,
  reasons: [{ code: 'politics', label: 'Chính trị' }],
  step: 'layer2',
  status: 'blocked',
  seen_count: 3,
  first_batch_id: '0190b1c2-0000-7000-8000-00000000b001',
  last_batch_id: '0190b1c2-0000-7000-8000-00000000b002',
  first_seen_at: '2026-10-20T05:00:00.000Z',
  last_seen_at: '2026-10-28T05:00:00.000Z',
  edited_at: null,
  decided_at: null,
  element_id: null,
  a: null,
  b: null,
  tier: null,
  ...over,
})

const reply = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })
const problem = (status: number, title: string) => reply({ type: 'about:blank', title, status }, status, 'application/problem+json')
const urlOf = (input: RequestInfo | URL): URL => new URL(String(input instanceof Request ? input.url : input), window.location.href)

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers
  if (!h) return null
  if (h instanceof Headers) return h.get(name)
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null
  const rec = h as Record<string, string>
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? (rec[key] ?? null) : null
}

let rows: Rej[]
let detail: Detail
let elements: Array<{ id: string; name: string }>
let failWith: { status: number; title: string } | null
let fetchMock: ReturnType<typeof vi.fn>

type Call = { method: string; url: URL; auth: string | null; body: unknown }
const calls = (): Call[] =>
  fetchMock.mock.calls.map(([input, init]) => {
    const i = init as RequestInit | undefined
    let body: unknown = undefined
    if (typeof i?.body === 'string') {
      try {
        body = JSON.parse(i.body)
      } catch {
        body = i.body
      }
    }
    return { method: (i?.method ?? 'GET').toUpperCase(), url: urlOf(input as RequestInfo | URL), auth: headerOf(i, 'Authorization'), body }
  })
const listGets = () => calls().filter((c) => c.method === 'GET' && c.url.pathname === '/api/admin/rejected')
const lastList = () => listGets().at(-1)!
const rejectedCalls = (method: string, suffix = '') =>
  calls().filter((c) => c.method === method && new RegExp(`^/api/admin/rejected/[^/]+${suffix}$`).test(c.url.pathname))
const elementCalls = (method: string) => calls().filter((c) => c.method === method && /^\/api\/admin\/elements\/[^/]+$/.test(c.url.pathname))

const detailOf = (): Detail => ({
  id: P_ID,
  published: { name: 'Ui Phần Tử P', emoji: '🍲', description: 'Mô tả mẻ gần nhất', daily_hint: 'Daily mẻ gần nhất', image_hint: 'Ảnh mẻ gần nhất', origin: 'vn' },
  edit: null,
  pending: false,
  aliases: [],
  state: 'active',
  tier: 1,
  tier_source: 'auto',
  image_key: null,
  image_source: null,
})

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  rows = [
    rej(1, 'Ui K Chính Trị'),
    rej(2, 'Ui K Từ Cấm', { reasons: [{ code: 'banned_term', label: 'Từ cấm' }], step: 'layer1', source_name: 'Tuổi Trẻ', seen_count: 7 }),
    rej(3, 'Ui K Đã Bỏ Chặn', { status: 'unblocked' }),
    rej(4, 'Ui K Đã Thêm', { status: 'added', element_id: 'E'.repeat(43) }),
    rej(5, 'Ui K Duyệt Tay', { status: 'approved', element_id: 'F'.repeat(43), a: A_ID, b: B_ID }),
  ]
  detail = detailOf()
  elements = [
    { id: A_ID, name: 'Ui Món A' },
    { id: B_ID, name: 'Ui Món B' },
  ]
  failWith = null
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    if (!url.pathname.startsWith('/api/admin/')) return problem(404, 'Không tìm thấy')
    if (headerOf(init, 'Authorization') !== `Bearer ${GOOD}`) return problem(401, 'Chưa xác thực')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}

    if (url.pathname === '/api/admin/rejected' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const reason = url.searchParams.get('reason')
      const step = url.searchParams.get('step')
      const status = url.searchParams.get('status')
      const shown = rows.filter(
        (r) =>
          (!q || r.name.toLowerCase().includes(q)) &&
          (!reason || r.reasons.some((x) => x.code === reason)) &&
          (!step || r.step === step) &&
          (!status || r.status === status),
      )
      return reply({ page: 1, size: 50, total: shown.length, items: shown })
    }
    const one = /^\/api\/admin\/rejected\/([^/]+)(\/unblock|\/approve)?$/.exec(url.pathname)
    if (one) {
      const row = rows.find((r) => r.id === one[1])
      if (!row) return problem(404, 'Không tìm thấy')
      if (method === 'GET') return reply(row)
      if (failWith) return problem(failWith.status, failWith.title)
      if (method === 'PATCH') {
        Object.assign(row, body)
        return reply(row)
      }
      if (one[2] === '/unblock') {
        row.status = 'unblocked'
        return reply(row)
      }
      if (one[2] === '/approve') {
        Object.assign(row, { status: 'approved', a: body.a, b: body.b, element_id: 'F'.repeat(43), name: body.name, emoji: body.emoji })
        return reply(row)
      }
    }
    const el = /^\/api\/admin\/elements\/([^/]+)$/.exec(url.pathname)
    if (el) {
      if (method === 'GET') return reply(detail)
      if (failWith) return problem(failWith.status, failWith.title)
      if (method === 'PATCH') {
        detail = { ...detail, edit: { ...(detail.edit ?? {}), ...body }, pending: true }
        return reply(detail)
      }
    }
    if (method === 'GET' && url.pathname === '/api/admin/elements') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const list = [...elements, { id: P_ID, name: 'Ui Phần Tử P' }].filter((e) => e.name.toLowerCase().includes(q))
      return reply({
        page: 1,
        size: 50,
        total: list.length,
        items: list.map((e) => ({
          id: e.id,
          name: e.name,
          emoji: '🍲',
          depth: 3,
          state: 'active',
          image_key: null,
          image_state: 'none',
          image_source: null,
          last_version: 1,
          tier: 1,
          tier_source: 'auto',
          auto_tier: null,
        })),
      })
    }
    return reply({ page: 1, size: 50, total: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  localStorage.clear()
})

const rowOf = (name: string): HTMLElement => {
  const row = screen.queryAllByRole('row').find((r) => (r.textContent ?? '').includes(name))
  if (!row) throw new Error(`Không có dòng "${name}"`)
  return row
}
async function openRejected(): Promise<void> {
  render(<AdminApp />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Bị chặn' }))
  await waitFor(() => expect(listGets().length).toBeGreaterThan(0))
}
async function openDetail(name: string): Promise<void> {
  await openRejected()
  await waitFor(() => expect(rowOf(name)).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: `Xem ${name}` }))
  await waitFor(() => expect(calls().some((c) => c.method === 'GET' && /^\/api\/admin\/rejected\/[^/]+$/.test(c.url.pathname))).toBe(true))
}
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement
const typeInto = (label: string, value: string) => fireEvent.change(field(label), { target: { value } })
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

describe('admin ui: mục "Bị chặn" (AC-ADMIN-13)', () => {
  it('AC-ADMIN-13: tab "Bị chặn" gọi GET /api/admin/rejected kèm token; mỗi dòng hiện tên, nhãn lý do, bước, nguồn, số lần gặp và nhãn trạng thái', async () => {
    await openRejected()
    expect(listGets()[0]!.auth).toBe(`Bearer ${GOOD}`)
    await waitFor(() => expect(rowOf('Ui K Chính Trị')).toBeTruthy())

    const first = rowOf('Ui K Chính Trị').textContent ?? ''
    expect(first).toContain('Chính trị')
    expect(first).toMatch(/lớp 2/i)
    expect(first).toContain('Reddit')
    expect(first).toContain('Bị chặn')

    const second = rowOf('Ui K Từ Cấm').textContent ?? ''
    expect(second).toContain('Từ cấm')
    expect(second).toMatch(/lớp 1/i)
    expect(second).toContain('Tuổi Trẻ')
    expect(second).toMatch(/(^|\D)7(\D|$)/)

    expect(rowOf('Ui K Đã Bỏ Chặn').textContent).toContain('Đã bỏ chặn - chờ mẻ')
    expect(rowOf('Ui K Đã Thêm').textContent).toContain('Đã thêm')
    expect(rowOf('Ui K Duyệt Tay').textContent).toContain('Đã duyệt tay')
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  it('AC-ADMIN-13: không có dòng nào thì hiện "Chưa có nội dung bị chặn"', async () => {
    rows = []
    await openRejected()
    expect(await screen.findByText(EMPTY)).toBeTruthy()
    expect(screen.queryAllByRole('row').some((r) => (r.textContent ?? '').includes('Ui K'))).toBe(false)
  })

  it('AC-ADMIN-13: lọc theo lý do, bước, trạng thái và tìm theo tên gửi GET kèm đúng tham số; "Tất cả" bỏ tham số', async () => {
    await openRejected()
    await waitFor(() => expect(rowOf('Ui K Chính Trị')).toBeTruthy())
    expect(lastList().url.searchParams.get('reason')).toBeFalsy()

    fireEvent.change(screen.getByLabelText('Lý do'), { target: { value: 'banned_term' } })
    await waitFor(() => expect(lastList().url.searchParams.get('reason')).toBe('banned_term'))
    await waitFor(() => expect(screen.queryAllByRole('row').some((r) => (r.textContent ?? '').includes('Ui K Chính Trị'))).toBe(false))
    expect(rowOf('Ui K Từ Cấm')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Lý do'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Bước'), { target: { value: 'layer2' } })
    await waitFor(() => expect(lastList().url.searchParams.get('step')).toBe('layer2'))
    expect(lastList().url.searchParams.get('reason')).toBeFalsy()

    fireEvent.change(screen.getByLabelText('Bước'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Trạng thái'), { target: { value: 'unblocked' } })
    await waitFor(() => expect(lastList().url.searchParams.get('status')).toBe('unblocked'))
    await waitFor(() => expect(screen.queryAllByRole('row').some((r) => (r.textContent ?? '').includes('Ui K Chính Trị'))).toBe(false))
    expect(rowOf('Ui K Đã Bỏ Chặn')).toBeTruthy()
    expect(lastList().url.searchParams.get('step')).toBeFalsy()

    fireEvent.change(screen.getByLabelText('Trạng thái'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Tìm theo tên'), { target: { value: 'từ cấm' } })
    const go = screen.queryByRole('button', { name: 'Tìm' })
    if (go) fireEvent.click(go)
    await waitFor(() => expect(lastList().url.searchParams.get('q')).toBe('từ cấm'))
    expect(lastList().url.searchParams.get('status')).toBeFalsy()
  })

  it('AC-ADMIN-13: ô lọc "Trạng thái" có đủ bốn trạng thái, "Bước" có Lớp 1 và Lớp 2', async () => {
    await openRejected()
    await waitFor(() => expect(rowOf('Ui K Chính Trị')).toBeTruthy())
    const pairs = (label: string) => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => [o.value, (o.textContent ?? '').trim()])
    expect(pairs('Trạng thái')).toEqual(
      expect.arrayContaining([
        ['blocked', 'Bị chặn'],
        ['unblocked', 'Đã bỏ chặn - chờ mẻ'],
        ['added', 'Đã thêm'],
        ['approved', 'Đã duyệt tay'],
      ]),
    )
    expect(pairs('Bước').map(([v]) => v)).toEqual(expect.arrayContaining(['layer1', 'layer2']))
    expect(pairs('Lý do')).toEqual(expect.arrayContaining([['politics', 'Chính trị']]))
  })

  it('AC-ADMIN-13: mở chi tiết một dòng gọi GET /api/admin/rejected/<id> và hiện ngữ cảnh, nguồn; link nguồn mở tab mới (target=_blank, rel noopener)', async () => {
    await openDetail('Ui K Chính Trị')
    const open = calls().find((c) => c.method === 'GET' && c.url.pathname === `/api/admin/rejected/${rows[0]!.id}`)!
    expect(open.auth).toBe(`Bearer ${GOOD}`)
    expect((await screen.findAllByText(/Ngữ cảnh của bài 1/)).length).toBeGreaterThan(0)
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === 'https://example.com/bai-1')!
    expect(link).toBeTruthy()
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel') ?? '').toContain('noopener')
  })
})

describe('admin ui: sửa tay và "Bỏ chặn" (AC-ADMIN-14)', () => {
  it('AC-ADMIN-14: chi tiết dòng "Bị chặn" có các ô Tên, Emoji, Mô tả, Gợi ý Daily, Gợi ý ảnh điền sẵn; "Lưu" gửi PATCH chỉ gồm trường đã đổi và bảng hiện giá trị mới', async () => {
    await openDetail('Ui K Chính Trị')
    expect(field('Tên').value).toBe('Ui K Chính Trị')
    expect(field('Emoji').value).toBe('😡')
    expect(field('Mô tả').value).toBe('Mô tả cũ')
    expect(field('Gợi ý Daily').value).toBe('Gợi ý Daily cũ')
    expect(field('Gợi ý ảnh').value).toBe('Gợi ý ảnh cũ')

    typeInto('Tên', 'Ui K Tên Mới')
    typeInto('Mô tả', 'Mô tả mới')
    fireEvent.click(button('Lưu'))
    await waitFor(() => expect(rejectedCalls('PATCH')).toHaveLength(1))
    const patch = rejectedCalls('PATCH')[0]!
    expect(patch.url.pathname).toBe(`/api/admin/rejected/${rows[0]!.id}`)
    expect(patch.auth).toBe(`Bearer ${GOOD}`)
    expect(patch.body).toEqual({ name: 'Ui K Tên Mới', description: 'Mô tả mới' })
    await waitFor(() => expect(rowOf('Ui K Tên Mới')).toBeTruthy())
  })

  it('AC-ADMIN-14: "Bỏ chặn" gửi POST .../unblock kèm token rồi dòng hiện "Đã bỏ chặn - chờ mẻ"', async () => {
    await openDetail('Ui K Chính Trị')
    fireEvent.click(button('Bỏ chặn'))
    await waitFor(() => expect(rejectedCalls('POST', '/unblock')).toHaveLength(1))
    const post = rejectedCalls('POST', '/unblock')[0]!
    expect(post.url.pathname).toBe(`/api/admin/rejected/${rows[0]!.id}/unblock`)
    expect(post.auth).toBe(`Bearer ${GOOD}`)
    await waitFor(() => expect(rowOf('Ui K Chính Trị').textContent).toContain('Đã bỏ chặn - chờ mẻ'))
  })

  it('AC-ADMIN-14: máy chủ trả 409 "Tên đang bị chặn vĩnh viễn, gỡ chặn tên trước" thì tiêu đề hiện trong role="alert" và dòng vẫn "Bị chặn"', async () => {
    failWith = { status: 409, title: PERMANENT }
    await openDetail('Ui K Chính Trị')
    fireEvent.click(button('Bỏ chặn'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(PERMANENT)
    expect(rowOf('Ui K Chính Trị').textContent).toContain('Bị chặn')
    expect(rowOf('Ui K Chính Trị').textContent).not.toContain('Đã bỏ chặn')
  })

  it('AC-ADMIN-14: dòng "Đã bỏ chặn - chờ mẻ" vẫn sửa được (có nút "Lưu") nhưng không còn nút "Bỏ chặn"', async () => {
    await openDetail('Ui K Đã Bỏ Chặn')
    expect(button('Lưu')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Bỏ chặn' })).toBeNull()
  })

  it.each([
    ['Ui K Đã Thêm', 'Đã thêm'],
    ['Ui K Duyệt Tay', 'Đã duyệt tay'],
  ])('AC-ADMIN-14: dòng "%s" (%s) chỉ xem: không có nút Lưu, Bỏ chặn, Duyệt luôn và không có ô nhập sửa được', async (name) => {
    await openDetail(name)
    expect((await screen.findAllByText(/Ngữ cảnh của bài/)).length).toBeGreaterThan(0)
    for (const label of ['Lưu', 'Bỏ chặn', 'Duyệt luôn']) expect(screen.queryByRole('button', { name: label })).toBeNull()
    const editable = screen.queryAllByRole('textbox').filter((el) => !(el as HTMLInputElement).readOnly && !(el as HTMLInputElement).disabled)
    // ô tìm theo tên của bộ lọc là ô nhập duy nhất còn lại
    expect(editable.every((el) => el.getAttribute('aria-label') === 'Tìm theo tên')).toBe(true)
  })
})

describe('admin ui: "Duyệt luôn" (AC-ADMIN-15)', () => {
  async function pick(side: 'A' | 'B', text: string, pickName: string): Promise<void> {
    fireEvent.change(screen.getByLabelText(`Tìm phần tử ${side}`), { target: { value: text } })
    const go = within(document.body).queryByRole('button', { name: `Tìm ${side}` })
    if (go) fireEvent.click(go)
    fireEvent.click(await screen.findByRole('button', { name: `Chọn ${side} ${pickName}` }))
  }

  it('AC-ADMIN-15: nút "Duyệt luôn" chỉ bật khi đã chọn A, B và tên, emoji không rỗng; bấm gửi POST .../approve {a, b, name, emoji, ...} kèm token rồi dòng hiện "Đã duyệt tay"', async () => {
    await openDetail('Ui K Chính Trị')
    expect(button('Duyệt luôn').disabled).toBe(true)

    await pick('A', 'Ui Món A', 'Ui Món A')
    expect(button('Duyệt luôn').disabled).toBe(true) // chưa có B
    await pick('B', 'Ui Món B', 'Ui Món B')
    await waitFor(() => expect(button('Duyệt luôn').disabled).toBe(false))
    expect(calls().filter((c) => c.method === 'GET' && c.url.pathname === '/api/admin/elements' && c.url.searchParams.has('q')).length).toBeGreaterThanOrEqual(2)

    typeInto('Tên', '')
    await waitFor(() => expect(button('Duyệt luôn').disabled).toBe(true))
    typeInto('Tên', 'Ui K Chính Trị')
    typeInto('Emoji', '')
    await waitFor(() => expect(button('Duyệt luôn').disabled).toBe(true))
    typeInto('Emoji', '🍜')
    await waitFor(() => expect(button('Duyệt luôn').disabled).toBe(false))
    expect(rejectedCalls('POST', '/approve')).toHaveLength(0)

    fireEvent.click(button('Duyệt luôn'))
    await waitFor(() => expect(rejectedCalls('POST', '/approve')).toHaveLength(1))
    const post = rejectedCalls('POST', '/approve')[0]!
    expect(post.url.pathname).toBe(`/api/admin/rejected/${rows[0]!.id}/approve`)
    expect(post.auth).toBe(`Bearer ${GOOD}`)
    expect(post.body).toMatchObject({ a: A_ID, b: B_ID, name: 'Ui K Chính Trị', emoji: '🍜' })
    expect((post.body as { a: string; b: string }).a).not.toBe((post.body as { a: string; b: string }).b)
    await waitFor(() => expect(rowOf('Ui K Chính Trị').textContent).toContain('Đã duyệt tay'))
  })

  it('AC-ADMIN-15: máy chủ trả 409 (cặp đã có công thức) thì tiêu đề hiện trong role="alert" và dòng vẫn "Bị chặn"', async () => {
    failWith = { status: 409, title: 'Cặp đã có công thức' }
    await openDetail('Ui K Chính Trị')
    await pick('A', 'Ui Món A', 'Ui Món A')
    await pick('B', 'Ui Món B', 'Ui Món B')
    await waitFor(() => expect(button('Duyệt luôn').disabled).toBe(false))
    fireEvent.click(button('Duyệt luôn'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Cặp đã có công thức')
    expect(rowOf('Ui K Chính Trị').textContent).not.toContain('Đã duyệt tay')
  })
})

describe('admin ui: sửa phần tử trong "Nội dung" (AC-ADMIN-16)', () => {
  async function openElementForm(): Promise<void> {
    render(<AdminApp />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Nội dung' }))
    await waitFor(() => expect(rowOf('Ui Phần Tử P')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Sửa Ui Phần Tử P' }))
    await waitFor(() => expect(elementCalls('GET')).toHaveLength(1))
  }

  it('AC-ADMIN-16: "Sửa <tên>" gọi GET /api/admin/elements/<id> và hiện form điền sẵn giá trị mẻ gần nhất (tên, emoji, mô tả, gợi ý Daily, gợi ý ảnh, nguồn gốc); chưa sửa thì không có nhãn "Chờ mẻ kế tiếp"', async () => {
    await openElementForm()
    expect(elementCalls('GET')[0]!.url.pathname).toBe(`/api/admin/elements/${P_ID}`)
    expect(elementCalls('GET')[0]!.auth).toBe(`Bearer ${GOOD}`)
    await waitFor(() => expect(field('Tên').value).toBe('Ui Phần Tử P'))
    expect(field('Emoji').value).toBe('🍲')
    expect(field('Mô tả').value).toBe('Mô tả mẻ gần nhất')
    expect(field('Gợi ý Daily').value).toBe('Daily mẻ gần nhất')
    expect(field('Gợi ý ảnh').value).toBe('Ảnh mẻ gần nhất')
    expect((screen.getByLabelText('Nguồn gốc') as HTMLSelectElement).value).toBe('vn')
    expect(screen.queryByText(/Chờ mẻ kế tiếp/)).toBeNull()
    const origin = Array.from((screen.getByLabelText('Nguồn gốc') as HTMLSelectElement).options).map((o) => [o.value, (o.textContent ?? '').trim()])
    expect(origin).toEqual(expect.arrayContaining([['vn', 'VN'], ['intl', 'Quốc tế']]))
  })

  it('AC-ADMIN-16: sửa rồi "Lưu" gửi PATCH /api/admin/elements/<id> chỉ gồm trường đã đổi; sau đó hiện nhãn "Chờ mẻ kế tiếp"', async () => {
    await openElementForm()
    await waitFor(() => expect(field('Tên').value).toBe('Ui Phần Tử P'))
    typeInto('Mô tả', 'Mô tả admin sửa')
    fireEvent.change(screen.getByLabelText('Nguồn gốc'), { target: { value: 'intl' } })
    fireEvent.click(button('Lưu'))
    await waitFor(() => expect(elementCalls('PATCH')).toHaveLength(1))
    const patch = elementCalls('PATCH')[0]!
    expect(patch.url.pathname).toBe(`/api/admin/elements/${P_ID}`)
    expect(patch.auth).toBe(`Bearer ${GOOD}`)
    expect(patch.body).toEqual({ description: 'Mô tả admin sửa', origin: 'intl' })
    expect((await screen.findAllByText(/Chờ mẻ kế tiếp/)).length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-ADMIN-16: chi tiết đã có bản sửa chưa vào mẻ nào (pending) hiện nhãn "Chờ mẻ kế tiếp" và điền sẵn giá trị đã sửa thay giá trị mẻ', async () => {
    detail = { ...detailOf(), edit: { description: 'Mô tả đã sửa từ trước' }, pending: true }
    await openElementForm()
    await waitFor(() => expect(field('Mô tả').value).toBe('Mô tả đã sửa từ trước'))
    expect(field('Tên').value).toBe('Ui Phần Tử P')
    expect((await screen.findAllByText(/Chờ mẻ kế tiếp/)).length).toBeGreaterThan(0)
  })

  it('AC-ADMIN-16: máy chủ trả 409 (tên trùng) thì tiêu đề lỗi hiện trong role="alert"', async () => {
    failWith = { status: 409, title: 'Tên đã có phần tử khác' }
    await openElementForm()
    await waitFor(() => expect(field('Tên').value).toBe('Ui Phần Tử P'))
    typeInto('Tên', 'Ui Món A')
    fireEvent.click(button('Lưu'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Tên đã có phần tử khác')
    expect(screen.queryByText(/Chờ mẻ kế tiếp/)).toBeNull()
  })
})
