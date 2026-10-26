// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/feedback.md, phần web: AC-FEEDBACK-01 (nút Ngon / Nhạt sau khi ghép).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (theo mẫu của report.ui.test.tsx)
 *   web/src/feedback/api.ts:             submitVote({ a, b, value }, { storage, policyVersion }) -> Promise<Vote> qua playerFetch
 *                                        (PUT /lau-meme/api/votes, thân JSON {a,b,value}, header X-Player-Id);
 *                                        chưa đồng ý => ném ConsentRequiredError (../privacy/client) và không gọi fetch;
 *                                        lỗi HTTP ném SendError (../disc/api) có .status
 *   web/src/feedback/FeedbackButtons.tsx: <FeedbackButtons a={tên} b={tên} policyVersion storage metrics />
 *                                        hai nút tên "Ngon" và "Nhạt" (aria-pressed=false lúc đầu); bấm => submitVote;
 *                                        200 => nút đã chọn aria-pressed=true, nút kia false;
 *                                        `metrics` = { track(event) } (cùng hình dạng createMetrics ở ../metrics/metrics):
 *                                        chỉ sau khi phiếu được ghi (200) mới gọi track({ type: 'feedback', value });
 *                                        lỗi hoặc chưa đồng ý thì không gọi track; đổi ý (bấm nút kia) gửi PUT mới và track mới
 *   Game (không props): sau khi ghép ra món (A + B = C) và đã đồng ý chơi (saveConsent granted) kết quả có hai nút
 *                                        "Ngon" và "Nhạt"; bấm gửi PUT /lau-meme/api/votes với {a, b} là tên hai phần tử vừa ghép
 *                                        (thứ tự bất kỳ); chưa đồng ý thì không hiện hai nút
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendError } from '../disc/api'
import { initialProgress, saveProgress } from '../game/engine'
import type { Manifest, Progress } from '../game/engine'
import { Game } from '../game/Game'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { ConsentRequiredError } from '../privacy/client'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { submitVote } from './api'
import { FeedbackButtons } from './FeedbackButtons'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7
const C = 'Tới Công Chuyện' // Cay + Cười

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
    daily: { element_id: eid('Stonks'), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    policy_version: 1,
  } as Manifest
}

async function buildGraph(): Promise<Graph> {
  const entries: Record<string, string> = {}
  const plain: GraphResult = { added_version: VERSION, depth: 1, emoji: '🔥', id: eid(C), image_key: null, name: C }
  const [x, y] = [fold('Cay'), fold('Cười')].sort()
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
  return { format: 1, version: VERSION, entries }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

let fetchMock: ReturnType<typeof vi.fn>
let voteReply: (value: string) => Response

const VOTE_OK = (value: string): Response => json({ recipe_id: sha('lm1|k|x'), value, updated_at: '2026-10-20T03:00:01.000Z' })

async function installNet(): Promise<void> {
  const manifest = manifestOf()
  const graph = await buildGraph()
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.includes('/manifest')) return json(manifest)
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    if (url.includes('/health')) return json({ status: 'ok', env: 'test', schema: '1' })
    if (url.endsWith('/api/votes') && method === 'PUT') return voteReply((JSON.parse(String(init?.body)) as { value: string }).value)
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
const votePuts = () => calls().filter((c) => c.method === 'PUT' && c.url.endsWith('/lau-meme/api/votes'))
const voteBody = (n = 0) => JSON.parse(votePuts()[n]!.body!) as { a: string; b: string; value: string }

const storeOpts = () => ({ storage: localStorage as Storage | null, policyVersion: 1 })
const ngon = () => screen.getByRole('button', { name: 'Ngon' })
const nhat = () => screen.getByRole('button', { name: 'Nhạt' })
const pressed = (el: HTMLElement) => el.getAttribute('aria-pressed')

function renderButtons(metrics: { track: (e: Record<string, unknown>) => void }) {
  return render(<FeedbackButtons a="Cay" b="Cười" policyVersion={1} storage={localStorage} metrics={metrics} />)
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/lau-meme/')
  voteReply = VOTE_OK
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ api.ts
describe('feedback: api', () => {
  it('AC-FEEDBACK-01: submitVote PUT /lau-meme/api/votes kèm X-Player-Id, thân {a,b,value} và trả phiếu máy chủ trả về', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    const out = await submitVote({ a: 'Cay', b: 'Cười', value: 'ngon' }, storeOpts())
    expect(out).toMatchObject({ value: 'ngon' })
    const [put] = votePuts()
    expect(put!.url).toBe('/lau-meme/api/votes')
    expect(put!.player).toBe(getPlayerId(localStorage))
    expect(voteBody()).toEqual({ a: 'Cay', b: 'Cười', value: 'ngon' })
  })

  it('AC-FEEDBACK-01: chưa đồng ý thì submitVote ném ConsentRequiredError và không gọi fetch', async () => {
    await installNet()
    saveConsent(localStorage, 1, 'declined')
    await expect(submitVote({ a: 'Cay', b: 'Cười', value: 'nhat' }, storeOpts())).rejects.toBeInstanceOf(ConsentRequiredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('AC-FEEDBACK-03: submitVote ném SendError mang status khi máy chủ trả 422 / 429', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    for (const status of [422, 429]) {
      voteReply = () => json({ type: 'about:blank', title: 'Lỗi', status }, status)
      const err = await submitVote({ a: 'Cay', b: 'Cười', value: 'ngon' }, storeOpts()).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SendError)
      expect((err as SendError).status).toBe(status)
    }
  })
})

// ================================================================ FeedbackButtons
describe('feedback: nút Ngon / Nhạt', () => {
  it('AC-FEEDBACK-01: có hai nút "Ngon" và "Nhạt", chưa nút nào được chọn và chưa gửi gì', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    const metrics = { track: vi.fn() }
    renderButtons(metrics)
    expect(pressed(ngon())).toBe('false')
    expect(pressed(nhat())).toBe('false')
    expect(votePuts()).toEqual([])
    expect(metrics.track).not.toHaveBeenCalled()
  })

  it('AC-FEEDBACK-01: bấm "Ngon" gửi PUT {a,b,value:ngon} kèm UUID, nút "Ngon" được đánh dấu, "Nhạt" thì không', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    renderButtons({ track: vi.fn() })
    fireEvent.click(ngon())
    await waitFor(() => expect(pressed(ngon())).toBe('true'))
    expect(pressed(nhat())).toBe('false')
    expect(votePuts()).toHaveLength(1)
    expect(voteBody()).toEqual({ a: 'Cay', b: 'Cười', value: 'ngon' })
    expect(votePuts()[0]!.player).toBe(getPlayerId(localStorage))
  })

  it('AC-FEEDBACK-01: sau khi phiếu được ghi, xếp đúng một sự kiện {type:feedback,value} vào hàng đợi metrics', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    const metrics = { track: vi.fn() }
    renderButtons(metrics)
    fireEvent.click(nhat())
    await waitFor(() => expect(pressed(nhat())).toBe('true'))
    expect(metrics.track).toHaveBeenCalledTimes(1)
    expect(metrics.track).toHaveBeenCalledWith({ type: 'feedback', value: 'nhat' })
  })

  it('AC-FEEDBACK-01: đổi ý bấm nút kia thì gửi PUT mới, dấu chuyển sang nút mới và có thêm sự kiện feedback mới', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    const metrics = { track: vi.fn() }
    renderButtons(metrics)
    fireEvent.click(ngon())
    await waitFor(() => expect(pressed(ngon())).toBe('true'))
    fireEvent.click(nhat())
    await waitFor(() => expect(pressed(nhat())).toBe('true'))
    expect(pressed(ngon())).toBe('false')
    expect(votePuts()).toHaveLength(2)
    expect(voteBody(1)).toEqual({ a: 'Cay', b: 'Cười', value: 'nhat' })
    expect(metrics.track.mock.calls.map((c) => c[0])).toEqual([
      { type: 'feedback', value: 'ngon' },
      { type: 'feedback', value: 'nhat' },
    ])
  })

  it('AC-FEEDBACK-01: máy chủ từ chối (429 / 422 / 500) thì nút không được đánh dấu và không xếp sự kiện feedback', async () => {
    saveConsent(localStorage, 1, 'granted')
    await installNet()
    const metrics = { track: vi.fn() }
    for (const status of [429, 422, 500]) {
      voteReply = () => json({ type: 'about:blank', title: 'Lỗi', status }, status)
      const view = renderButtons(metrics)
      fireEvent.click(ngon())
      await waitFor(() => expect(votePuts().length).toBeGreaterThan(0))
      await new Promise((r) => setTimeout(r, 50))
      expect(pressed(ngon())).toBe('false')
      view.unmount()
      fetchMock.mockClear()
    }
    expect(metrics.track).not.toHaveBeenCalled()
  })

  it('AC-FEEDBACK-01: chưa đồng ý thì không gửi PUT, không đánh dấu nút và không xếp sự kiện feedback', async () => {
    saveConsent(localStorage, 1, 'declined')
    await installNet()
    const metrics = { track: vi.fn() }
    renderButtons(metrics)
    fireEvent.click(ngon())
    await new Promise((r) => setTimeout(r, 50))
    expect(votePuts()).toEqual([])
    expect(calls().filter((c) => c.player !== null)).toEqual([])
    expect(pressed(ngon())).not.toBe('true')
    expect(metrics.track).not.toHaveBeenCalled()
  })
})

// ================================================================ Game: kết quả ghép
describe('feedback: nút trên kết quả ghép của Game', () => {
  let dropTarget: Element | null = null
  const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
  const plateItem = (name: string): HTMLElement => {
    const el = within(plateEl())
      .queryAllByTestId('plate-item')
      .find((e) => (e as HTMLElement).dataset.name === name)
    if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
    return el as HTMLElement
  }
  const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
  const pot = (): HTMLElement => screen.getByTestId('pot')
  function drag(src: Element, dest: Element): void {
    dropTarget = dest
    const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
    fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
    fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: 50, clientY: 50 })
    fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: 100, clientY: 100 })
  }
  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }
  async function mountAndCombine(): Promise<void> {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(T0)
    const p: Progress = initialProgress(manifestOf(), T0)
    p.tutorial_seen = true
    saveProgress(localStorage, p)
    await installNet()
    render(<Game />)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    drag(plateItem('Cay'), slot(1))
    drag(plateItem('Cười'), slot(2))
    await advance(1300)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
  }

  beforeEach(() => {
    dropTarget = null
    ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
    ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('AC-FEEDBACK-01: ghép Cay + Cười ra món và đã đồng ý thì kết quả có nút "Ngon" và "Nhạt"; bấm "Ngon" gửi PUT với tên hai phần tử vừa ghép', async () => {
    saveConsent(localStorage, 1, 'granted')
    await mountAndCombine()
    const btn = await screen.findByRole('button', { name: 'Ngon' })
    expect(screen.getByRole('button', { name: 'Nhạt' })).toBeTruthy()
    fireEvent.click(btn)
    await waitFor(() => expect(votePuts()).toHaveLength(1))
    const body = voteBody()
    expect([body.a, body.b].sort()).toEqual(['Cay', 'Cười'].sort())
    expect(body.value).toBe('ngon')
    await waitFor(() => expect(pressed(screen.getByRole('button', { name: 'Ngon' }))).toBe('true'))
  })

  it('AC-FEEDBACK-01: chưa đồng ý thì kết quả ghép không có nút "Ngon" / "Nhạt"', async () => {
    saveConsent(localStorage, 1, 'declined')
    await mountAndCombine()
    await advance(500)
    expect(screen.queryByRole('button', { name: 'Ngon' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Nhạt' })).toBeNull()
    expect(votePuts()).toEqual([])
  })
})
