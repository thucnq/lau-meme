// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests (jsdom) for TIER: AC-TIER-02 (labels, shapes, places, hidden for the unsolved daily dish) and
 * AC-TIER-03 (graph without tier, version bump). Colour and contrast measurements live in tier.browser.test.tsx.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (reached through <Game /> with no props, as in ui2.ui.test.tsx)
 *   - plate-item and table-item carry data-tier="1".."5"; inside, one badge role="img" with accessible name
 *     "Tier <tên>" (Xám, Xanh lá, Xanh dương, Vàng, Đỏ) holding an <svg>: tier 1 a <circle>, tier 2..5 a <polygon>
 *     with 3, 4, 5, 6 points. The element held in pot-slot-N and the card discovery-zoom contain a [data-tier] box.
 *   - Item (progress) has `tier`; GraphResult has `tier`; an Item or graph entry without it means tier 1.
 *   - The daily card (region "Món đặc biệt hôm nay") shows no tier badge while the dish is unsolved.
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold } from '../graph/crypto'
import { initialProgress, saveProgress } from './engine'
import type { Item, Manifest, Progress } from './engine'
import { Game } from './Game'

// ---------------------------------------------------------------- fixtures (ADR 0002)
const enc = new TextEncoder()
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z')
const TIER_NAMES = ['Xám', 'Xanh lá', 'Xanh dương', 'Vàng', 'Đỏ'] as const
const SIDES = [0, 3, 4, 5, 6]
const ITEMS = ['Món Xám', 'Món Lá', 'Món Dương', 'Món Vàng', 'Món Đỏ']

const C = 'Tới Công Chuyện' // Cay + Cười
const D = 'Lẩu Thập Cẩm' // Cay + Toang
const STONKS = 'Stonks' // Món đặc biệt của manifest, Hết Cứu + Cay

interface Spec {
  a: string
  b: string
  name: string
  emoji: string
  depth?: number
  tier?: number // undefined = graph cũ, không có trường tier
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
    daily: { element_id: eid(STONKS), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    policy_version: 1,
  } as Manifest
}

async function buildGraph(version: number, specs: Spec[]): Promise<unknown> {
  const entries: Record<string, string> = {}
  for (const s of specs) {
    const plain: Record<string, unknown> = { added_version: version, depth: s.depth ?? 1, emoji: s.emoji, id: eid(s.name), image_key: null, name: s.name }
    if (s.tier !== undefined) plain.tier = s.tier
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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

async function installNet(version: number, specs: Spec[]): Promise<void> {
  const manifest = manifestOf(version)
  const graph = await buildGraph(version, specs)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.includes('/manifest')) return json(manifest)
      if (url.includes('/graph/')) return json(graph)
      if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
      return new Response(null, { status: 204 })
    }),
  )
}

// ---------------------------------------------------------------- interaction helpers
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
const plateNames = (): string[] => within(plateEl()).queryAllByTestId('plate-item').map((e) => (e as HTMLElement).dataset.name ?? '')
const plateItem = (name: string): HTMLElement => {
  const el = within(plateEl()).queryAllByTestId('plate-item').find((e) => (e as HTMLElement).dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa: ${plateNames().join(', ')}`)
  return el as HTMLElement
}
const slot = (n: 1 | 2): HTMLElement => screen.getByTestId(`pot-slot-${n}`)
const pot = (): HTMLElement => screen.getByTestId('pot')
async function potCombine(a: string, b: string): Promise<void> {
  drag(plateItem(a), slot(1))
  drag(plateItem(b), slot(2))
  await advance(1300)
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}
async function mountGame(): Promise<void> {
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}

const owned = (name: string, tier?: number): Item =>
  ({ id: eid(name), name, emoji: '🍲', depth: 1, added_version: 7, image_key: null, discovered_at: '2026-10-01T00:00:00.000Z', ...(tier === undefined ? {} : { tier }) }) as unknown as Item
function seed(version: number, items: Item[]): void {
  const p: Progress = initialProgress(manifestOf(version), T0)
  p.tutorial_seen = true
  p.items.push(...items)
  saveProgress(localStorage, p)
}

/** Box carrying data-tier: the element itself or its first descendant that has it. */
const tierBox = (el: HTMLElement): HTMLElement => {
  if (el.dataset.tier) return el
  const inner = el.querySelector<HTMLElement>('[data-tier]')
  if (!inner) throw new Error('Không có data-tier trong phần tử')
  return inner
}
/** Asserts label "Tier <tên>" and the exact figure for `tier` inside `holder`. */
function expectTier(holder: HTMLElement, tier: number): void {
  const box = tierBox(holder)
  expect(box.dataset.tier).toBe(String(tier))
  const badge = within(box).getByRole('img', { name: `Tier ${TIER_NAMES[tier - 1]}` })
  const svg = badge.tagName.toLowerCase() === 'svg' ? badge : badge.querySelector('svg')
  expect(svg).not.toBeNull()
  if (tier === 1) {
    expect(svg!.querySelectorAll('circle')).toHaveLength(1)
    expect(svg!.querySelectorAll('polygon')).toHaveLength(0)
  } else {
    const polygons = svg!.querySelectorAll('polygon')
    expect(polygons).toHaveLength(1)
    expect((polygons[0]!.getAttribute('points') ?? '').trim().split(/[\s,]+/).filter(Boolean).length / 2).toBe(SIDES[tier - 1])
  }
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  window.history.pushState({}, '', '/lau-meme/')
  dropTarget = null
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ AC-TIER-02
describe('tier trên phần tử', () => {
  it('AC-TIER-02: Đĩa nhúng có 5 phần tử, mỗi tier đúng nhãn "Tier <tên>" và đúng hình (tròn, tam giác 3, thoi 4, ngũ giác 5, lục giác 6); phần tử khởi đầu là Xám', async () => {
    await installNet(7, [])
    seed(7, ITEMS.map((n, i) => owned(n, i + 1)))
    await mountGame()
    for (let tier = 1; tier <= 5; tier++) expectTier(plateItem(ITEMS[tier - 1]!), tier)
    for (const starter of ['Cay', 'Cười', 'Toang', 'Deadline']) expectTier(plateItem(starter), 1)
    // nhãn trình đọc màn hình là duy nhất cho mỗi tier
    expect(new Set(ITEMS.map((n) => within(plateItem(n)).getByRole('img', { name: /^Tier / }).getAttribute('aria-label'))).size).toBe(5)
  })

  it('AC-TIER-02: thả phần tử lên bàn và vào nồi vẫn mang đúng tier (Vàng trên bàn, Đỏ trong nồi)', async () => {
    await installNet(7, [])
    seed(7, ITEMS.map((n, i) => owned(n, i + 1)))
    await mountGame()
    drag(plateItem('Món Vàng'), screen.getByTestId('table'))
    await waitFor(() => expect(screen.getAllByTestId('table-item')).toHaveLength(1))
    expectTier(screen.getByTestId('table-item'), 4)
    drag(plateItem('Món Đỏ'), slot(1))
    await waitFor(() => expect(within(slot(1)).queryByText('Món Đỏ')).not.toBeNull())
    expectTier(slot(1), 5)
  })

  it('AC-TIER-02: ghép ra phần tử tier 4 từ graph thì thẻ kết quả (discovery-zoom), phần tử trên bàn và trong Đĩa đều hiện "Tier Vàng" hình ngũ giác', async () => {
    await installNet(7, [{ a: 'Cay', b: 'Cười', name: C, emoji: '🔥', tier: 4 }])
    seed(7, [])
    await mountGame()
    await potCombine('Cay', 'Cười')
    expectTier(screen.getByTestId('discovery-zoom'), 4)
    expectTier(plateItem(C), 4)
    await waitFor(() => expect(screen.getAllByTestId('table-item').map((e) => e.dataset.name)).toContain(C))
    expectTier(screen.getAllByTestId('table-item').find((e) => e.dataset.name === C)!, 4)
  })

  it('AC-TIER-02: Món đặc biệt chưa giải không lộ tier, dù graph gán tier 5 cho món đó', async () => {
    await installNet(7, [
      { a: 'Hết Cứu', b: 'Cay', name: STONKS, emoji: '📈', depth: 4, tier: 5 },
      { a: 'Cay', b: 'Cười', name: C, emoji: '🔥', tier: 2 },
    ])
    seed(7, [])
    await mountGame()
    const card = screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })
    expect(within(card).queryByRole('img', { name: /^Tier / })).toBeNull()
    expect(card.querySelector('[data-tier]')).toBeNull()
    expect(card.textContent ?? '').not.toMatch(/Tier|Đỏ|lục giác/)
    // ghép một món thường không làm lộ tier của món đặc biệt
    await potCombine('Cay', 'Cười')
    expect(within(screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })).queryByRole('img', { name: /^Tier / })).toBeNull()
  })
})

// ================================================================ AC-TIER-03
describe('graph cũ chưa có tier', () => {
  it('AC-TIER-03: tiến độ cũ (mục không có tier) và phần tử khởi đầu hiện như tier 1 Xám, không lỗi', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await installNet(7, [{ a: 'Cay', b: 'Cười', name: C, emoji: '🔥' }])
    seed(7, [owned(C), owned(D)])
    await mountGame()
    for (const name of [C, D, 'Cay', 'Cười', 'Toang', 'Deadline']) expectTier(plateItem(name), 1)
    expect(errors).not.toHaveBeenCalled()
  })

  it('AC-TIER-03: graph cũ không có trường tier thì phần tử vừa ghép ra hiện như tier 1 trên thẻ kết quả, bàn và Đĩa, không lỗi', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await installNet(7, [{ a: 'Cay', b: 'Cười', name: C, emoji: '🔥' }])
    seed(7, [])
    await mountGame()
    await potCombine('Cay', 'Cười')
    expect(plateNames()).toContain(C)
    expectTier(screen.getByTestId('discovery-zoom'), 1)
    expectTier(plateItem(C), 1)
    expect(errors).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AC-TIER-03: manifest lên version mới có tier thì phần tử hiện đúng tier mà không mất tiến độ (AC-GAME-17)', async () => {
    // lần mở 1: graph v7 cũ, không có tier
    await installNet(7, [
      { a: 'Cay', b: 'Cười', name: C, emoji: '🔥' },
      { a: 'Cay', b: 'Toang', name: D, emoji: '🥣' },
    ])
    seed(7, [owned(C), owned(D)])
    await mountGame()
    expectTier(plateItem(C), 1)
    cleanup()
    vi.unstubAllGlobals()
    vi.stubGlobal('crypto', webcrypto)

    // lần mở 2: manifest v8, graph v8 có tier (C: 4, D: 3); tiến độ cục bộ giữ nguyên từ lần 1
    await installNet(8, [
      { a: 'Cay', b: 'Cười', name: C, emoji: '🔥', tier: 4 },
      { a: 'Cay', b: 'Toang', name: D, emoji: '🥣', tier: 3 },
    ])
    await mountGame()
    expect(plateNames()).toEqual(expect.arrayContaining([C, D, 'Cay', 'Cười', 'Toang', 'Deadline']))
    await potCombine('Cay', 'Cười')
    await potCombine('Cay', 'Toang')
    expect(plateNames()).toEqual(expect.arrayContaining([C, D])) // không mất phần tử nào
    expectTier(plateItem(C), 4)
    expectTier(plateItem(D), 3)
    // tiến độ cục bộ vẫn còn đủ hai phần tử đã khám phá
    const saved = JSON.stringify(Object.keys(localStorage).map((k) => localStorage.getItem(k)))
    expect(saved).toContain(eid(C))
    expect(saved).toContain(eid(D))
  })
})
