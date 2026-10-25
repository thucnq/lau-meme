// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests (jsdom) for UI3 (góp ý 2026-10-24): AC-GAME-24 (bấm món là cho vào nồi), AC-GAME-25 (hiệu ứng Vàng/Đỏ),
 * AC-GAME-26 (âm thanh Web Audio, nút loa). Layout ACs (22, 23) live in ui3.browser.test.tsx (jsdom computes no boxes).
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (everything is reached through <Game /> with no props, as in ui2.ui.test.tsx)
 *
 * AC-GAME-24
 *   - A "tap" is pointerdown + pointerup on a plate-item or table-item with total pointer movement < 6 px and a hold
 *     < 500 ms (measured with timers, i.e. fake timers control it; event.timeStamp is NOT relied upon). No `click` event is
 *     fired by the tests, so the handler must act on the pointer events. A tap puts the item into the first free pot slot
 *     (slot 1, then slot 2); when both slots are full the combine starts at once (pot data-state = 'boiling').
 *   - While the pot is boiling a tap does nothing. A hold > 500 ms (long press, AC-CONTRIB) or a move >= 6 px is not a tap.
 *   - Keyboard: a focused plate-item / table-item (the element itself or its first button/[tabindex] descendant) reacts to
 *     Enter and Space (keydown, then keyup) exactly like a tap.
 *
 * AC-GAME-25 (celebration)
 *   - [data-testid="celebrate"] exists while an effect runs and is removed when it ends, with attributes:
 *       data-kind       'gold' (first discovery of tier 4) | 'red' (first discovery of tier 5) | 'glow' (re-discovery of an owned tier 4/5)
 *       data-tier       '4' | '5'
 *       data-duration-ms  integer, the effect length in ms (gold <= 1500, red <= 2500, glow <= 600); the element is removed
 *                         no later than duration + 300 ms after it appeared
 *       data-particles  integer count of sparkle particles (DOM or canvas): gold > 0, red > gold, glow 0, reduced motion 0
 *       data-confetti   integer count of confetti pieces: red > 0, gold 0 or absent, glow 0 or absent, reduced motion 0
 *       data-fire       'true' only for red animated (red flames around the pot)
 *       data-motion     'animated' | 'static' ('static' when matchMedia('(prefers-reduced-motion: reduce)') matches)
 *   - [data-testid="table"] carries data-shake="true" only while a red effect is animating (never in reduced motion).
 *   - Skippable: Escape on the document or a click on [data-testid="discovery-zoom"] removes the effect at once (and the shake).
 *   - Not modal: no aria-modal, no role="dialog", nothing inert/aria-hidden; the next drag-and-drop works while it is up.
 *   - First discovery of tier 1-3 and misses show no celebrate element. The daily card never shows an effect/tier before the
 *     dish is made; making it (first time) shows the normal effect for its tier.
 *
 * AC-GAME-26 (sound, ADR 0017: Web Audio, no files)
 *   - window.AudioContext (and webkitAudioContext) is only constructed after a player combine, never on load.
 *   - A button in the table area (same section as the pot, outside the header) named "Tắt tiếng" while sound is on and
 *     "Bật tiếng" while muted. Default: on. The choice is stored in a localStorage key that starts with "laumeme:".
 *   - A first-time tier 4 combine starts a different node graph than a first-time tier 5 combine (the test compares the
 *     recorded calls), everything scheduled within 2 s. Muted: nothing is started (visual effect still runs).
 *   - AudioContext constructor throwing, or resume() rejecting: no role="alert", no console.error, no window.alert.
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold } from '../graph/crypto'
import type { Graph } from '../graph/crypto'
import { initialProgress, saveProgress } from './engine'
import type { Item, Manifest, Progress } from './engine'
import { Game } from './Game'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7

const V = 'Vàng Ròng' // Cay + Cười, tier 4
const R = 'Đỏ Lửa' // Cay + Toang, tier 5
const R2 = 'Đỏ Hai' // Toang + Deadline, tier 5
const V2 = 'Vàng Hai' // Cười + Toang, tier 4
const L = 'Lá Non' // Cười + Deadline, tier 2
const STONKS = 'Stonks' // Món đặc biệt: Hết Cứu + Cay, tier 5

interface Spec {
  a: string
  b: string
  name: string
  emoji: string
  tier: number
  depth?: number
}
const SPECS: Spec[] = [
  { a: 'Cay', b: 'Cười', name: V, emoji: '🌕', tier: 4 },
  { a: 'Cay', b: 'Toang', name: R, emoji: '🔥', tier: 5 },
  { a: 'Toang', b: 'Deadline', name: R2, emoji: '🌋', tier: 5 },
  { a: 'Cười', b: 'Toang', name: V2, emoji: '⭐', tier: 4 },
  { a: 'Cười', b: 'Deadline', name: L, emoji: '🍃', tier: 2 },
  { a: 'Hết Cứu', b: 'Cay', name: STONKS, emoji: '📈', tier: 5, depth: 4 },
]

async function buildGraph(version: number, specs: Spec[]): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of specs) {
    const plain = { added_version: version, depth: s.depth ?? 1, emoji: s.emoji, id: eid(s.name), image_key: null, name: s.name, tier: s.tier }
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

function manifestOf(version = VERSION): Manifest {
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
    daily: { element_id: eid(STONKS), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    policy_version: 1,
  } as Manifest
}

function owned(name: string, emoji: string, tier: number): Item {
  return { id: eid(name), name, emoji, depth: 1, added_version: VERSION, image_key: null, discovered_at: '2026-10-01T00:00:00.000Z', tier } as unknown as Item
}

// ---------------------------------------------------------------- fake network
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

let fetchMock: ReturnType<typeof vi.fn>
async function installNet(): Promise<void> {
  const manifest = manifestOf()
  const graph = await buildGraph(VERSION, SPECS)
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (url.includes('/daily/') && url.endsWith('/results') && method === 'POST') {
      return json({ version: VERSION, solve_ms: 1_805_000, rank: 2, streak: { current: 3, longest: 3 }, solved_at: '2026-10-20T06:00:05.000Z' }, 201)
    }
    if (url.includes('/manifest')) return json(manifest)
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

// ---------------------------------------------------------------- pointer / keyboard helpers
let dropTarget: Element | null = null
let reducedMotion = false

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
interface Tap {
  pointerType?: 'mouse' | 'touch'
  holdMs?: number
  moveBy?: number
  releaseOn?: Element
}
/** pointerdown + (optional move) + (optional hold) + pointerup, all on `el`; no `click` event. */
async function tap(el: Element, o: Tap = {}): Promise<void> {
  const { pointerType = 'mouse', holdMs = 0, moveBy = 0 } = o
  dropTarget = o.releaseOn ?? el
  const base = { pointerId: 7, pointerType, isPrimary: true, button: 0 }
  fireEvent.pointerDown(el, { ...base, buttons: 1, clientX: 60, clientY: 60 })
  if (moveBy) fireEvent.pointerMove(el, { ...base, buttons: 1, clientX: 60 + moveBy, clientY: 60 })
  if (holdMs) await advance(holdMs)
  fireEvent.pointerUp(el, { ...base, buttons: 0, clientX: 60 + moveBy, clientY: 60 })
}
function focusTarget(el: HTMLElement): HTMLElement {
  if (el.matches('button, [tabindex], a[href]')) return el
  return el.querySelector<HTMLElement>('button, [tabindex]') ?? el
}
function press(el: HTMLElement, key: 'Enter' | ' '): void {
  const t = focusTarget(el)
  t.focus()
  const code = key === ' ' ? 'Space' : 'Enter'
  fireEvent.keyDown(t, { key, code })
  fireEvent.keyUp(t, { key, code })
}

// ---------------------------------------------------------------- DOM queries
const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
const plateItems = (): HTMLElement[] => within(plateEl()).queryAllByTestId('plate-item')
const plateNames = (): string[] => plateItems().map((e) => e.dataset.name ?? '')
const plateItem = (name: string): HTMLElement => {
  const el = plateItems().find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa: ${plateNames().join(', ')}`)
  return el
}
const tableEl = (): HTMLElement => screen.getByTestId('table')
const tableItems = (): HTMLElement[] => screen.queryAllByTestId('table-item')
const tableNames = (): string[] => tableItems().map((e) => e.dataset.name ?? '')
const tableItem = (name: string): HTMLElement => {
  const el = tableItems().find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trên bàn: ${tableNames().join(', ')}`)
  return el
}
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')
const card = (): HTMLElement => screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })
const celebrate = (): HTMLElement | null => screen.queryByTestId('celebrate')
const zoom = (): HTMLElement | null => screen.queryByTestId('discovery-zoom')
const nOf = (el: HTMLElement, key: string): number => Number(el.dataset[key] ?? 0)

async function mountReady(): Promise<void> {
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
async function reload(): Promise<void> {
  cleanup()
  fetchMock.mockClear()
  await mountReady()
}
async function potCombine(a: string, b: string): Promise<void> {
  drag(plateItem(a), slot(1))
  drag(plateItem(b), slot(2))
  await advance(1300)
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
function seed(mutate: (p: Progress) => void = () => {}): Progress {
  const p = initialProgress(manifestOf(), T0)
  p.tutorial_seen = true
  mutate(p)
  saveProgress(localStorage, p)
  return p
}
const withIngredient = (p: Progress): void => {
  p.items.push({ ...owned('Hết Cứu', '🧯', 1), depth: 3 })
}
async function skipEffects(): Promise<void> {
  fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
  await waitFor(() => expect(celebrate()).toBeNull())
}

// ---------------------------------------------------------------- Web Audio stub
interface AudioSpy {
  instances: number
  log: string[]
  mode: 'ok' | 'throw' | 'resume-rejects'
}
let audio: AudioSpy
const fmt = (v: unknown): string => {
  if (typeof v === 'number') return String(Math.round(v * 10_000) / 10_000)
  if (typeof v === 'string' || typeof v === 'boolean' || v === null || v === undefined) return String(v)
  if (typeof v === 'function') return '<fn>'
  if (Array.isArray(v)) return `[${v.map(fmt).join(',')}]`
  return '<obj>'
}
const PARAM_NAMES = new Set(['frequency', 'gain', 'detune', 'Q', 'pan', 'playbackRate', 'threshold', 'knee', 'ratio', 'attack', 'release', 'delayTime'])
function makeParam(owner: string, name: string): unknown {
  const store: Record<string, unknown> = { value: 0 }
  return new Proxy(store, {
    get(t, p) {
      if (typeof p === 'symbol' || p === 'then') return undefined
      if (p === 'value') return t.value
      return (...args: unknown[]) => {
        audio.log.push(`${owner}.${name}.${p}(${args.map(fmt).join(',')})`)
      }
    },
    set(t, p, v) {
      if (p === 'value') {
        t.value = v
        audio.log.push(`${owner}.${name}=${fmt(v)}`)
      }
      return true
    },
  })
}
function makeNode(kind: string): unknown {
  const store: Record<string, unknown> = {}
  const params: Record<string, unknown> = {}
  return new Proxy(store, {
    get(t, p) {
      if (typeof p === 'symbol' || p === 'then') return undefined
      if (p in t) return t[p]
      if (PARAM_NAMES.has(p)) return (params[p] ??= makeParam(kind, p))
      if (p === 'connect') return (dest: unknown) => dest
      if (p === 'getChannelData') return () => new Float32Array(4096)
      if (p === 'addEventListener' || p === 'removeEventListener') return () => undefined
      return (...args: unknown[]) => {
        audio.log.push(`${kind}.${p}(${args.map(fmt).join(',')})`)
      }
    },
    set(t, p, v) {
      t[p as string] = v
      audio.log.push(`${kind}.${String(p)}=${fmt(v)}`)
      return true
    },
  })
}
class FakeAudioContext {
  currentTime = 0
  sampleRate = 48_000
  state: string
  destination = makeNode('destination')
  constructor() {
    if (audio.mode === 'throw') throw new DOMException('The AudioContext was not allowed to start.', 'NotAllowedError')
    audio.instances += 1
    this.state = audio.mode === 'resume-rejects' ? 'suspended' : 'running'
    return new Proxy(this, {
      get(t, p, r) {
        if (p in t) return Reflect.get(t, p, r)
        if (typeof p === 'string' && p.startsWith('create')) {
          return () => {
            audio.log.push(`ctx.${p}()`)
            return makeNode(p.slice(6))
          }
        }
        return undefined
      },
    })
  }
  resume(): Promise<void> {
    audio.log.push('ctx.resume()')
    return audio.mode === 'resume-rejects' ? Promise.reject(new DOMException('The AudioContext was not allowed to start.', 'NotAllowedError')) : Promise.resolve()
  }
  suspend(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}
function installAudio(mode: AudioSpy['mode'] = 'ok'): void {
  audio = { instances: 0, log: [], mode }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('webkitAudioContext', FakeAudioContext)
}
const startsIn = (log: string[]): number => log.filter((l) => /\.start\(/.test(l)).length
/** Every numeric time handed to start/stop/ramp/setValueAtTime, in seconds (the fake clock stays at 0). */
function scheduledTimes(log: string[]): number[] {
  const out: number[] = []
  for (const l of log) {
    const m = /\.(start|stop)\(([^)]*)\)/.exec(l)
    if (m) for (const a of (m[2] ?? '').split(',')) if (a.trim() !== '' && !Number.isNaN(Number(a))) out.push(Number(a))
    const r = /\.(?:linearRampToValueAtTime|exponentialRampToValueAtTime|setValueAtTime)\(([^,]*),([^)]*)\)/.exec(l)
    if (r && !Number.isNaN(Number(r[2]))) out.push(Number(r[2]))
  }
  return out
}
const speaker = (): HTMLElement => screen.getByRole('button', { name: /^(tắt|bật) tiếng$/i })
const storageSnapshot = (): Record<string, string | null> => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  window.history.pushState({}, '', '/lau-meme/')
  dropTarget = null
  reducedMotion = false
  audio = { instances: 0, log: [], mode: 'ok' }
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  Element.prototype.scrollIntoView = vi.fn()
  // jsdom has no canvas: keep a canvas particle layer from logging "Not implemented" as console.error (the code must cope with a null context)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null as never)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: reducedMotion && q.includes('prefers-reduced-motion'),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  await installNet()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ AC-GAME-24
describe('ui3: bấm món là cho vào nồi (AC-GAME-24)', () => {
  it('AC-GAME-24: bấm A ở Đĩa rồi bấm B trên bàn thì A vào chỗ 1, B vào chỗ 2 và ghép ngay như AC-GAME-02', async () => {
    seed()
    await mountReady()
    drag(plateItem('Deadline'), tableEl(), { x: 80, y: 90 })
    expect(tableNames()).toEqual(['Deadline'])

    await tap(plateItem('Cười'))
    expect(slot(1).textContent).toContain('Cười')
    expect(slot(2).textContent ?? '').not.toContain('Cười')
    expect(pot().dataset.state).toBe('idle') // mới một món: chưa ghép

    await tap(tableItem('Deadline'))
    expect(slot(2).textContent).toContain('Deadline')
    expect(pot().dataset.state).toBe('boiling') // đủ 2 chỗ thì ghép ngay, không cần thao tác thêm

    await advance(1300)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    expect(tableNames()).toContain(L)
    expect(plateNames()).toContain(L)
    expect(slot(1).textContent ?? '').not.toMatch(/Cười|Deadline/)
    expect(slot(2).textContent ?? '').not.toMatch(/Cười|Deadline/)
  })

  it('AC-GAME-24: nồi đã có một món ở chỗ 1 thì bấm A vào chỗ 2 và ghép ngay; chỗ 1 trống, chỗ 2 có món thì A vào chỗ 1', async () => {
    seed()
    await mountReady()
    drag(plateItem('Deadline'), slot(1))
    expect(slot(1).textContent).toContain('Deadline')
    await tap(plateItem('Cười'))
    expect(slot(1).textContent).toContain('Deadline')
    expect(slot(2).textContent).toContain('Cười')
    expect(pot().dataset.state).toBe('boiling')
    await advance(1300)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    expect(tableNames()).toContain(L)

    drag(plateItem('Deadline'), slot(2))
    expect(slot(2).textContent).toContain('Deadline')
    expect(slot(1).textContent ?? '').not.toContain('Deadline')
    await tap(plateItem('Cười'))
    expect(slot(1).textContent).toContain('Cười')
    expect(slot(2).textContent).toContain('Deadline')
    expect(pot().dataset.state).toBe('boiling')
  })

  it('AC-GAME-24: chạm bằng ngón tay (pointerType touch) cũng vào nồi; giữ 400 ms (< 500 ms) và nhích 5 px (< 6 px) vẫn là bấm', async () => {
    seed()
    await mountReady()
    await tap(plateItem('Cười'), { pointerType: 'touch' })
    expect(slot(1).textContent).toContain('Cười')
    await tap(plateItem('Deadline'), { pointerType: 'touch', holdMs: 400, moveBy: 5 })
    expect(slot(2).textContent).toContain('Deadline')
    expect(pot().dataset.state).toBe('boiling')
  })

  it('AC-GAME-24: trong lúc nồi đang sôi thì bấm món không làm gì', async () => {
    seed()
    await mountReady()
    await tap(plateItem('Cười'))
    await tap(plateItem('Deadline'))
    expect(pot().dataset.state).toBe('boiling')

    await tap(plateItem('Cay'))
    await tap(plateItem('Toang'))
    expect(slot(1).textContent ?? '').not.toMatch(/Cay|Toang/)
    expect(slot(2).textContent ?? '').not.toMatch(/Cay|Toang/)
    expect(tableNames()).not.toEqual(expect.arrayContaining(['Cay']))

    await advance(1300)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'))
    expect(slot(1).textContent ?? '').not.toMatch(/Cay|Toang/)
    expect(slot(2).textContent ?? '').not.toMatch(/Cay|Toang/)
    expect(tableNames()).not.toContain('Cay')
    expect(tableNames()).not.toContain('Toang')
    expect(tableNames()).toContain(L)
  })

  it('AC-GAME-24: giữ lâu hơn 500 ms (cử chỉ giữ của AC-CONTRIB) hoặc nhích từ 6 px trở lên không cho món vào nồi', async () => {
    seed()
    await mountReady()
    await tap(plateItem('Cười'), { holdMs: 600 })
    expect(slot(1).textContent ?? '').not.toContain('Cười')
    expect(slot(2).textContent ?? '').not.toContain('Cười')
    await tap(plateItem('Cười'), { pointerType: 'touch', holdMs: 700 })
    expect(slot(1).textContent ?? '').not.toContain('Cười')
    expect(slot(2).textContent ?? '').not.toContain('Cười')

    // nhích 10 px rồi nhả ngoài nồi và bàn là kéo thả trượt, không phải bấm
    await tap(plateItem('Cười'), { moveBy: 10, releaseOn: document.body })
    expect(slot(1).textContent ?? '').not.toContain('Cười')
    expect(slot(2).textContent ?? '').not.toContain('Cười')
    expect(tableNames()).toEqual([])
    expect(pot().dataset.state).toBe('idle')

    // sau đó bấm bình thường vẫn chạy
    await tap(plateItem('Cười'))
    expect(slot(1).textContent).toContain('Cười')
  })

  it('AC-GAME-24: bàn phím - phần tử Đĩa đang focus nhấn Enter, phần tử trên bàn nhấn Space cũng vào nồi như bấm', async () => {
    seed()
    await mountReady()
    drag(plateItem('Deadline'), tableEl(), { x: 80, y: 90 })
    expect(tableNames()).toEqual(['Deadline'])

    press(plateItem('Cười'), 'Enter')
    expect(slot(1).textContent).toContain('Cười')
    expect(slot(2).textContent ?? '').not.toContain('Cười')

    press(tableItem('Deadline'), ' ')
    expect(slot(2).textContent).toContain('Deadline')
    expect(slot(1).textContent ?? '').not.toContain('Deadline')
    expect(pot().dataset.state).toBe('boiling')
    await advance(1300)
    await waitFor(() => expect(tableNames()).toContain(L))
  })
})

// ================================================================ AC-GAME-25
describe('ui3: hiệu ứng ghép ra món Vàng và Đỏ (AC-GAME-25)', () => {
  it('AC-GAME-25: lần đầu ra món Vàng - ánh vàng và hạt lấp lánh <= 1,5 s, đi cùng phóng lớn, không rung, không pháo giấy, tự hết', async () => {
    seed()
    await mountReady()
    expect(celebrate()).toBeNull()
    expect(tableEl().dataset.shake).not.toBe('true')
    await potCombine('Cay', 'Cười')

    const c = await screen.findByTestId('celebrate')
    expect(c.dataset.kind).toBe('gold')
    expect(c.dataset.tier).toBe('4')
    expect(c.dataset.motion).toBe('animated')
    const dur = nOf(c, 'durationMs')
    expect(dur).toBeGreaterThan(0)
    expect(dur).toBeLessThanOrEqual(1500)
    expect(nOf(c, 'particles')).toBeGreaterThan(0)
    expect(nOf(c, 'confetti')).toBe(0)
    expect(c.dataset.fire).not.toBe('true')
    expect(tableEl().dataset.shake).not.toBe('true')
    expect(zoom()).not.toBeNull() // phóng lớn của AC-ART-08

    await advance(dur + 300)
    await waitFor(() => expect(celebrate()).toBeNull())
  })

  it('AC-GAME-25: lần đầu ra món Đỏ - lửa đỏ, bàn rung, pháo giấy, <= 2,5 s; bàn thôi rung khi hết', async () => {
    seed()
    await mountReady()
    await potCombine('Cay', 'Toang')

    const c = await screen.findByTestId('celebrate')
    expect(c.dataset.kind).toBe('red')
    expect(c.dataset.tier).toBe('5')
    expect(c.dataset.motion).toBe('animated')
    const dur = nOf(c, 'durationMs')
    expect(dur).toBeGreaterThan(0)
    expect(dur).toBeLessThanOrEqual(2500)
    expect(nOf(c, 'particles')).toBeGreaterThan(0)
    expect(nOf(c, 'confetti')).toBeGreaterThan(0)
    expect(c.dataset.fire).toBe('true')
    expect(tableEl().dataset.shake).toBe('true')
    expect(zoom()).not.toBeNull()

    await advance(dur + 300)
    await waitFor(() => expect(celebrate()).toBeNull())
    expect(tableEl().dataset.shake).not.toBe('true')
  })

  it('AC-GAME-25: hiệu ứng Đỏ lớn hơn hiệu ứng Vàng (nhiều hạt hơn, không ngắn hơn)', async () => {
    seed()
    await mountReady()
    await potCombine('Cay', 'Cười')
    const gold = await screen.findByTestId('celebrate')
    const g = { dur: nOf(gold, 'durationMs'), particles: nOf(gold, 'particles') }
    await skipEffects()

    await potCombine('Cay', 'Toang')
    const red = await screen.findByTestId('celebrate')
    expect(red.dataset.kind).toBe('red')
    expect(nOf(red, 'particles')).toBeGreaterThan(g.particles)
    expect(nOf(red, 'durationMs')).toBeGreaterThanOrEqual(g.dur)
  })

  it('AC-GAME-25: ghép ra lại món Vàng/Đỏ đã có chỉ có viền sáng ngắn <= 0,6 s, không hạt, không rung, không phóng lớn', async () => {
    seed((p) => {
      p.items.push(owned(V, '🌕', 4), owned(R, '🔥', 5))
    })
    await mountReady()

    await potCombine('Cay', 'Cười')
    const g = await screen.findByTestId('celebrate')
    expect(g.dataset.kind).toBe('glow')
    expect(g.dataset.tier).toBe('4')
    expect(nOf(g, 'durationMs')).toBeGreaterThan(0)
    expect(nOf(g, 'durationMs')).toBeLessThanOrEqual(600)
    expect(nOf(g, 'particles')).toBe(0)
    expect(nOf(g, 'confetti')).toBe(0)
    expect(g.dataset.fire).not.toBe('true')
    expect(tableEl().dataset.shake).not.toBe('true')
    expect(zoom()).toBeNull()
    await advance(nOf(g, 'durationMs') + 300)
    await waitFor(() => expect(celebrate()).toBeNull())

    await potCombine('Cay', 'Toang')
    const r = await screen.findByTestId('celebrate')
    expect(r.dataset.kind).toBe('glow')
    expect(r.dataset.tier).toBe('5')
    expect(nOf(r, 'durationMs')).toBeLessThanOrEqual(600)
    expect(nOf(r, 'particles')).toBe(0)
    expect(tableEl().dataset.shake).not.toBe('true')
    expect(zoom()).toBeNull()
  })

  it('AC-GAME-25: bỏ qua được bằng Esc (Vàng) và bằng bấm vào lớp phóng lớn (Đỏ, bàn thôi rung ngay)', async () => {
    seed()
    await mountReady()
    await potCombine('Cay', 'Cười')
    await screen.findByTestId('celebrate')
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(celebrate()).toBeNull())

    await potCombine('Cay', 'Toang')
    await screen.findByTestId('celebrate')
    expect(tableEl().dataset.shake).toBe('true')
    fireEvent.click(await screen.findByTestId('discovery-zoom'))
    await waitFor(() => expect(celebrate()).toBeNull())
    expect(tableEl().dataset.shake).not.toBe('true')
  })

  it('AC-GAME-25: không chặn kéo thả tiếp - hiệu ứng còn hiện mà ghép thêm một món vẫn chạy, không modal, không khóa Đĩa/Nồi', async () => {
    seed()
    await mountReady()
    await potCombine('Cay', 'Toang')
    const c = await screen.findByTestId('celebrate')
    expect(c.getAttribute('aria-modal')).not.toBe('true')
    expect(c.getAttribute('role')).not.toBe('dialog')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(plateEl().closest('[inert]')).toBeNull()
    expect(plateEl().closest('[aria-hidden="true"]')).toBeNull()
    expect(pot().dataset.state).toBe('idle')

    await potCombine('Cười', 'Deadline')
    expect(plateNames()).toEqual(expect.arrayContaining([R, L]))
    expect(tableNames()).toContain(L)
  })

  it('AC-GAME-25: prefers-reduced-motion thì không rung, không hạt, không pháo giấy, chỉ đổi màu viền tĩnh (Vàng và Đỏ)', async () => {
    reducedMotion = true
    seed()
    await mountReady()

    await potCombine('Cay', 'Cười')
    const g = await screen.findByTestId('celebrate')
    expect(g.dataset.kind).toBe('gold')
    expect(g.dataset.motion).toBe('static')
    expect(nOf(g, 'particles')).toBe(0)
    expect(nOf(g, 'confetti')).toBe(0)
    expect(g.dataset.fire).not.toBe('true')
    expect(tableEl().dataset.shake).not.toBe('true')
    await skipEffects()

    await potCombine('Cay', 'Toang')
    const r = await screen.findByTestId('celebrate')
    expect(r.dataset.kind).toBe('red')
    expect(r.dataset.motion).toBe('static')
    expect(nOf(r, 'particles')).toBe(0)
    expect(nOf(r, 'confetti')).toBe(0)
    expect(r.dataset.fire).not.toBe('true')
    expect(tableEl().dataset.shake).not.toBe('true')
  })

  it('AC-GAME-25: món thường (tier 1-3) lần đầu và ghép trượt không có hiệu ứng; Món đặc biệt chưa giải không lộ tier, ghép ra mới có hiệu ứng Đỏ', async () => {
    seed(withIngredient)
    await mountReady()
    expect(celebrate()).toBeNull()
    expect(card().querySelector('[data-testid="celebrate"], [data-tier], [data-kind]')).toBeNull()
    expect(within(card()).queryByRole('img', { name: /^Tier / })).toBeNull()

    await potCombine('Cay', 'Deadline') // trượt
    expect(await screen.findByTestId('miss-line')).toBeTruthy()
    expect(celebrate()).toBeNull()
    expect(card().querySelector('[data-testid="celebrate"], [data-tier], [data-kind]')).toBeNull()

    await potCombine('Cười', 'Deadline') // tier 2 lần đầu: có phóng lớn nhưng không Vàng/Đỏ
    expect(plateNames()).toContain(L)
    expect(celebrate()).toBeNull()
    expect(card().querySelector('[data-testid="celebrate"], [data-tier], [data-kind]')).toBeNull()

    await potCombine('Hết Cứu', 'Cay') // Món đặc biệt (tier 5) lần đầu
    const c = await screen.findByTestId('celebrate')
    expect(c.dataset.kind).toBe('red')
    expect(plateNames()).toContain(STONKS)
  })
})

// ================================================================ AC-GAME-26
describe('ui3: âm thanh và nút loa (AC-GAME-26)', () => {
  it('AC-GAME-26: không tạo AudioContext và không phát gì khi tải trang, kể cả khi Đĩa đã có món Vàng/Đỏ; không tải file âm thanh', async () => {
    installAudio()
    seed((p) => {
      p.items.push(owned(V, '🌕', 4), owned(R, '🔥', 5))
    })
    await mountReady()
    await advance(3000)
    expect(audio.instances).toBe(0)
    expect(startsIn(audio.log)).toBe(0)

    await potCombine('Cay', 'Cười')
    const files = fetchMock.mock.calls.map((c) => urlOf(c[0] as RequestInfo)).filter((u) => /\.(mp3|ogg|wav|m4a|aac|webm)(\?|#|$)/i.test(u))
    expect(files).toEqual([])
  })

  it('AC-GAME-26: sau thao tác ghép của người chơi, Vàng và Đỏ mỗi loại một tiếng riêng, mỗi tiếng <= 2 s', async () => {
    installAudio()
    seed()
    await mountReady()
    expect(audio.instances).toBe(0)

    audio.log.length = 0
    await potCombine('Cay', 'Cười') // Vàng
    expect(audio.instances).toBeGreaterThan(0)
    const gold = [...audio.log]
    expect(startsIn(gold), 'Vàng phải phát một tiếng').toBeGreaterThan(0)
    for (const t of scheduledTimes(gold)) expect(t).toBeLessThanOrEqual(2)
    await skipEffects()

    audio.log.length = 0
    await potCombine('Cay', 'Toang') // Đỏ
    const red = [...audio.log]
    expect(startsIn(red), 'Đỏ phải phát một tiếng').toBeGreaterThan(0)
    for (const t of scheduledTimes(red)) expect(t).toBeLessThanOrEqual(2)

    expect(red.join('|'), 'tiếng Đỏ phải khác tiếng Vàng').not.toBe(gold.join('|'))
  })

  it('AC-GAME-26: nút loa nằm trong khu bàn lẩu (cùng khu với nồi, ngoài đầu trang), mặc định bật ("Tắt tiếng")', async () => {
    installAudio()
    seed()
    await mountReady()
    const btn = speaker()
    expect(btn.getAttribute('aria-label') ?? btn.textContent).toMatch(/tắt tiếng/i)
    const header = screen.getByRole('banner')
    expect(header.contains(btn)).toBe(false)
    let section: HTMLElement | null = btn
    while (section && !section.contains(pot())) section = section.parentElement
    expect(section, 'nút loa không cùng khu với nồi').not.toBeNull()
    expect(section!.contains(header)).toBe(false)
    expect(section === document.body).toBe(false)
  })

  it('AC-GAME-26: tắt tiếng thì không phát gì (hiệu ứng hình vẫn chạy), lựa chọn lưu ở khóa "laumeme:" và còn sau khi tải lại; bật lại thì phát lại', async () => {
    installAudio()
    seed()
    await mountReady()

    const before = storageSnapshot()
    fireEvent.click(speaker())
    expect(speaker().getAttribute('aria-label') ?? speaker().textContent).toMatch(/bật tiếng/i)
    const after = storageSnapshot()
    const changed = Object.keys(after).filter((k) => before[k] !== after[k])
    expect(changed.some((k) => k.startsWith('laumeme:')), `khóa đổi: ${changed.join(', ')}`).toBe(true)

    audio.log.length = 0
    await potCombine('Cay', 'Cười')
    expect(await screen.findByTestId('celebrate')).toBeTruthy() // vẫn có hiệu ứng hình
    expect(startsIn(audio.log), 'đang tắt tiếng mà vẫn phát').toBe(0)
    await skipEffects()

    await reload()
    expect(speaker().getAttribute('aria-label') ?? speaker().textContent).toMatch(/bật tiếng/i)
    audio.log.length = 0
    await potCombine('Toang', 'Deadline') // món Đỏ khác
    expect(await screen.findByTestId('celebrate')).toBeTruthy()
    expect(startsIn(audio.log), 'sau khi tải lại vẫn phải tắt tiếng').toBe(0)
    await skipEffects()

    fireEvent.click(speaker())
    expect(speaker().getAttribute('aria-label') ?? speaker().textContent).toMatch(/tắt tiếng/i)
    audio.log.length = 0
    await potCombine('Cười', 'Toang') // món Vàng khác
    expect(startsIn(audio.log), 'bật lại tiếng thì phải phát').toBeGreaterThan(0)
  })

  describe.each([
    ['AudioContext ném lỗi khi tạo', 'throw'],
    ['resume() bị từ chối', 'resume-rejects'],
  ] as const)('trình duyệt chặn phát: %s', (label, mode) => {
    it(`AC-GAME-26: ${label} thì bỏ qua êm - ghép vẫn ra món, không role=alert, không console.error, không alert()`, async () => {
      installAudio(mode)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const alertFn = vi.fn()
      vi.stubGlobal('alert', alertFn)
      seed()
      await mountReady()

      await potCombine('Cay', 'Cười')
      await advance(500)
      expect(plateNames()).toContain(V)
      expect(tableNames()).toContain(V)
      expect(await screen.findByTestId('celebrate')).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(alertFn).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()

      await skipEffects()
      await potCombine('Cay', 'Toang')
      await advance(500)
      expect(plateNames()).toContain(R)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(errors).not.toHaveBeenCalled()
    })
  })
})
