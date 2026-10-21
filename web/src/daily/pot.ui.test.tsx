// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/daily.md, phần AC-DAILY-14: ghép thử thách qua nồi lẩu.
 *
 * Hợp đồng DOM (qua <Game /> không props):
 *   Bàn thử thách  section[aria-label="Bàn thử thách"], mỗi phần tử một <button> "<emoji> <tên>", chữ "Bước: N"
 *   Nồi            [data-testid="pot"] data-state = idle | boiling | disabled; pot-slot-1 / pot-slot-2
 *   Nồi trào       [data-testid="miss-line"], gợi ý [data-testid="miss-hint"]
 *   Nồi sôi        BOIL_MS = 1000 ms
 *   Cuộn           bấm phần tử thử thách thì gọi pot.scrollIntoView({ block: 'nearest' })
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialProgress, missLine, saveProgress } from '../game/engine'
import type { Manifest } from '../game/engine'
import { Game } from '../game/Game'
import { fold } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'

// ---------------------------------------------------------------- fixtures
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7
const MISS_LINES = Array.from({ length: 30 }, (_, i) => `Nồi trào kiểu ${i}, khét rồi!`)
const HIT = { a: 'Cay', b: 'Deadline', name: 'Tới Công Chuyện', emoji: '🔥' }

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
    miss_lines: MISS_LINES,
    daily: { element_id: eid('Stonks'), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    policy_version: 1,
  } as Manifest
}

async function buildGraph(): Promise<Graph> {
  const plain: GraphResult = { added_version: VERSION, depth: 1, emoji: HIT.emoji, id: eid(HIT.name), image_key: null, name: HIT.name }
  const [x, y] = [fold(HIT.a), fold(HIT.b)].sort()
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
  return { format: 1, version: VERSION, entries: { [key]: Buffer.from(new Uint8Array(ct)).toString('base64url') } }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

function installNet(graph: Graph): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.includes('/manifest')) return json(manifestOf())
      if (url.includes('/graph/')) return json(graph)
      if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
      if (url.includes('/api/discoveries')) return json({ items: [] })
      return new Response(null, { status: 204 })
    }),
  )
}

let scrolled: Element[] = []
const originalScroll = Element.prototype.scrollIntoView

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  window.history.pushState({}, '', '/lau-meme/')
  scrolled = []
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this)
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
})
afterEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = originalScroll
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ---------------------------------------------------------------- helpers
const NAMES: Record<string, string> = {
  Cay: '🌶️ Cay',
  Cười: '😂 Cười',
  Toang: '💀 Toang',
  Deadline: '⏰ Deadline',
  [HIT.name]: `${HIT.emoji} ${HIT.name}`,
}
const board = (): HTMLElement => screen.getByRole('region', { name: 'Bàn thử thách' })
const ch = (name: string): HTMLElement => within(board()).getByRole('button', { name: NAMES[name]! })
const steps = (): number => Number(/Bước: (\d+)/.exec(board().textContent ?? '')![1])
const pot = (): HTMLElement => screen.getByTestId('pot')
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const slotTexts = (): [string, string] => [(slot(1).textContent ?? '').trim(), (slot(2).textContent ?? '').trim()]
const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
const plateNames = (): string[] => within(plateEl()).queryAllByTestId('plate-item').map((e) => (e as HTMLElement).dataset.name ?? '')
const plateItem = (name: string): HTMLElement => {
  const el = within(plateEl()).queryAllByTestId('plate-item').find((e) => (e as HTMLElement).dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa: ${plateNames().join(', ')}`)
  return el as HTMLElement
}
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function mountWithBoard(): Promise<void> {
  const p = initialProgress(manifestOf(), T0)
  p.tutorial_seen = true
  saveProgress(localStorage, p)
  installNet(await buildGraph())
  render(<Game />)
  await screen.findByRole('region', { name: 'Món đặc biệt hôm nay' })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: /thử thách/i }))
  await screen.findByRole('region', { name: 'Bàn thử thách' })
}

/** Bấm hai phần tử trên bàn thử thách, đợi nồi sôi xong. */
async function challengeMix(a: string, b: string): Promise<void> {
  fireEvent.click(ch(a))
  fireEvent.click(ch(b))
  await waitFor(() => expect(pot().dataset.state).toBe('boiling'), { timeout: 3000 })
  await advance(1100)
  await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 3000 })
}

const press = (name: string): void => {
  fireEvent.keyDown(plateItem(name), { key: 'Enter', code: 'Enter' })
}

// ================================================================ AC-DAILY-14
describe('daily pot: ghép thử thách qua nồi lẩu', () => {
  it('AC-DAILY-14: bấm phần tử thử thách đặt vào nồi (cuộn tới nồi), đủ hai thì nồi sôi, khóa bàn, rồi nồi trào và trả nồi về rỗng', async () => {
    await mountWithBoard()
    expect(steps()).toBe(0)

    fireEvent.click(ch('Cay'))
    expect(slotTexts()[0]).toContain('🌶️ Cay')
    expect(slotTexts()[1]).toBe('')
    expect(pot().dataset.state).toBe('idle')
    expect(scrolled).toContain(pot())

    fireEvent.click(ch('Cười'))
    expect(slotTexts()[1]).toContain('😂 Cười')
    await waitFor(() => expect(pot().dataset.state).toBe('boiling'), { timeout: 3000 })

    // đang sôi: bấm thêm phần tử khác không đổi gì
    const before = slotTexts()
    const stepsBefore = steps()
    fireEvent.click(ch('Toang'))
    expect(slotTexts()).toEqual(before)
    expect(steps()).toBe(stepsBefore)

    await advance(1100)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 3000 })
    expect(slotTexts()).toEqual(['', ''])
    expect(steps()).toBe(1)
    const line = (await screen.findByTestId('miss-line')).textContent ?? ''
    expect(line).toContain(missLine(MISS_LINES, 'Cay', 'Cười'))
    expect(screen.queryByTestId('miss-hint')).toBeNull()
    expect(screen.queryAllByTestId('table-item')).toHaveLength(0)
  })

  it('AC-DAILY-14: trượt liên tiếp thì câu Nồi trào ẩn lúc nồi sôi rồi hiện lại cùng câu; không bao giờ có gợi ý', async () => {
    await mountWithBoard()
    await challengeMix('Cay', 'Cười')
    const first = (await screen.findByTestId('miss-line')).textContent ?? ''

    fireEvent.click(ch('Cay'))
    fireEvent.click(ch('Cười'))
    await waitFor(() => expect(pot().dataset.state).toBe('boiling'), { timeout: 3000 })
    expect(screen.queryByTestId('miss-line')).toBeNull()
    await advance(1100)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 3000 })
    expect((await screen.findByTestId('miss-line')).textContent).toBe(first)
    expect(steps()).toBe(2)
    expect(screen.queryByTestId('miss-hint')).toBeNull()

    await challengeMix('Cay', 'Cười')
    expect(steps()).toBe(3)
    expect(screen.queryByTestId('miss-hint')).toBeNull()
  })

  it('AC-DAILY-14: ghép trúng qua nồi thì món mới lên bàn thử thách và vào Đĩa chính, không lên bàn chính, không còn câu Nồi trào', async () => {
    await mountWithBoard()
    await challengeMix('Cay', 'Cười')
    await challengeMix('Cay', 'Cười')
    await challengeMix('Cay', 'Deadline')

    expect(await within(board()).findByRole('button', { name: NAMES[HIT.name]! })).toBeTruthy()
    await waitFor(() => expect(plateNames()).toContain(HIT.name), { timeout: 3000 })
    expect(screen.queryAllByTestId('table-item')).toHaveLength(0)
    expect(screen.queryByTestId('miss-line')).toBeNull()
    expect(steps()).toBe(3)
  })

  it('AC-DAILY-14: lượt trượt của thử thách không cộng vào bộ đếm trượt liên tiếp của bàn chính (không có gợi ý)', async () => {
    await mountWithBoard()
    await challengeMix('Cay', 'Cười')
    await challengeMix('Cay', 'Cười')
    expect(screen.queryByTestId('miss-hint')).toBeNull()

    // một lần trượt ở Đĩa chính: nếu lượt trượt thử thách bị cộng dồn thì đây là lần thứ 3 và sẽ có gợi ý
    // (Cay + Deadline -> Tới Công Chuyện chưa có trên Đĩa)
    expect(plateNames()).not.toContain(HIT.name)
    press('Cười')
    press('Toang')
    await waitFor(() => expect(pot().dataset.state).toBe('boiling'), { timeout: 3000 })
    await advance(1100)
    await waitFor(() => expect(pot().dataset.state).toBe('idle'), { timeout: 3000 })
    const line = (await screen.findByTestId('miss-line')).textContent ?? ''
    expect(line).toContain(missLine(MISS_LINES, 'Cười', 'Toang'))
    expect(screen.queryByTestId('miss-hint')).toBeNull()
  })

  it('AC-DAILY-14: nồi chung - phần tử từ Đĩa rồi bấm phần tử thử thách thì nồi chỉ còn phần tử thử thách, không sôi, bộ đếm giữ nguyên', async () => {
    await mountWithBoard()
    press('Cười')
    expect(slotTexts()[0]).toContain('Cười')

    fireEvent.click(ch('Cay'))
    const texts = slotTexts()
    expect(texts.filter((t) => t.includes('Cay'))).toHaveLength(1)
    expect(texts.filter((t) => t === '')).toHaveLength(1)
    expect(texts.join('|')).not.toContain('Cười')
    expect(pot().dataset.state).toBe('idle')
    expect(steps()).toBe(0)
    await advance(1200)
    expect(pot().dataset.state).toBe('idle')
    expect(steps()).toBe(0)
  })

  it('AC-DAILY-14: nồi chung - phần tử thử thách rồi nhấn Enter ở phần tử Đĩa thì nồi chỉ còn phần tử Đĩa, không sôi, bộ đếm giữ nguyên', async () => {
    await mountWithBoard()
    fireEvent.click(ch('Cay'))
    expect(slotTexts()[0]).toContain('Cay')

    press('Toang')
    const texts = slotTexts()
    expect(texts.filter((t) => t.includes('Toang'))).toHaveLength(1)
    expect(texts.filter((t) => t === '')).toHaveLength(1)
    expect(texts.join('|')).not.toContain('Cay')
    expect(pot().dataset.state).toBe('idle')
    expect(steps()).toBe(0)
    await advance(1200)
    expect(pot().dataset.state).toBe('idle')
    expect(steps()).toBe(0)
  })
})
