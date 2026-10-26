// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho chỉ định Món đặc biệt của mẻ kế tiếp ở trang quản trị (AC-DAILY-19), thêm 2026-10-26, ADR 0019.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (thêm vào AdminApp; token ở sessionStorage 'laumeme-admin.token'):
 *   - Tab mới role="tab" tên "Món đặc biệt".
 *   - Mở tab gọi GET `/api/admin/daily-pin` (Authorization Bearer). `{pin: null}` -> hiện chữ "Chưa có chỉ định".
 *     Có chỉ định -> hiện tên món và gợi ý (ngoài ô nhập) cùng nút "Bỏ chỉ định"; bấm nút gửi DELETE `/api/admin/daily-pin`
 *     rồi hiện "Chưa có chỉ định".
 *   - Ô <input aria-label="Tìm phần tử"> tìm bằng GET `/api/admin/elements?q=<chữ>` (ngay khi gõ, hoặc khi bấm nút "Tìm");
 *     mỗi kết quả có nút "Chọn <tên>".
 *   - <textarea aria-label="Gợi ý">; nút "Chỉ định cho mẻ kế tiếp" bị vô hiệu cho tới khi đã chọn phần tử VÀ gợi ý không rỗng
 *     (khoảng trắng không tính). Bấm nút gửi PUT `/api/admin/daily-pin` thân JSON {element_id, hint} kèm Authorization Bearer,
 *     rồi hiện chỉ định đang chờ (tên + gợi ý, nút "Bỏ chỉ định") thay cho "Chưa có chỉ định".
 *   - Máy chủ trả 400 problem+json: tiêu đề lỗi hiện trong role="alert"; chỉ định không đổi.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')
const BAD_HINT = 'Gợi ý không được chứa tên món'
const NONE = 'Chưa có chỉ định'
const OUTSIDE_TEXTAREA = { selector: ':not(textarea)' }

type Item = {
  id: string
  name: string
  emoji: string
  depth: number
  state: 'active' | 'hidden' | 'blocked'
  image_key: string | null
  image_state: 'none' | 'active' | 'hidden'
  image_source: 'ai' | 'admin' | null
  last_version: number
  tier: number
  tier_source: 'auto' | 'admin'
  auto_tier: number | null
}
type Pin = { element_id: string; name: string; emoji: string; hint: string; created_at: string }

const A_ID = 'A'.repeat(43)
const B_ID = 'B'.repeat(43)
const item = (id: string, name: string): Item => ({
  id,
  name,
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

let items: Item[]
let pin: Pin | null
let putStatus: number
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
const pinCalls = (method: string) => calls().filter((c) => c.method === method && c.url.pathname === '/api/admin/daily-pin')
const searchCalls = () => calls().filter((c) => c.method === 'GET' && c.url.pathname === '/api/admin/elements' && c.url.searchParams.has('q'))

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  items = [item(A_ID, 'Dp Món A'), item(B_ID, 'Dp Món B')]
  pin = null
  putStatus = 200
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    if (!url.pathname.startsWith('/api/admin/')) return problem(404, 'Không tìm thấy')
    if (headerOf(init, 'Authorization') !== `Bearer ${GOOD}`) return problem(401, 'Chưa xác thực')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/admin/daily-pin') {
      if (method === 'GET') return reply({ pin })
      if (method === 'DELETE') {
        pin = null
        return new Response(null, { status: 204 })
      }
      if (method === 'PUT') {
        if (putStatus === 400) return problem(400, BAD_HINT)
        const body = JSON.parse(String(init?.body)) as { element_id: string; hint: string }
        const target = items.find((i) => i.id === body.element_id)
        if (!target) return problem(404, 'Không tìm thấy')
        const before = pin
        pin = { element_id: target.id, name: target.name, emoji: target.emoji, hint: body.hint, created_at: '2026-10-26T05:00:00.000Z' }
        return reply({ before, after: pin })
      }
    }
    if (method === 'GET' && url.pathname === '/api/admin/elements') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const hit = items.filter((i) => i.name.toLowerCase().includes(q))
      return reply({ page: 1, size: 50, total: hit.length, items: hit })
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

async function openTab(): Promise<void> {
  render(<AdminApp />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Món đặc biệt' }))
  await waitFor(() => expect(pinCalls('GET').length).toBeGreaterThan(0))
}
const submitButton = () => screen.getByRole('button', { name: 'Chỉ định cho mẻ kế tiếp' }) as HTMLButtonElement

async function search(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('Tìm phần tử'), { target: { value: text } })
  const go = screen.queryByRole('button', { name: 'Tìm' })
  if (go) fireEvent.click(go)
  await waitFor(() => expect(searchCalls().length).toBeGreaterThan(0))
}

describe('admin daily pin ui', () => {
  it('AC-DAILY-19: tab "Món đặc biệt" mở ra gọi GET /api/admin/daily-pin kèm token; chưa có chỉ định thì hiện "Chưa có chỉ định" và không có nút "Bỏ chỉ định"', async () => {
    await openTab()
    expect(pinCalls('GET')[0]!.auth).toBe(`Bearer ${GOOD}`)
    expect(await screen.findByText(NONE)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Bỏ chỉ định' })).toBeNull()
  })

  it('AC-DAILY-19: có chỉ định đang chờ thì hiện tên món, gợi ý và nút "Bỏ chỉ định"; bấm gửi DELETE rồi hiện "Chưa có chỉ định"', async () => {
    pin = { element_id: A_ID, name: 'Dp Món A', emoji: '🍲', hint: 'Gợi ý sẵn có của admin', created_at: '2026-10-26T04:00:00.000Z' }
    await openTab()
    expect((await screen.findAllByText(/Dp Món A/, OUTSIDE_TEXTAREA)).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('Gợi ý sẵn có của admin', OUTSIDE_TEXTAREA)).length).toBeGreaterThan(0)
    expect(screen.queryByText(NONE)).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'Bỏ chỉ định' }))
    await waitFor(() => expect(pinCalls('DELETE')).toHaveLength(1))
    expect(pinCalls('DELETE')[0]!.auth).toBe(`Bearer ${GOOD}`)
    expect(await screen.findByText(NONE)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Bỏ chỉ định' })).toBeNull()
    expect(screen.queryByText('Gợi ý sẵn có của admin', OUTSIDE_TEXTAREA)).toBeNull()
  })

  it('AC-DAILY-19: tìm phần tử (GET elements?q=), chọn "Chọn <tên>", nút "Chỉ định cho mẻ kế tiếp" chỉ bật khi đã chọn và gợi ý không rỗng; bấm gửi PUT {element_id, hint} kèm token rồi hiện chỉ định đang chờ', async () => {
    await openTab()
    expect(await screen.findByText(NONE)).toBeTruthy()
    expect(submitButton().disabled).toBe(true)

    await search('Dp')
    const q = searchCalls()[0]!
    expect(q.url.searchParams.get('q')).toBe('Dp')
    expect(q.auth).toBe(`Bearer ${GOOD}`)
    const choose = await screen.findByRole('button', { name: 'Chọn Dp Món B' })
    expect(screen.getByRole('button', { name: 'Chọn Dp Món A' })).toBeTruthy()

    // hint empty, element not chosen yet
    fireEvent.change(screen.getByLabelText('Gợi ý'), { target: { value: 'Gợi ý mới cho mẻ kế tiếp' } })
    expect(submitButton().disabled).toBe(true)
    fireEvent.click(choose)
    await waitFor(() => expect(submitButton().disabled).toBe(false))

    // a blank hint turns it off again
    fireEvent.change(screen.getByLabelText('Gợi ý'), { target: { value: '   ' } })
    await waitFor(() => expect(submitButton().disabled).toBe(true))
    fireEvent.change(screen.getByLabelText('Gợi ý'), { target: { value: 'Gợi ý mới cho mẻ kế tiếp' } })
    await waitFor(() => expect(submitButton().disabled).toBe(false))
    expect(pinCalls('PUT')).toHaveLength(0)

    fireEvent.click(submitButton())
    await waitFor(() => expect(pinCalls('PUT')).toHaveLength(1))
    const put = pinCalls('PUT')[0]!
    expect(put.auth).toBe(`Bearer ${GOOD}`)
    expect(put.body).toEqual({ element_id: B_ID, hint: 'Gợi ý mới cho mẻ kế tiếp' })

    expect((await screen.findAllByText('Gợi ý mới cho mẻ kế tiếp', OUTSIDE_TEXTAREA)).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/Dp Món B/, { selector: ':not(textarea):not(button)' })).length).toBeGreaterThan(0)
    expect(await screen.findByRole('button', { name: 'Bỏ chỉ định' })).toBeTruthy()
    expect(screen.queryByText(NONE)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-DAILY-19: máy chủ trả 400 problem+json thì tiêu đề lỗi hiện trong role="alert" và chưa có chỉ định nào hiện ra', async () => {
    await openTab()
    expect(await screen.findByText(NONE)).toBeTruthy()
    await search('Dp')
    fireEvent.click(await screen.findByRole('button', { name: 'Chọn Dp Món A' }))
    fireEvent.change(screen.getByLabelText('Gợi ý'), { target: { value: 'Dp Món A rất ngon' } })
    await waitFor(() => expect(submitButton().disabled).toBe(false))

    putStatus = 400
    fireEvent.click(submitButton())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(BAD_HINT)
    expect(pinCalls('PUT')).toHaveLength(1)
    expect(screen.getByText(NONE)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Bỏ chỉ định' })).toBeNull()
  })
})
