// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho trang quản trị, phần web của AC-MOD-12 (thêm 2026-10-30, câu hỏi mở 102):
 *   - mục "Bị chặn": ô lọc "Lý do" luôn có lựa chọn "Không phải meme" (value = not_meme) kể cả khi chưa có dòng nào mang lý
 *     do đó; chọn nó thì GET /api/admin/rejected kèm reason=not_meme; dòng có lý do not_meme hiện nhãn "Không phải meme".
 *   - mục "Đợt": báo cáo đợt đếm "không phải meme" trong stats.blocked.
 * Bề mặt công khai dùng lại y nguyên từ rejected.ui.test.tsx và admin.batches.ui.test.tsx (tab "Bị chặn", select "Lý do",
 * tab bắt đầu bằng "Đợt"); helper được sao chép vì hai file kia không export.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')
const LABEL = 'Không phải meme'
const LIVE = '🔴 TRỰC TIẾP: BOX GAMING vs BOOM ESPORTS | GIAI ĐOẠN PLAYOFFS | ĐTDV MÙA ĐÔNG 2026'

type Reason = { code: string; label: string }
const rej = (n: number, name: string, reasons: Reason[], step: 'layer1' | 'layer2' = 'layer2') => ({
  id: `0190b1c2-0000-7000-8000-${String(n).padStart(12, '0')}`,
  name,
  emoji: null,
  description: null,
  daily_hint: null,
  image_hint: null,
  source_name: 'YouTube',
  source_url: `https://example.com/bai-${n}`,
  context: `Ngữ cảnh của bài ${n}`,
  reasons,
  step,
  status: 'blocked',
  seen_count: 1,
  first_batch_id: '0190b1c2-0000-7000-8000-00000000b001',
  last_batch_id: '0190b1c2-0000-7000-8000-00000000b001',
  first_seen_at: '2026-10-28T05:00:00.000Z',
  last_seen_at: '2026-10-28T05:00:00.000Z',
  edited_at: null,
  decided_at: null,
  element_id: null,
  a: null,
  b: null,
  tier: null,
})

const reply = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })
const urlOf = (input: RequestInfo | URL): URL => new URL(String(input instanceof Request ? input.url : input), window.location.href)

let rows: ReturnType<typeof rej>[]
let batches: unknown
let fetchMock: ReturnType<typeof vi.fn>

const listGets = () =>
  fetchMock.mock.calls
    .map(([input]) => urlOf(input as RequestInfo | URL))
    .filter((u) => u.pathname === '/api/admin/rejected')
const lastList = () => listGets().at(-1)!

const stats = (blocked: Record<string, number>) => ({
  crawled: 60,
  added: 6,
  queued: 50,
  queue_size: 88,
  blocked,
  source_errors: [],
  quota_used: 42,
  sources: [{ source: 'YouTube', concepts: 60, error: null }],
  images: { drawn: 20, fallback: 3, pending: 9 },
  without_image: 7,
})
const batchPage = (blocked: Record<string, number>) => ({
  page: 1,
  size: 50,
  total: 1,
  summary: { crawled_total: 60, added_total: 6, queue_size: 88, without_image: 7 },
  items: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      version: 2026102301,
      batch_at: '2026-10-21T05:00:00.000Z',
      mode: 'full',
      status: 'success',
      failed_step: null,
      rollback_to: null,
      stats: stats(blocked),
      issue_url: null,
      created_at: '2026-10-21T05:00:30.000Z',
    },
  ],
})

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  rows = []
  batches = batchPage({ 'chính trị': 3, 'không phải meme': 4 })
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const auth = new Headers(init?.headers).get('Authorization')
    if (auth !== `Bearer ${GOOD}`) return reply({ type: 'about:blank', title: 'Chưa xác thực', status: 401 }, 401, 'application/problem+json')
    if (url.pathname === '/api/admin/rejected') {
      const reason = url.searchParams.get('reason')
      const shown = rows.filter((r) => !reason || r.reasons.some((x) => x.code === reason))
      return reply({ page: 1, size: 50, total: shown.length, items: shown })
    }
    if (url.pathname === '/api/admin/batches') return reply(batches)
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
const options = (label: string) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => [o.value, (o.textContent ?? '').trim()])

describe('admin ui: không phải meme trong mục "Bị chặn" (AC-MOD-12)', () => {
  it('AC-MOD-12: ô lọc "Lý do" có lựa chọn "Không phải meme" (not_meme) kể cả khi không dòng nào trong danh sách có lý do này', async () => {
    rows = [rej(1, 'Ui K Chính Trị', [{ code: 'politics', label: 'Chính trị' }])]
    await openRejected()
    await waitFor(() => expect(rowOf('Ui K Chính Trị')).toBeTruthy())
    expect(options('Lý do')).toEqual(expect.arrayContaining([['not_meme', LABEL]]))
  })

  it('AC-MOD-12: ô lọc "Lý do" vẫn có "Không phải meme" khi danh sách rỗng', async () => {
    await openRejected()
    await screen.findByText('Chưa có nội dung bị chặn')
    expect(options('Lý do')).toEqual(expect.arrayContaining([['not_meme', LABEL]]))
  })

  it('AC-MOD-12: chọn "Không phải meme" gửi GET /api/admin/rejected kèm reason=not_meme, chỉ còn dòng mang lý do đó; "Tất cả" bỏ tham số', async () => {
    rows = [
      rej(1, 'Ui K Chính Trị', [{ code: 'politics', label: 'Chính trị' }]),
      rej(2, LIVE, [{ code: 'not_meme', label: LABEL }], 'layer1'),
    ]
    await openRejected()
    await waitFor(() => expect(rowOf('Ui K Chính Trị')).toBeTruthy())
    expect(lastList().searchParams.get('reason')).toBeFalsy()

    fireEvent.change(screen.getByLabelText('Lý do'), { target: { value: 'not_meme' } })
    await waitFor(() => expect(lastList().searchParams.get('reason')).toBe('not_meme'))
    await waitFor(() => expect(screen.queryAllByRole('row').some((r) => (r.textContent ?? '').includes('Ui K Chính Trị'))).toBe(false))
    expect(rowOf('🔴 TRỰC TIẾP')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Lý do'), { target: { value: '' } })
    await waitFor(() => expect(lastList().searchParams.get('reason')).toBeFalsy())
  })

  it('AC-MOD-12: dòng có lý do not_meme hiện nhãn "Không phải meme" và bước Lớp 1; dòng lớp 2 hiện nhãn đó với Lớp 2', async () => {
    rows = [
      rej(1, LIVE, [{ code: 'not_meme', label: LABEL }], 'layer1'),
      rej(2, 'thủy tiên', [{ code: 'not_meme', label: LABEL }], 'layer2'),
    ]
    await openRejected()
    await waitFor(() => expect(rowOf('🔴 TRỰC TIẾP')).toBeTruthy())
    const first = rowOf('🔴 TRỰC TIẾP').textContent ?? ''
    expect(first).toContain(LABEL)
    expect(first).toMatch(/lớp 1/i)
    expect(first).toContain('Bị chặn')
    const second = rowOf('thủy tiên').textContent ?? ''
    expect(second).toContain(LABEL)
    expect(second).toMatch(/lớp 2/i)
  })
})

describe('admin ui: không phải meme trong báo cáo đợt (AC-MOD-12)', () => {
  it('AC-MOD-12: mục Đợt hiện số "không phải meme" của đợt cạnh các danh mục bị chặn khác', async () => {
    render(<AdminApp />)
    fireEvent.click(await screen.findByRole('tab', { name: /^Đợt/ }))
    await waitFor(() => expect(document.body.textContent ?? '').toMatch(/không phải meme/i))
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/không phải meme\D{0,12}4(?!\d)/i)
    expect(text).toMatch(/chính trị\D{0,12}3(?!\d)/i)
  })
})
