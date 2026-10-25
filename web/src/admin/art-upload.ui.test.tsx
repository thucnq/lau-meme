// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho tải tranh vẽ tay ở trang quản trị, mục "Nội dung" (AC-ART-13), thêm 2026-10-25, ADR 0016.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (thêm vào AdminApp; token ở sessionStorage 'laumeme-admin.token'):
 *   - Mỗi dòng phần tử trong bảng "Nội dung" có <input type="file" aria-label="Tải tranh vẽ cho <tên>"> (chấp nhận PNG/WebP).
 *   - Chọn file PNG/WebP <= 1 MB: trình duyệt chuẩn hóa về 256x256 WebP bằng canvas (test mock `createImageBitmap`,
 *     `HTMLCanvasElement.getContext` và `HTMLCanvasElement.toBlob`; chỉ cần dùng các API này) rồi gửi
 *     PUT `/api/admin/elements/<id>/image` với header Content-Type `image/webp` và Authorization Bearer; thân là Blob.
 *   - Sau 200 {element_id, before_key, after_key} danh sách được tải lại và dòng hiện <img alt="Ảnh của <tên>"> có src chứa
 *     image_key mới.
 *   - File > 1 MB (1048576 byte) hoặc không phải PNG/WebP: không gửi yêu cầu nào tới `/image`; hiện thông báo trong
 *     role="alert" có chữ "PNG hoặc WebP" và "1 MB".
 *   - Máy chủ trả 400 problem+json: tiêu đề lỗi hiện trong role="alert".
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApp } from './AdminApp'

const KEY = 'laumeme-admin.token'
const GOOD = ['good', 'admin', 'token'].join('-')
const NEW_KEY = 'aaaaaaaaaaaa.webp'
const BAD_SIZE = 'Ảnh phải là WebP 256x256'
const MAX_BYTES = 1048576

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
let putStatus: number
let fetchMock: ReturnType<typeof vi.fn>

type Call = { method: string; url: URL; auth: string | null; contentType: string | null }
const calls = (): Call[] =>
  fetchMock.mock.calls.map(([input, init]) => {
    const i = init as RequestInit | undefined
    return { method: (i?.method ?? 'GET').toUpperCase(), url: urlOf(input as RequestInfo | URL), auth: headerOf(i, 'Authorization'), contentType: headerOf(i, 'Content-Type') }
  })
const imagePuts = () => calls().filter((c) => c.method === 'PUT' && /^\/api\/admin\/elements\/[^/]+\/image$/.test(c.url.pathname))
const elementGets = () => calls().filter((c) => c.method === 'GET' && c.url.pathname === '/api/admin/elements')

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  sessionStorage.setItem(KEY, GOOD)
  items = [item(A_ID, 'Tr Món A'), item(B_ID, 'Tr Món B')]
  putStatus = 200
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    if (!url.pathname.startsWith('/api/admin/')) return problem(404, 'Không tìm thấy')
    if (headerOf(init, 'Authorization') !== `Bearer ${GOOD}`) return problem(401, 'Chưa xác thực')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.pathname === '/api/admin/elements') return reply({ page: 1, size: 50, total: items.length, items })
    const put = /^\/api\/admin\/elements\/([^/]+)\/image$/.exec(url.pathname)
    if (method === 'PUT' && put) {
      const target = items.find((i) => i.id === put[1])
      if (!target) return problem(404, 'Không tìm thấy')
      if (putStatus === 400) return problem(400, BAD_SIZE)
      const before = target.image_key
      target.image_key = NEW_KEY
      target.image_state = 'active'
      target.image_source = 'admin'
      return reply({ element_id: target.id, before_key: before, after_key: NEW_KEY })
    }
    return reply({ page: 1, size: 50, total: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)

  // Chuẩn hóa ảnh qua canvas: jsdom không có, nên giả lập giải mã -> canvas -> WebP.
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 512, height: 384, close: () => undefined })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn() })) as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((cb: BlobCallback, type?: string) => {
    cb(new Blob([Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])], { type: type ?? 'image/webp' }))
  }) as never)
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
async function openContent(): Promise<void> {
  render(<AdminApp />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Nội dung' }))
  await waitFor(() => expect(rowOf('Tr Món A')).toBeTruthy())
}
const uploadInput = (name: string) => screen.getByLabelText(`Tải tranh vẽ cho ${name}`) as HTMLInputElement
const choose = (name: string, file: File) => fireEvent.change(uploadInput(name), { target: { files: [file] } })
const fileOf = (type: string, size = 2048, fileName = 'tranh') => new File([new Uint8Array(size)], fileName, { type })

describe('admin art upload ui', () => {
  it('AC-ART-13: mỗi dòng phần tử ở "Nội dung" có ô chọn file tranh vẽ chấp nhận PNG/WebP', async () => {
    await openContent()
    for (const name of ['Tr Món A', 'Tr Món B']) {
      const input = uploadInput(name)
      expect(input.tagName).toBe('INPUT')
      expect(input.type).toBe('file')
      const accept = input.accept.toLowerCase()
      expect(accept).toContain('image/png')
      expect(accept).toContain('image/webp')
    }
  })

  it('AC-ART-13: chọn PNG <= 1 MB gửi PUT elements/<id>/image với Content-Type image/webp kèm token, rồi dòng hiện ảnh mới', async () => {
    await openContent()
    const getsBefore = elementGets().length
    choose('Tr Món A', fileOf('image/png'))

    await waitFor(() => expect(imagePuts()).toHaveLength(1))
    const [put] = imagePuts()
    expect(put!.url.pathname).toBe(`/api/admin/elements/${A_ID}/image`)
    expect(put!.contentType).toBe('image/webp')
    expect(put!.auth).toBe(`Bearer ${GOOD}`)
    const sent = fetchMock.mock.calls.find(([input]) => urlOf(input as RequestInfo | URL).pathname.endsWith('/image'))![1] as RequestInit
    expect(sent.body).toBeInstanceOf(Blob)

    await waitFor(() => expect(elementGets().length).toBeGreaterThan(getsBefore))
    await waitFor(() => {
      const img = rowOf('Tr Món A').querySelector('img')
      expect(img).not.toBeNull()
      expect(img!.getAttribute('src') ?? '').toContain(NEW_KEY)
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(rowOf('Tr Món B').querySelector('img')).toBeNull()
  })

  it('AC-ART-13: chọn WebP đúng 1 MB cũng được gửi (PUT image/webp)', async () => {
    await openContent()
    choose('Tr Món B', fileOf('image/webp', MAX_BYTES))
    await waitFor(() => expect(imagePuts()).toHaveLength(1))
    expect(imagePuts()[0]!.url.pathname).toBe(`/api/admin/elements/${B_ID}/image`)
    expect(imagePuts()[0]!.contentType).toBe('image/webp')
  })

  it('AC-ART-13: file > 1 MB hoặc không phải PNG/WebP bị từ chối ngay ở giao diện: không gửi PUT nào, hiện thông báo trong role="alert"', async () => {
    await openContent()
    choose('Tr Món A', fileOf('image/png', MAX_BYTES + 1))
    const tooBig = await screen.findByRole('alert')
    expect(tooBig.textContent).toContain('1 MB')
    expect(imagePuts()).toHaveLength(0)

    cleanup()
    await openContent()
    for (const type of ['image/gif', 'text/plain', 'application/pdf', 'image/svg+xml']) {
      choose('Tr Món A', fileOf(type))
      const alert = await screen.findByRole('alert')
      expect(alert.textContent, type).toContain('PNG hoặc WebP')
    }
    expect(imagePuts()).toHaveLength(0)
  })

  it('AC-ART-13: máy chủ trả 400 thì tiêu đề lỗi hiện trong role="alert" và dòng không hiện ảnh mới', async () => {
    await openContent()
    putStatus = 400
    choose('Tr Món A', fileOf('image/png'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(BAD_SIZE)
    expect(imagePuts()).toHaveLength(1)
    expect(rowOf('Tr Món A').querySelector('img')).toBeNull()
  })
})
