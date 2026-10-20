// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/report.md, phần web: AC-REPORT-01, 02, 05 (client), 07, 08 (client).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU
 *   web/src/report/api.ts:       REASONS: Array<{ value, label }> (7 lý do, đúng thứ tự);
 *                                submitReport(req, { storage, policyVersion }) -> Promise<Report> qua playerFetch
 *                                (POST /lau-meme/api/reports, X-Player-Id); lỗi HTTP ném SendError (../disc/api) có .status
 *   web/src/report/ReportDialog.tsx: <ReportDialog item={{id,name,image_key}} policyVersion storage onClose />
 *                                role="dialog" tên `Báo cáo ${name}`; radio theo nhãn; ô "Ghi chú" (maxLength 200) chỉ khi chọn "Khác";
 *                                nút "Gửi báo cáo" tắt tới khi chọn lý do; nút "Đóng"
 *   web/src/report/blocklist.ts: loadBlocklist(signal, storage) -> Promise<Blocklist>, bản lưu ở localStorage 'laumeme:blocklist'
 *   Game: prop tùy chọn onReport?(item); mỗi plate-item có nút `Báo cáo ${name}` khi có prop
 *   Root: nối onReport -> ReportDialog
 */
import { createHash, webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { initialProgress, saveProgress } from '../game/engine'
import type { Item, Manifest, Progress } from '../game/engine'
import { Game } from '../game/Game'
import { SendError } from '../disc/api'
import { ConsentRequiredError } from '../privacy/client'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { Root } from '../Root'
import { REASONS, submitReport } from './api'
import { loadBlocklist } from './blocklist'
import { ReportDialog } from './ReportDialog'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7
const C = 'Tới Công Chuyện'
const BLOCK_KEY = 'laumeme:blocklist'

function manifestOf(): Manifest {
  return {
    version: VERSION,
    batch_at: '2026-10-20T00:00:00.000Z',
    graph_url: `/api/graph/${VERSION}`,
    starters: [
      { id: eid('Cay'), name: 'Cay', emoji: '🌶️' },
      { id: eid('Cười'), name: 'Cười', emoji: '😂' },
      { id: eid('Toang'), name: 'Toang', emoji: '💀' },
      { id: eid('Deadline'), name: 'Deadline', emoji: '⏰' },
    ],
    miss_lines: Array.from({ length: 30 }, (_, i) => `Nồi trào kiểu ${i}, khét rồi!`),
    daily: { element_id: eid(C), emoji: '🍜', hint: 'gợi ý', depth: 4 },
    policy_version: 1,
  } as Manifest
}

async function buildGraph(specs: Array<{ a: string; b: string; name: string; emoji?: string }>): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of specs) {
    const plain: GraphResult = { added_version: VERSION, depth: 1, emoji: s.emoji ?? '🍲', id: eid(s.name), image_key: null, name: s.name }
    const [x, y] = [fold(s.a), fold(s.b)].sort()
    const key = sha('lm1|k|' + x + '\0' + y)
    const ikm = await webcrypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
    const okm = new Uint8Array(
      await webcrypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + VERSION), info: enc.encode('lm1|aes-gcm') },
        ikm,
        44 * 8,
      ),
    )
    const aes = await webcrypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt'])
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) }, aes, enc.encode(JSON.stringify(plain)))
    entries[key] = Buffer.from(new Uint8Array(ct)).toString('base64url')
  }
  return { format: 1, version: VERSION, entries }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

type Blocklist = { elements: string[]; recipes: string[]; images: string[] }
const EMPTY: Blocklist = { elements: [], recipes: [], images: [] }

let fetchMock: ReturnType<typeof vi.fn>
let blocklistReply: () => Response | Promise<Response>
let reportReply: () => Response

async function installNet(): Promise<void> {
  const manifest = manifestOf()
  const graph = await buildGraph([{ a: 'Cay', b: 'Cười', name: C, emoji: '🔥' }])
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.includes('/manifest')) return json(manifest)
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return blocklistReply()
    if (url.includes('/health')) return json({ status: 'ok', env: 'test', schema: '1' })
    if (url.endsWith('/api/reports') && method === 'POST') return reportReply()
    if (url.includes('/api/discoveries') && method === 'GET') return json({ items: [] })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const calls = () =>
  fetchMock.mock.calls.map((c) => ({
    url: urlOf(c[0] as RequestInfo),
    method: methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined),
    player: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id'),
    body: (c[1] as RequestInit | undefined)?.body as string | undefined,
  }))
const reportPosts = () => calls().filter((c) => c.method === 'POST' && c.url.endsWith('/lau-meme/api/reports'))
const reportBody = (n = 0) => JSON.parse(reportPosts()[n]!.body!) as { target: string; id: string; reason: string; note?: string }

let dropTarget: Element | null = null
const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
const plateNames = (): string[] => within(plateEl()).queryAllByTestId('plate-item').map((e) => e.dataset.name ?? '')
const plateItem = (name: string): HTMLElement => {
  const el = within(plateEl()).queryAllByTestId('plate-item').find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa: ${plateNames().join(', ')}`)
  return el
}
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')

function seed(mutate: (p: Progress) => void = () => {}): void {
  const p = initialProgress(manifestOf(), T0)
  p.tutorial_seen = true
  mutate(p)
  saveProgress(localStorage, p)
}
function owned(name: string, emoji: string): Item {
  return { id: eid(name), name, emoji, depth: 1, added_version: VERSION, image_key: null, discovered_at: '2026-10-01T00:00:00.000Z' }
}
const withC = () => seed((p) => p.items.push(owned(C, '🔥')))

const storeOpts = () => ({ storage: localStorage as Storage | null, policyVersion: 1 })
const REPORT_OK = (reason: string, target = 'element', id = eid('Cay')) =>
  json({ target, id, reason, status: 'new', created_at: '2026-10-20T03:00:01.000Z' }, 201)

function openDialog(item: { id: string; name: string; image_key: string | null }, onClose: () => void = () => {}) {
  return render(<ReportDialog item={item} policyVersion={1} storage={localStorage} onClose={onClose} />)
}
const CAY = { id: eid('Cay'), name: 'Cay', image_key: null }
const chooseReason = (label: string) => fireEvent.click(screen.getByRole('radio', { name: label }))
const sendBtn = () => screen.getByRole('button', { name: 'Gửi báo cáo' }) as HTMLButtonElement

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/lau-meme/')
  dropTarget = null
  blocklistReply = () => json(EMPTY)
  reportReply = () => REPORT_OK('real_person')
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ api.ts
describe('report: api', () => {
  it('AC-REPORT-01: REASONS có đúng 7 lý do theo thứ tự với nhãn tiếng Việt', () => {
    expect(REASONS).toEqual([
      { value: 'real_person', label: 'Người thật' },
      { value: 'politics_religion', label: 'Chính trị / tôn giáo' },
      { value: 'sexual', label: 'Tình dục' },
      { value: 'discrimination', label: 'Phân biệt / body shaming' },
      { value: 'violence_drugs_selfharm', label: 'Bạo lực / ma túy / tự hại' },
      { value: 'inappropriate_image', label: 'Ảnh không phù hợp' },
      { value: 'other', label: 'Khác' },
    ])
  })

  it('AC-REPORT-01: submitReport POST /lau-meme/api/reports kèm X-Player-Id và trả báo cáo máy chủ trả về', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    const out = await submitReport({ target: 'element', id: eid('Cay'), reason: 'real_person' }, storeOpts())
    expect(out).toMatchObject({ target: 'element', id: eid('Cay'), reason: 'real_person', status: 'new' })
    const [post] = reportPosts()
    expect(post!.url).toBe('/lau-meme/api/reports')
    expect(post!.player).toBe(getPlayerId(localStorage))
    expect(reportBody()).toEqual({ target: 'element', id: eid('Cay'), reason: 'real_person' })
  })

  it('AC-REPORT-02: submitReport ném SendError mang status khi máy chủ trả 422 / 404 / 429', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    for (const status of [422, 404, 429]) {
      reportReply = () => json({ type: 'about:blank', title: 'Lỗi', status }, status)
      const err = await submitReport({ target: 'element', id: eid('Cay'), reason: 'real_person' }, storeOpts()).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SendError)
      expect((err as SendError).status).toBe(status)
    }
  })

  it('AC-REPORT-01: chưa đồng ý thì submitReport ném ConsentRequiredError và không gọi fetch', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'declined')
    await expect(submitReport({ target: 'element', id: eid('Cay'), reason: 'real_person' }, storeOpts())).rejects.toBeInstanceOf(ConsentRequiredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ================================================================ ReportDialog
describe('report: ReportDialog', () => {
  it('AC-REPORT-01: hộp thoại tên "Báo cáo Cay" có 7 lựa chọn lý do, không cái nào chọn sẵn, nút "Gửi báo cáo" tắt tới khi chọn lý do', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    openDialog(CAY)
    expect(screen.getByRole('dialog', { name: 'Báo cáo Cay' })).toBeTruthy()
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios).toHaveLength(7)
    for (const r of REASONS) expect((screen.getByRole('radio', { name: r.label }) as HTMLInputElement).checked).toBe(false)
    expect(sendBtn().disabled).toBe(true)
    chooseReason('Người thật')
    expect(sendBtn().disabled).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('AC-REPORT-01: chọn "Người thật" và gửi thì POST {target:element,id,reason:real_person} rồi hiện "Cảm ơn, tụi mình sẽ xem lại"', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    openDialog(CAY)
    chooseReason('Người thật')
    fireEvent.click(sendBtn())
    expect(await screen.findByText(/Cảm ơn, tụi mình sẽ xem lại/)).toBeTruthy()
    expect(reportPosts()).toHaveLength(1)
    expect(reportBody()).toEqual({ target: 'element', id: eid('Cay'), reason: 'real_person' })
    expect(reportPosts()[0]!.player).toBe(getPlayerId(localStorage))
  })

  it('AC-REPORT-01: ô "Ghi chú" chỉ hiện khi chọn "Khác" (maxLength 200) và ghi chú được gửi kèm', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    openDialog(CAY)
    expect(screen.queryByRole('textbox', { name: 'Ghi chú' })).toBeNull()
    chooseReason('Tình dục')
    expect(screen.queryByRole('textbox', { name: 'Ghi chú' })).toBeNull()
    chooseReason('Khác')
    const note = screen.getByRole('textbox', { name: 'Ghi chú' }) as HTMLTextAreaElement | HTMLInputElement
    expect(note.maxLength).toBe(200)
    fireEvent.change(note, { target: { value: 'tên người thật' } })
    fireEvent.click(sendBtn())
    await screen.findByText(/Cảm ơn, tụi mình sẽ xem lại/)
    expect(reportBody()).toEqual({ target: 'element', id: eid('Cay'), reason: 'other', note: 'tên người thật' })
  })

  it('AC-REPORT-05: "Ảnh không phù hợp" với phần tử có ảnh gửi target image; phần tử không có ảnh hoặc lý do khác thì target element', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    const withImage = { id: eid('Cay'), name: 'Cay', image_key: 'aaaaaaaaaaaa.webp' }

    openDialog(withImage)
    chooseReason('Ảnh không phù hợp')
    fireEvent.click(sendBtn())
    await screen.findByText(/Cảm ơn, tụi mình sẽ xem lại/)
    expect(reportBody(0)).toMatchObject({ target: 'image', id: eid('Cay'), reason: 'inappropriate_image' })
    cleanup()

    openDialog(withImage)
    chooseReason('Tình dục')
    fireEvent.click(sendBtn())
    await waitFor(() => expect(reportPosts()).toHaveLength(2))
    expect(reportBody(1)).toMatchObject({ target: 'element', reason: 'sexual' })
    cleanup()

    openDialog(CAY) // image_key null
    chooseReason('Ảnh không phù hợp')
    fireEvent.click(sendBtn())
    await waitFor(() => expect(reportPosts()).toHaveLength(3))
    expect(reportBody(2)).toMatchObject({ target: 'element', reason: 'inappropriate_image' })
  })

  it('AC-REPORT-08: máy chủ trả 429 thì hiện "Gửi quá nhanh, thử lại sau." và không hiện lời cảm ơn', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    reportReply = () => json({ type: 'about:blank', title: 'Quá nhanh', status: 429 }, 429)
    openDialog(CAY)
    chooseReason('Người thật')
    fireEvent.click(sendBtn())
    expect(await screen.findByText('Gửi quá nhanh, thử lại sau.')).toBeTruthy()
    expect(screen.queryByText(/Cảm ơn, tụi mình sẽ xem lại/)).toBeNull()
  })

  it('AC-REPORT-02: máy chủ từ chối (422/404/500) thì không hiện lời cảm ơn (báo lỗi, không im lặng)', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    reportReply = () => json({ type: 'about:blank', title: 'Lỗi', status: 500 }, 500)
    openDialog(CAY)
    chooseReason('Người thật')
    fireEvent.click(sendBtn())
    await waitFor(() => expect(reportPosts()).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText(/Cảm ơn, tụi mình sẽ xem lại/)).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Báo cáo Cay' })).toBeTruthy()
  })

  it('AC-REPORT-01: chưa đồng ý thì hiện "Cần đồng ý chính sách dữ liệu để gửi" và không gửi gì', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'declined')
    openDialog(CAY)
    chooseReason('Người thật')
    fireEvent.click(sendBtn())
    expect(await screen.findByText(/Cần đồng ý chính sách dữ liệu để gửi/)).toBeTruthy()
    expect(reportPosts()).toEqual([])
    expect(calls().filter((c) => c.player !== null)).toEqual([])
    expect(screen.queryByText(/Cảm ơn, tụi mình sẽ xem lại/)).toBeNull()
  })

  it('AC-REPORT-01: nút "Đóng" gọi onClose', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'granted')
    const onClose = vi.fn()
    openDialog(CAY, onClose)
    fireEvent.click(screen.getByRole('button', { name: 'Đóng' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ================================================================ Game.onReport + Root
describe('report: nút báo cáo trên Đĩa', () => {
  async function mountGame(onReport?: (i: { id: string; name: string; image_key: string | null }) => void): Promise<void> {
    await installNet()
    withC()
    render(<Game onReport={onReport} />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
  }

  it('AC-REPORT-01: có onReport thì mỗi phần tử trên Đĩa có nút "Báo cáo <tên>"; bấm gọi onReport với {id,name,image_key}', async () => {
    const spy = vi.fn()
    await mountGame(spy)
    for (const name of ['Cay', 'Cười', C]) expect(within(plateItem(name)).getByRole('button', { name: `Báo cáo ${name}` })).toBeTruthy()
    fireEvent.click(within(plateItem(C)).getByRole('button', { name: `Báo cáo ${C}` }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toMatchObject({ id: eid(C), name: C })
    expect((spy.mock.calls[0]![0] as { image_key: unknown }).image_key ?? null).toBeNull()
  })

  it('AC-REPORT-01: bấm nút báo cáo không bắt đầu kéo và không đặt phần tử vào Nồi', async () => {
    const spy = vi.fn()
    await mountGame(spy)
    const btn = within(plateItem('Cay')).getByRole('button', { name: 'Báo cáo Cay' })
    dropTarget = slot(1)
    const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
    fireEvent.pointerDown(btn, { ...base, buttons: 1, clientX: 5, clientY: 5 })
    fireEvent.pointerMove(btn, { ...base, buttons: 1, clientX: 50, clientY: 50 })
    fireEvent.pointerMove(btn, { ...base, buttons: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(btn, { ...base, buttons: 0, clientX: 100, clientY: 100 })
    fireEvent.click(btn)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(slot(1).textContent ?? '').not.toContain('Cay')
    expect(slot(2).textContent ?? '').not.toContain('Cay')
  })

  it('AC-REPORT-01: không có prop onReport thì không có nút báo cáo nào', async () => {
    await mountGame(undefined)
    expect(screen.queryAllByRole('button', { name: /^Báo cáo / })).toEqual([])
  })

  it('AC-REPORT-01: Root: bấm "Báo cáo <C>", chọn "Người thật", gửi => POST /reports {element,id,real_person} kèm X-Player-Id rồi hiện lời cảm ơn', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    withC()
    render(<Root />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    fireEvent.click(within(plateItem(C)).getByRole('button', { name: `Báo cáo ${C}` }))
    expect(await screen.findByRole('dialog', { name: `Báo cáo ${C}` })).toBeTruthy()
    chooseReason('Người thật')
    fireEvent.click(sendBtn())
    expect(await screen.findByText(/Cảm ơn, tụi mình sẽ xem lại/)).toBeTruthy()
    expect(reportPosts()).toHaveLength(1)
    expect(reportBody()).toEqual({ target: 'element', id: eid(C), reason: 'real_person' })
    expect(reportPosts()[0]!.player).toBe(getPlayerId(localStorage))
  })
})

// ================================================================ AC-REPORT-07
describe('report: danh sách chặn phía client', () => {
  it('AC-REPORT-07: loadBlocklist GET /lau-meme/api/blocklist, trả danh sách và lưu vào localStorage laumeme:blocklist', async () => {
    await installNet()
    const list = { elements: [eid(C)], recipes: ['r'.repeat(43)], images: [eid('Cay')] }
    blocklistReply = () => json(list)
    const out = await loadBlocklist(undefined, localStorage)
    expect(out).toEqual(list)
    expect(calls().some((c) => c.method === 'GET' && c.url.includes('/lau-meme/api/blocklist'))).toBe(true)
    expect(JSON.parse(localStorage.getItem(BLOCK_KEY)!)).toEqual(list)
  })

  it('AC-REPORT-07: tải lỗi (mạng hoặc 5xx) thì dùng bản đã lưu gần nhất; chưa có bản lưu thì ba mảng rỗng', async () => {
    await installNet()
    blocklistReply = () => json({ type: 'about:blank', title: 'Lỗi', status: 503 }, 503)
    expect(await loadBlocklist(undefined, localStorage)).toEqual(EMPTY)
    const cached = { elements: [eid(C)], recipes: [], images: [] }
    localStorage.setItem(BLOCK_KEY, JSON.stringify(cached))
    expect(await loadBlocklist(undefined, localStorage)).toEqual(cached)
    blocklistReply = () => {
      throw new TypeError('Failed to fetch')
    }
    expect(await loadBlocklist(undefined, localStorage)).toEqual(cached)
    expect(await loadBlocklist(undefined, null)).toEqual(EMPTY) // no storage at all
  })

  it('AC-REPORT-07: khi khởi động, danh sách chặn tải được có C thì C bị ẩn khỏi Đĩa và bản lưu được cập nhật (không cần deploy)', async () => {
    await installNet()
    withC()
    blocklistReply = () => json({ elements: [eid(C)], recipes: [], images: [] })
    render(<Game />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    await waitFor(() => expect(plateNames()).not.toContain(C))
    expect(plateNames()).toContain('Cay')
    expect(JSON.parse(localStorage.getItem(BLOCK_KEY)!)).toEqual({ elements: [eid(C)], recipes: [], images: [] })
  })

  it('AC-REPORT-07: tải danh sách chặn lỗi nhưng bản đã lưu có C thì C vẫn bị ẩn khỏi Đĩa', async () => {
    await installNet()
    withC()
    localStorage.setItem(BLOCK_KEY, JSON.stringify({ elements: [eid(C)], recipes: [], images: [] }))
    blocklistReply = () => json({ type: 'about:blank', title: 'Lỗi', status: 500 }, 500)
    render(<Game />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    await waitFor(() => expect(plateNames()).not.toContain(C))
    expect(plateNames()).toContain('Cay')
  })

  it('AC-REPORT-07: danh sách chặn rỗng thì C hiện bình thường trên Đĩa', async () => {
    await installNet()
    withC()
    render(<Game />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    expect(plateNames()).toContain(C)
  })
})
