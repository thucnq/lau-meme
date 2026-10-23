// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests for docs/acceptance/metric.md AC-METRIC-08: the web client queues `daily_start` once per page load
 * per version when the Món đặc biệt card first shows, and `daily_complete` (no steps) once on the first make of the dish.
 * Black-box through <Game /> and the beacon; the harness copies web/src/daily/game.ui.test.tsx.
 *
 * ASSUMPTIONS ABOUT SEAMS
 *   ./app: startMetrics() registers the visibilitychange flush (called once for the file, in beforeAll; if Game starts it
 *     itself that must be idempotent). Events of all beacons are collected, so one or many flushes both work.
 *   Dedupe of daily_start is per page load per version and lives in module state, so every test uses its own version.
 *   Consent: saveConsent(localStorage, 1, 'granted') enables sending; no consent means nothing is sent.
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentSession } from '../auth/session'
import { initialProgress, saveProgress } from '../game/engine'
import type { Item, Manifest, Progress } from '../game/engine'
import { Game } from '../game/Game'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { canSend, saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { saveSolved } from '../daily/solved'
import { startMetrics } from './app'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')

interface Spec {
  a: string
  b: string
  name: string
  emoji?: string
  depth?: number
}
const SPECS: Spec[] = [
  { a: 'Hết Cứu', b: 'Cay', name: 'Stonks', emoji: '📈', depth: 4 },
  { a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
]

async function buildGraph(version: number, specs: Spec[]): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of specs) {
    const plain: GraphResult = { added_version: version, depth: s.depth ?? 1, emoji: s.emoji ?? '🍲', id: eid(s.name), image_key: null, name: s.name }
    const [x, y] = [fold(s.a), fold(s.b)].sort()
    const key = sha('lm1|k|' + x + '\0' + y)
    const ikm = await webcrypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
    const okm = new Uint8Array(
      await webcrypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + version), info: enc.encode('lm1|aes-gcm') },
        ikm,
        44 * 8,
      ),
    )
    const aes = await webcrypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt'])
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) }, aes, enc.encode(JSON.stringify(plain)))
    entries[key] = Buffer.from(new Uint8Array(ct)).toString('base64url')
  }
  return { format: 1, version, entries }
}

function manifestOf(version: number): Manifest {
  return {
    version,
    batch_at: '2026-10-20T00:00:00.000Z',
    graph_url: `/api/graph/${version}`,
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

function item(name: string, emoji: string, depth: number, added_version: number, discovered_at: string): Item {
  return { id: eid(name), name, emoji, depth, added_version, image_key: null, discovered_at }
}

// ---------------------------------------------------------------- fake network and beacon
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

let fetchMock: ReturnType<typeof vi.fn>
let beacon: ReturnType<typeof vi.fn<(...a: unknown[]) => boolean>>

async function installNet(version: number): Promise<void> {
  const manifest = manifestOf(version)
  const graph = await buildGraph(version, SPECS)
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes('/daily/')) return json({ version, rows: [], me: null })
    if (url.includes('/auth/session')) return json({ type: 'about:blank', title: 'Chưa đăng nhập', status: 401 }, 401)
    if (url.includes('/manifest')) return json(manifest)
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsText(blob)
  })
}
async function bodyText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return readBlob(data)
  throw new Error(`unexpected beacon payload: ${String(data)}`)
}
type Ev = Record<string, unknown>
type Body = { player_id?: string; events: Ev[] }
/** Every beacon body sent so far. */
async function bodies(): Promise<Body[]> {
  return Promise.all(beacon.mock.calls.map(async (c) => JSON.parse(await bodyText((c as [string, unknown])[1])) as Body))
}
async function sent(type: string): Promise<Ev[]> {
  return (await bodies()).flatMap((b) => b.events.filter((e) => e.type === type))
}
function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}
/** Page goes to the background: the queue is flushed. */
function flush(): void {
  setVisibility('hidden')
  setVisibility('visible')
}

// ---------------------------------------------------------------- drag and drop (same as game.ui.test.tsx)
let dropTarget: Element | null = null
function drag(src: Element, dest: Element, at = { x: 100, y: 100 }): void {
  dropTarget = dest
  const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
  fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: at.x / 2, clientY: at.y / 2 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: at.x, clientY: at.y })
  fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: at.x, clientY: at.y })
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
const plateItem = (name: string): HTMLElement => {
  const el = within(plateEl())
    .queryAllByTestId('plate-item')
    .find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
  return el
}
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')
const card = (): HTMLElement => screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })

async function mountReady(): Promise<void> {
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
async function reload(): Promise<void> {
  cleanup()
  await mountReady()
}
async function potCombine(a: string, b: string): Promise<void> {
  drag(plateItem(a), slot(1))
  drag(plateItem(b), slot(2))
  await advance(1300)
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
function seed(version: number): void {
  const p: Progress = initialProgress(manifestOf(version), T0)
  p.tutorial_seen = true
  p.items.push(item('Hết Cứu', '🧯', 3, 1, '2026-10-19T00:00:00.000Z'))
  saveProgress(localStorage, p)
}

// Each test owns a version because daily_start is deduped per version for the whole page load (module state).
let nextVersion = 40
let V = 0

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
  startMetrics(() => (canSend(localStorage, 1) ? getPlayerId(localStorage) : null))
})
afterAll(() => {
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: undefined })
})
beforeEach(async () => {
  V = nextVersion++
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  dropTarget = null
  beacon = vi.fn(() => true)
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: (...a: unknown[]) => beacon(...a) })
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
  await installNet(V)
  act(() => setCurrentSession(null))
})
afterEach(() => {
  cleanup()
  act(() => setCurrentSession(null))
  setVisibility('visible')
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

describe('AC-METRIC-08: sự kiện Món đặc biệt phía client', () => {
  it('AC-METRIC-08: thẻ Món đặc biệt hiện lần đầu thì xếp đúng một daily_start { version } dù thẻ hiện lại (tải lại component)', async () => {
    saveConsent(localStorage, 1, 'granted')
    seed(V)
    await mountReady()
    expect(card()).toBeTruthy()
    flush()
    await waitFor(async () => expect(await sent('daily_start')).toHaveLength(1))
    expect((await sent('daily_start'))[0]).toEqual({ type: 'daily_start', version: V })

    await reload() // the card shows again in the same page load
    flush()
    await advance(1000)
    expect(await sent('daily_start')).toHaveLength(1)
    expect(await sent('daily_complete')).toEqual([]) // nothing solved yet
  })

  it('AC-METRIC-08: ghép ra món đặc biệt lần đầu thì xếp đúng một daily_complete { version } không có steps, chung lô với daily_start', async () => {
    saveConsent(localStorage, 1, 'granted')
    seed(V)
    await mountReady()
    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Đã giải')).toBeTruthy())

    flush()
    await waitFor(async () => expect(await sent('daily_complete')).toHaveLength(1))
    const done = (await sent('daily_complete'))[0]!
    expect(done).toEqual({ type: 'daily_complete', version: V })
    expect('steps' in done).toBe(false)
    expect(await sent('daily_start')).toEqual([{ type: 'daily_start', version: V }])
    // one batch carries both (AC-METRIC-04)
    expect(beacon).toHaveBeenCalledTimes(1)
    const [url] = beacon.mock.calls[0] as [string, unknown]
    expect(url).toMatch(/\/api\/events$/)
  })

  it('AC-METRIC-08: ghép lại món đã giải trong cùng phiên không gửi thêm daily_complete', async () => {
    saveConsent(localStorage, 1, 'granted')
    seed(V)
    await mountReady()
    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Đã giải')).toBeTruthy())
    flush()
    await waitFor(async () => expect(await sent('daily_complete')).toHaveLength(1))

    await potCombine('Hết Cứu', 'Cay') // make it again
    flush()
    await advance(1000)
    expect(await sent('daily_complete')).toHaveLength(1)
  })

  it('AC-METRIC-08: tải lại khi món đã giải rồi ghép lại thì không gửi daily_complete; thẻ hiện lại cũng không thêm daily_start', async () => {
    saveConsent(localStorage, 1, 'granted')
    saveSolved(localStorage, V, { a: 'Hết Cứu', b: 'Cay', name: 'Stonks' })
    seed(V)
    await mountReady()
    expect(within(card()).getByText('Đã giải')).toBeTruthy()
    await potCombine('Hết Cứu', 'Cay')
    flush()
    await advance(1000)
    expect(await sent('daily_complete')).toEqual([])
    expect(await sent('daily_start')).toHaveLength(1)

    await reload()
    await potCombine('Hết Cứu', 'Cay')
    flush()
    await advance(1000)
    expect(await sent('daily_complete')).toEqual([])
    expect(await sent('daily_start')).toHaveLength(1)
  })

  it('AC-METRIC-08: chưa đồng ý thì không gửi gì (không beacon, không fetch tới /events) dù đã hiện thẻ và giải món', async () => {
    seed(V)
    await mountReady()
    await potCombine('Hết Cứu', 'Cay')
    await waitFor(() => expect(within(card()).getByText('Đã giải')).toBeTruthy())
    flush()
    await advance(6 * 60_000)
    expect(beacon).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.filter((c) => urlOf(c[0] as RequestInfo).includes('/events'))).toEqual([])
  })
})
