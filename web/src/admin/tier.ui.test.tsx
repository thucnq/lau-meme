// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho tier ở trang quản trị: mục "Nội dung" (AC-ADMIN-12, AC-TIER-05), cập nhật 2026-10-24.
 *
 * Phủ sóng:
 *   AC-ADMIN-12  bảng "Nội dung" có cột "Tier"; mỗi dòng có ô chọn tier (đổi thì gọi PUT elements/<id>/tier với
 *                {tier: số} hoặc {tier: "auto"} rồi tải lại danh sách); 409 hiện tiêu đề lỗi trong role="alert"; bộ lọc
 *                "Tier" thêm tham số tier=N vào GET elements; bỏ lọc ("Tất cả") thì không gửi tier.
 *   AC-TIER-05   mỗi dòng hiện tier hiện tại (tên), nguồn tier ("Tự động" / "Admin gán") và tier tự động sẽ có
 *                ("Tự động: <tên>" hoặc "Tự động: chưa có" khi auto_tier null); ô chọn có lựa chọn
 *                "Tự động (theo độ sâu)" và giá trị hiện tại là "auto" khi nguồn là tự động.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (thêm vào AdminApp trong admin.ui.test.tsx; token ở sessionStorage 'laumeme-admin.token')
 *   - Tab "Nội dung" gọi GET /api/admin/elements (có thể thêm q, state, tier, page, size); phản hồi theo AdminElementPage
 *     (docs/api/openapi.yaml: id, name, emoji, depth, state, image_key, image_state, last_version, tier, tier_source, auto_tier).
 *   - Bảng có <th> "Tier". Mỗi phần tử là một <tr> chứa tên phần tử; ô Tier của dòng hiện: tên tier hiện tại (Xám, Xanh lá,
 *     Xanh dương, Vàng, Đỏ), "Admin gán" hoặc "Tự động", và "Tự động: <tên tier của auto_tier>" / "Tự động: chưa có".
 *   - Mỗi dòng có <select aria-label="Tier của <tên>"> với option value "1".."5" (nhãn "1 Xám", "2 Xanh lá", "3 Xanh dương",
 *     "4 Vàng", "5 Đỏ") và value "auto" (nhãn "Tự động (theo độ sâu)"); value hiện tại = tier khi nguồn admin, "auto" khi nguồn auto.
 *     Đổi giá trị thì gửi PUT `/api/admin/elements/<id>/tier` thân {"tier": <số>} hoặc {"tier": "auto"} với Authorization Bearer.
 *   - Form lọc có <select> có nhãn "Tier" với option "Tất cả", "1 Xám", ..., "5 Đỏ"; chọn thì (tự động hoặc sau khi gửi form)
 *     GET elements kèm tier=N.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')
const NEED_IMAGE = 'Món Vàng/Đỏ cần có ảnh trước'
const TIER_NAMES = ['Xám', 'Xanh lá', 'Xanh dương', 'Vàng', 'Đỏ']

type Item = {
  id: string
  name: string
  emoji: string
  depth: number
  state: 'active' | 'hidden' | 'blocked'
  image_key: string | null
  image_state: 'none' | 'active' | 'hidden'
  last_version: number
  tier: number
  tier_source: 'auto' | 'admin'
  auto_tier: number | null
}
const A_ID = 'A'.repeat(43)
const B_ID = 'B'.repeat(43)
const C_ID = 'C'.repeat(43)
const item = (id: string, name: string, tier: number, source: 'auto' | 'admin', autoTier: number | null): Item => ({
  id,
  name,
  emoji: '🍲',
  depth: 3,
  state: 'active',
  image_key: null,
  image_state: 'none',
  last_version: 1,
  tier,
  tier_source: source,
  auto_tier: autoTier,
})
const seed = (): Item[] => [
  item(A_ID, 'Tr Món A', 4, 'admin', 2), // admin gán Vàng, tự động sẽ là Xanh lá
  item(B_ID, 'Tr Món B', 3, 'auto', 3), // tự động Xanh dương
  item(C_ID, 'Tr Món C', 1, 'auto', null), // chưa có tier tự động
]

const reply = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })
const problem = (status: number, title: string) => reply({ type: 'about:blank', title, status }, status, 'application/problem+json')
const pathOf = (input: RequestInfo | URL): string => new URL(String(input instanceof Request ? input.url : input), window.location.href).pathname
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

let items: Item[]
let putStatus: number
let fetchMock: ReturnType<typeof vi.fn>

type Call = { method: string; url: URL; body: unknown; auth: string | null }
const calls = (): Call[] =>
  fetchMock.mock.calls.map(([input, init]) => {
    const i = init as RequestInit | undefined
    const raw = typeof i?.body === 'string' ? i.body : null
    let body: unknown = null
    if (raw) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    return { method: (i?.method ?? 'GET').toUpperCase(), url: urlOf(input as RequestInfo | URL), body, auth: authOf(i) }
  })
const elementGets = () => calls().filter((c) => c.method === 'GET' && c.url.pathname === '/api/admin/elements')
const tierPuts = () => calls().filter((c) => c.method === 'PUT' && /^\/api\/admin\/elements\/[^/]+\/tier$/.test(c.url.pathname))

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  items = seed()
  putStatus = 200
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input)
    if (!path.startsWith('/api/admin/')) return problem(404, 'Không tìm thấy')
    if (authOf(init) !== `Bearer ${GOOD}`) return problem(401, 'Chưa xác thực')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && path === '/api/admin/elements') {
      const tier = urlOf(input).searchParams.get('tier')
      const shown = tier ? items.filter((i) => i.tier === Number(tier)) : items
      return reply({ page: 1, size: 50, total: shown.length, items: shown })
    }
    const put = /^\/api\/admin\/elements\/([^/]+)\/tier$/.exec(path)
    if (method === 'PUT' && put) {
      const target = items.find((i) => i.id === put[1])
      if (!target) return problem(404, 'Không tìm thấy')
      if (putStatus === 409) return problem(409, NEED_IMAGE)
      const body = JSON.parse(String(init?.body ?? '{}')) as { tier: number | 'auto' }
      const before = { tier: target.tier, source: target.tier_source }
      if (body.tier === 'auto') {
        target.tier_source = 'auto'
        target.tier = target.auto_tier ?? 1
      } else {
        target.tier_source = 'admin'
        target.tier = body.tier
      }
      return reply({ element_id: target.id, before: before.tier, after: target.tier, before_source: before.source, after_source: target.tier_source })
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

async function openContent(): Promise<void> {
  render(<AdminApp />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Nội dung' }))
  await waitFor(() => expect(rowOf('Tr Món A')).toBeTruthy())
}
const rowOf = (name: string): HTMLElement => {
  const row = screen.queryAllByRole('row').find((r) => (r.textContent ?? '').includes(name))
  if (!row) throw new Error(`Không có dòng "${name}"`)
  return row
}
const tierSelect = (name: string) => screen.getByLabelText(`Tier của ${name}`) as HTMLSelectElement
const optionPairs = (select: HTMLSelectElement) => Array.from(select.options).map((o) => [o.value, (o.textContent ?? '').trim()])

describe('admin tier ui', () => {
  it('AC-ADMIN-12: bảng "Nội dung" có cột "Tier" và liệt kê từng phần tử', async () => {
    await openContent()
    expect(screen.getByRole('columnheader', { name: 'Tier' })).toBeTruthy()
    for (const name of ['Tr Món A', 'Tr Món B', 'Tr Món C']) expect(rowOf(name)).toBeTruthy()
    const [first] = elementGets()
    expect(first!.auth).toBe(`Bearer ${GOOD}`)
    expect(first!.url.searchParams.get('tier')).toBeFalsy()
  })

  it('AC-TIER-05: mỗi dòng hiện tier hiện tại, nguồn tier ("Admin gán" / "Tự động") và tier tự động sẽ có ("Tự động: <tên>" / "Tự động: chưa có")', async () => {
    await openContent()
    const a = rowOf('Tr Món A').textContent ?? ''
    expect(a).toContain('Vàng')
    expect(a).toContain('Admin gán')
    expect(a).toContain('Tự động: Xanh lá')

    const b = rowOf('Tr Món B').textContent ?? ''
    expect(b).toContain('Xanh dương')
    expect(b).toContain('Tự động')
    expect(b).not.toContain('Admin gán')
    expect(b).toContain('Tự động: Xanh dương')

    const c = rowOf('Tr Món C').textContent ?? ''
    expect(c).toContain('Xám')
    expect(c).not.toContain('Admin gán')
    expect(c).toContain('Tự động: chưa có')
  })

  it('AC-TIER-05: ô chọn tier của dòng có 5 bậc và "Tự động (theo độ sâu)"; giá trị hiện tại là số khi admin gán, "auto" khi tự động', async () => {
    await openContent()
    const expected = [
      ['1', '1 Xám'],
      ['2', '2 Xanh lá'],
      ['3', '3 Xanh dương'],
      ['4', '4 Vàng'],
      ['5', '5 Đỏ'],
      ['auto', 'Tự động (theo độ sâu)'],
    ]
    for (const name of ['Tr Món A', 'Tr Món B', 'Tr Món C']) {
      expect(optionPairs(tierSelect(name)).sort()).toEqual([...expected].sort())
    }
    expect(tierSelect('Tr Món A').value).toBe('4')
    expect(tierSelect('Tr Món B').value).toBe('auto')
    expect(tierSelect('Tr Món C').value).toBe('auto')
    expect(within(rowOf('Tr Món A')).getByLabelText('Tier của Tr Món A')).toBe(tierSelect('Tr Món A'))
  })

  it('AC-ADMIN-12: đổi ô chọn sang tier 5 gửi PUT elements/<id>/tier thân {tier: 5} kèm token rồi tải lại danh sách; dòng hiện Đỏ, nguồn "Admin gán"', async () => {
    await openContent()
    const getsBefore = elementGets().length
    fireEvent.change(tierSelect('Tr Món B'), { target: { value: '5' } })

    await waitFor(() => expect(tierPuts()).toHaveLength(1))
    const [put] = tierPuts()
    expect(put!.url.pathname).toBe(`/api/admin/elements/${B_ID}/tier`)
    expect(put!.body).toEqual({ tier: 5 })
    expect(typeof (put!.body as { tier: unknown }).tier).toBe('number')
    expect(put!.auth).toBe(`Bearer ${GOOD}`)

    await waitFor(() => expect(elementGets().length).toBeGreaterThan(getsBefore))
    await waitFor(() => expect((rowOf('Tr Món B').textContent ?? '')).toContain('Đỏ'))
    expect(rowOf('Tr Món B').textContent).toContain('Admin gán')
    expect(tierSelect('Tr Món B').value).toBe('5')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-TIER-05: chọn "Tự động (theo độ sâu)" gửi PUT thân {tier: "auto"} (chuỗi), tải lại; dòng về nguồn "Tự động" với tier = tier tự động', async () => {
    await openContent()
    const getsBefore = elementGets().length
    fireEvent.change(tierSelect('Tr Món A'), { target: { value: 'auto' } })

    await waitFor(() => expect(tierPuts()).toHaveLength(1))
    const [put] = tierPuts()
    expect(put!.url.pathname).toBe(`/api/admin/elements/${A_ID}/tier`)
    expect(put!.body).toEqual({ tier: 'auto' })

    await waitFor(() => expect(elementGets().length).toBeGreaterThan(getsBefore))
    await waitFor(() => expect(tierSelect('Tr Món A').value).toBe('auto'))
    const a = rowOf('Tr Món A').textContent ?? ''
    expect(a).toContain('Xanh lá')
    expect(a).not.toContain('Admin gán')
  })

  it('AC-ADMIN-12: máy chủ trả 409 "Món Vàng/Đỏ cần có ảnh trước" thì tiêu đề lỗi hiện trong role="alert"', async () => {
    await openContent()
    expect(screen.queryByRole('alert')).toBeNull()
    putStatus = 409
    fireEvent.change(tierSelect('Tr Món C'), { target: { value: '5' } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(NEED_IMAGE)
    expect(tierPuts()).toHaveLength(1)
    expect(tierPuts()[0]!.body).toEqual({ tier: 5 })
  })

  it('AC-ADMIN-12: form lọc có ô chọn "Tier" (Tất cả, 1 Xám ... 5 Đỏ); chọn "4 Vàng" thì GET elements kèm tier=4 và chỉ còn phần tử Vàng', async () => {
    await openContent()
    const filter = screen.getByLabelText('Tier') as HTMLSelectElement
    expect(filter.tagName).toBe('SELECT')
    expect(Array.from(filter.options).map((o) => (o.textContent ?? '').trim())).toEqual(['Tất cả', ...TIER_NAMES.map((n, i) => `${i + 1} ${n}`)])

    const yellow = Array.from(filter.options).find((o) => (o.textContent ?? '').trim() === '4 Vàng')!
    fireEvent.change(filter, { target: { value: yellow.value } })
    const form = filter.closest('form')
    if (form) fireEvent.submit(form)

    await waitFor(() => expect(elementGets().some((c) => c.url.searchParams.get('tier') === '4')).toBe(true))
    await waitFor(() => expect(() => rowOf('Tr Món B')).toThrow())
    expect(rowOf('Tr Món A')).toBeTruthy()
  })

  it('AC-ADMIN-12: chọn lại "Tất cả" thì GET elements không còn tham số tier', async () => {
    await openContent()
    const filter = screen.getByLabelText('Tier') as HTMLSelectElement
    const byLabel = (label: string) => Array.from(filter.options).find((o) => (o.textContent ?? '').trim() === label)!.value
    fireEvent.change(filter, { target: { value: byLabel('5 Đỏ') } })
    if (filter.closest('form')) fireEvent.submit(filter.closest('form')!)
    await waitFor(() => expect(elementGets().some((c) => c.url.searchParams.get('tier') === '5')).toBe(true))

    const countBefore = elementGets().length
    fireEvent.change(filter, { target: { value: byLabel('Tất cả') } })
    if (filter.closest('form')) fireEvent.submit(filter.closest('form')!)
    await waitFor(() => expect(elementGets().length).toBeGreaterThan(countBefore))
    const last = elementGets().at(-1)!
    expect(last.url.searchParams.get('tier')).toBeFalsy()
    await waitFor(() => expect(rowOf('Tr Món B')).toBeTruthy())
  })
})
