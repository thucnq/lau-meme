// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho AC-ART-14 (phía trang quản trị, thêm 2026-10-25, contract 0.6.0, ADR 0018): hộp chọn "Dùng link làm ảnh"
 * trong form duyệt đề xuất.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (thêm vào form "Duyệt" của mục "Đề xuất meme", xem contrib.ui.test.tsx)
 *   - Hộp chọn (role="checkbox") có tên "Dùng link làm ảnh", mặc định không chọn. Đề xuất không có link ảnh thì hộp chọn vắng
 *     hoặc bị vô hiệu (disabled).
 *   - Chọn rồi "Xác nhận duyệt" -> POST approve có `use_image_url: true`; không chọn -> `use_image_url: false` hoặc không có trường.
 *   - Link ảnh vẫn chỉ hiện dạng chữ: không có <img> nào trỏ tới link, không fetch tới link.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')
const ID_LINK = '00000000-0000-4000-8000-0000000000a1'
const ID_NOLINK = '00000000-0000-4000-8000-0000000000a2'
const HINT = 'một ly cà phê đen đang chạy deadline'
const URL_A = 'https://example.com/a.png'
const CHECKBOX = 'Dùng link làm ảnh'

type Starter = { id: string; name: string; emoji: string }
type Row = {
  id: string
  a: Starter
  b: Starter
  name: string
  emoji: string | null
  description: string | null
  image_url: string | null
  use_image_url: boolean
  status: 'pending' | 'approved' | 'rejected'
  reject_reason: string | null
  image_hint: string | null
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
  image_url: URL_A,
  use_image_url: false,
  status: 'pending',
  reject_reason: null,
  image_hint: null,
  tier: 1,
  element_id: null,
  nickname: 'Bún Chả',
  created_at: '2026-10-20T08:00:00.000Z',
  decided_at: null,
  ...over,
})

const reply = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })
const problem = (status: number, title: string) => reply({ type: 'about:blank', title, status }, status, 'application/problem+json')
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
let fetchMock: ReturnType<typeof vi.fn>

type Call = { method: string; url: URL; body: unknown }
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
    return { method: (i?.method ?? 'GET').toUpperCase(), url: urlOf(input as RequestInfo | URL), body }
  })
const approves = () => calls().filter((c) => c.method === 'POST' && /^\/api\/admin\/contributions\/[^/]+\/approve$/.test(c.url.pathname))

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  pending = [mk(ID_LINK, 'Cà Phê Chạy Deadline'), mk(ID_NOLINK, 'Meme Không Link', { image_url: null, emoji: null, description: null })]
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const path = url.pathname
    if (!path.startsWith('/api/admin/')) return problem(404, 'Không tìm thấy')
    if (authOf(init) !== `Bearer ${GOOD}`) return problem(401, 'Chưa xác thực')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && path === '/api/admin/contributions') {
      const status = url.searchParams.get('status') ?? 'pending'
      const items = status === 'pending' ? pending : []
      return reply({ page: Number(url.searchParams.get('page') ?? 1), size: Number(url.searchParams.get('size') ?? 50), total: items.length, items })
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
const openApprove = (name: string) => fireEvent.click(within(rowOf(name)).getByRole('button', { name: 'Duyệt' }))
const imagesPointingAtLink = () =>
  Array.from(document.querySelectorAll('img')).filter((img) => (img.getAttribute('src') ?? '').includes('example.com'))

describe('admin ui: dùng link ảnh của đề xuất làm ảnh món', () => {
  it('AC-ART-14: form "Duyệt" của đề xuất có link ảnh có hộp chọn "Dùng link làm ảnh", mặc định không chọn', async () => {
    await openTab()
    openApprove('Cà Phê Chạy Deadline')
    const box = screen.getByRole('checkbox', { name: CHECKBOX }) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(false)
  })

  it('AC-ART-14: chọn "Dùng link làm ảnh" rồi "Xác nhận duyệt" gửi POST approve {image_hint, tier, use_image_url: true}', async () => {
    await openTab()
    openApprove('Cà Phê Chạy Deadline')
    fireEvent.change(screen.getByLabelText('Gợi ý ảnh'), { target: { value: HINT } })
    fireEvent.click(screen.getByRole('checkbox', { name: CHECKBOX }))
    expect((screen.getByRole('checkbox', { name: CHECKBOX }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }))

    await waitFor(() => expect(approves()).toHaveLength(1))
    const [post] = approves()
    expect(post!.url.pathname).toBe(`/api/admin/contributions/${ID_LINK}/approve`)
    expect(post!.body).toEqual({ image_hint: HINT, tier: 1, use_image_url: true })
  })

  it('AC-ART-14: không chọn hộp thì POST approve không bật use_image_url (false hoặc không có trường)', async () => {
    await openTab()
    openApprove('Cà Phê Chạy Deadline')
    fireEvent.change(screen.getByLabelText('Gợi ý ảnh'), { target: { value: HINT } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }))

    await waitFor(() => expect(approves()).toHaveLength(1))
    const body = approves()[0]!.body as { image_hint: string; tier: number; use_image_url?: boolean }
    expect(body.image_hint).toBe(HINT)
    expect(body.tier).toBe(1)
    expect([undefined, false]).toContain(body.use_image_url)
  })

  it('AC-ART-14: đề xuất không có link ảnh thì hộp chọn vắng hoặc bị vô hiệu và không bao giờ gửi use_image_url true', async () => {
    await openTab()
    openApprove('Meme Không Link')
    const box = screen.queryByRole('checkbox', { name: CHECKBOX }) as HTMLInputElement | null
    if (box !== null) {
      expect(box.disabled).toBe(true)
      fireEvent.click(box)
      expect(box.checked).toBe(false)
    }
    fireEvent.change(screen.getByLabelText('Gợi ý ảnh'), { target: { value: HINT } })
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận duyệt' }))

    await waitFor(() => expect(approves()).toHaveLength(1))
    expect(approves()[0]!.url.pathname).toBe(`/api/admin/contributions/${ID_NOLINK}/approve`)
    expect((approves()[0]!.body as { use_image_url?: boolean }).use_image_url).not.toBe(true)
  })

  it('AC-ART-14: link ảnh vẫn chỉ hiện dạng chữ: không có <img> trỏ tới link (kể cả khi đã chọn dùng link), không fetch tới link', async () => {
    await openTab()
    expect(rowOf('Cà Phê Chạy Deadline').textContent).toContain(URL_A)
    expect(imagesPointingAtLink()).toEqual([])

    openApprove('Cà Phê Chạy Deadline')
    fireEvent.click(screen.getByRole('checkbox', { name: CHECKBOX }))
    expect(imagesPointingAtLink()).toEqual([])
    expect(document.querySelector('img[src*="example.com"]')).toBeNull()
    expect(calls().some((c) => c.url.hostname === 'example.com')).toBe(false)
  })
})
