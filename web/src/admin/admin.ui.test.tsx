// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/admin.md, phần web: AC-ADMIN-10 (trang quản trị ở origin riêng, ADR 0008).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU
 *   web/src/admin/AdminApp.tsx: export { AdminApp } (không prop). Không có token trong sessionStorage ('laumeme-admin.token')
 *     thì hiện form: ô mật khẩu "Token quản trị" + nút "Đăng nhập"; gửi form gọi GET /api/admin/reports?status=new
 *     với Authorization: Bearer <token>; 401 -> role="alert" "Token không đúng"; 200 -> lưu token vào sessionStorage
 *     và hiện 3 tab (role="tab"): "Báo cáo", "Nội dung", "Đợt + Audit". Không dùng localStorage hay cookie.
 *   web/admin.html: có <meta name="robots" content="noindex, nofollow">
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')
const BAD = ['bad', 'admin', 'token'].join('-')

const problem = (status: number, title: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title, status }), { status, headers: { 'Content-Type': 'application/problem+json' } })
const page = () =>
  new Response(JSON.stringify({ page: 1, size: 50, total: 0, items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })

// The client may call relative URLs (`api/admin/...`); resolve against the page URL like the browser does.
const pathOf = (input: RequestInfo | URL): string => new URL(String(input instanceof Request ? input.url : input), window.location.href).pathname

function authOf(init?: RequestInit): string | null {
  const h = init?.headers
  if (!h) return null
  if (h instanceof Headers) return h.get('Authorization')
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null
  const rec = h as Record<string, string>
  const key = Object.keys(rec).find((k) => k.toLowerCase() === 'authorization')
  return key ? (rec[key] ?? null) : null
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!pathOf(input).startsWith('/api/admin/')) return problem(404, 'Không tìm thấy')
    return authOf(init) === `Bearer ${GOOD}` ? page() : problem(401, 'Chưa xác thực')
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

const tokenInput = () => screen.getByLabelText('Token quản trị') as HTMLInputElement
const submit = (token: string) => {
  fireEvent.change(tokenInput(), { target: { value: token } })
  fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }))
}
const noWebStorage = () => {
  expect(localStorage.length).toBe(0)
  expect(document.cookie).toBe('')
}

describe('admin ui', () => {
  it('AC-ADMIN-10: chưa có token thì hiện form với ô mật khẩu "Token quản trị" và nút "Đăng nhập", chưa có tab', () => {
    render(<AdminApp />)
    expect(tokenInput().type).toBe('password')
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeTruthy()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    noWebStorage()
  })

  it('AC-ADMIN-10: token sai hiện thông báo role="alert" "Token không đúng", không lưu gì, vẫn ở form', async () => {
    render(<AdminApp />)
    submit(BAD)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Token không đúng')
    expect(sessionStorage.getItem(KEY)).toBeNull()
    expect(sessionStorage.length).toBe(0)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getByLabelText('Token quản trị')).toBeTruthy()
    const [url, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined]
    expect(pathOf(url).startsWith('/api/admin/reports')).toBe(true)
    expect(authOf(init)).toBe(`Bearer ${BAD}`)
    noWebStorage()
  })

  it('AC-ADMIN-10: token đúng lưu vào sessionStorage (khóa laumeme-admin.token), hiện 4 mục Báo cáo / Nội dung / Đợt + Audit / Đề xuất meme, không dùng localStorage hay cookie', async () => {
    render(<AdminApp />)
    submit(GOOD)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(4))
    expect(
      screen
        .getAllByRole('tab')
        .map((t) => t.textContent?.trim())
        .sort(),
    ).toEqual(['Báo cáo', 'Nội dung', 'Đợt + Audit', 'Đề xuất meme'].sort())
    expect(sessionStorage.getItem(KEY)).toBe(GOOD)
    expect(screen.queryByLabelText('Token quản trị')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    const [url, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined]
    expect(pathOf(url).startsWith('/api/admin/reports')).toBe(true)
    expect(authOf(init)).toBe(`Bearer ${GOOD}`)
    noWebStorage()
  })

  it('AC-ADMIN-10: tải lại tab (token còn trong sessionStorage) vào thẳng 4 mục (Báo cáo / Nội dung / Đợt + Audit / Đề xuất meme), không hiện form', async () => {
    const first = render(<AdminApp />)
    submit(GOOD)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(4))
    first.unmount()

    render(<AdminApp />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(4))
    expect(screen.queryByLabelText('Token quản trị')).toBeNull()
    expect(sessionStorage.getItem(KEY)).toBe(GOOD)
    noWebStorage()
  })

  it('AC-ADMIN-10: đóng tab rồi mở lại (sessionStorage mất) thì hiện lại form đăng nhập', async () => {
    const first = render(<AdminApp />)
    submit(GOOD)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(4))
    first.unmount()

    sessionStorage.clear()
    render(<AdminApp />)
    expect(tokenInput().type).toBe('password')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    noWebStorage()
  })
})
