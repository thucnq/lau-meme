/**
 * Pure game logic for "Nhúng lẩu" (docs/acceptance/game.md): progress, combining against the in-memory
 * graph, deterministic miss lines, hints, plate search/sort, hot blocklist. No network, no randomness.
 */
import { decryptEntry, elementId, fold, lookupKey } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import { storageKey } from '../storage'

export type SortMode = 'newest' | 'name' | 'depth'
export type Item = GraphResult & {
  discovered_at: string
  /** The two input names this browser first made it from: the proof sent to the account plate (AC-SYNC-01/03). */
  pair?: [string, string]
}
/** One element of the account plate (GET /me/plate, ADR 0015). */
export type PlateItem = { element_id: string; found_at: string }
export type TableItem = { uid: string; id: string; name: string; emoji: string; x: number; y: number }
export type Progress = {
  graph_version: number
  items: Item[]
  table: TableItem[]
  sort: SortMode
  tutorial_seen: boolean
  /** The "hold to drag, swipe the gaps to scroll" hint on touch screens was dismissed (AC-GAME-21). */
  touch_hint_seen: boolean
  miss_streak: number
  /** Sound for Vàng/Đỏ turned off with the speaker button (AC-GAME-26); absent means on. */
  muted?: boolean
}
export type Starter = { id: string; name: string; emoji: string }
export type Manifest = {
  version: number
  batch_at: string
  graph_url: string
  starters: Starter[]
  miss_lines: string[]
  daily: { element_id: string; emoji: string; hint: string; depth: number }
  schedule_hours_utc?: number[] // AC-DAILY-12; absent in manifests published before it, meaning [5, 17]
  policy_version: number
}
export type Blocklist = { elements: string[]; recipes: string[]; images: string[] }
export type Ctx = { graph: Graph; manifest: Manifest; blocklist: Blocklist; now?: () => Date }
export type CombineOutcome =
  | { kind: 'hit'; result: GraphResult; isNew: boolean; progress: Progress }
  | { kind: 'miss'; line: string; hint: string | null; progress: Progress }

export const PROGRESS_KEY = storageKey('game.progress')
export const THEME_KEY = storageKey('theme')
/** Tabletop style (AC-GAME-28): 'plastic' (default) | 'wood'. */
export const TABLE_KEY = storageKey('table')
export type TableStyle = 'plastic' | 'wood'
export const HINT_AFTER_MISSES = 3 // open question 9 - default
export const EMPTY_BLOCKLIST: Blocklist = { elements: [], recipes: [], images: [] }

const SORT_MODES: readonly SortMode[] = ['newest', 'name', 'depth']

export function initialProgress(manifest: Manifest, now: Date): Progress {
  const at = now.toISOString()
  return {
    graph_version: manifest.version,
    items: manifest.starters.map((s) => ({
      id: s.id,
      name: s.name,
      emoji: s.emoji,
      depth: 0,
      added_version: 0,
      image_key: null,
      discovered_at: at,
    })),
    table: [],
    sort: 'newest',
    tutorial_seen: false,
    touch_hint_seen: false,
    miss_streak: 0,
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function isItem(v: unknown): v is Item {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.emoji === 'string' &&
    typeof v.depth === 'number' &&
    typeof v.added_version === 'number' &&
    typeof v.discovered_at === 'string'
  )
}

const isPair = (v: unknown): v is [string, string] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'string')

/** A malformed pair is dropped, never sent: the item just stays on this browser's plate (AC-SYNC-03). */
const withValidPair = (i: Item): Item => (i.pair === undefined || isPair(i.pair) ? i : withoutPair(i))

function withoutPair(i: Item): Item {
  if (i.pair === undefined) return i
  const rest: Item = { ...i }
  delete rest.pair
  return rest
}

function isTableItem(v: unknown): v is TableItem {
  return (
    isObject(v) &&
    typeof v.uid === 'string' &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.emoji === 'string' &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y)
  )
}

/** Stored progress, or null when there is none or it is not a valid progress object. Read-only. */
export function loadProgress(storage: Storage): Progress | null {
  let data: unknown
  try {
    const raw = storage.getItem(PROGRESS_KEY)
    if (raw === null) return null
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(data) || typeof data.graph_version !== 'number' || !Array.isArray(data.items)) return null
  // One damaged entry must not cost the whole plate: keep every valid one.
  const items = data.items.filter(isItem).map(withValidPair)
  if (items.length === 0) return null
  return {
    graph_version: data.graph_version,
    items,
    table: Array.isArray(data.table) ? data.table.filter(isTableItem) : [],
    sort: SORT_MODES.includes(data.sort as SortMode) ? (data.sort as SortMode) : 'newest',
    tutorial_seen: data.tutorial_seen === true,
    touch_hint_seen: data.touch_hint_seen === true,
    miss_streak: typeof data.miss_streak === 'number' ? data.miss_streak : 0,
    ...(data.muted === true ? { muted: true } : {}),
  }
}

export function saveProgress(storage: Storage, p: Progress): void {
  try {
    storage.setItem(PROGRESS_KEY, JSON.stringify(p))
  } catch {
    // Storage full or blocked: the game keeps working for this session.
  }
}

/** Progress made on an older graph version keeps every discovered item (AC-GAME-17). */
export function migrateProgress(p: Progress, manifest: Manifest): Progress {
  return { ...p, graph_version: manifest.version }
}

export function visibleItems(p: Progress, bl: Blocklist): Item[] {
  return p.items.filter((i) => !bl.elements.includes(i.id))
}

export function visibleTable(p: Progress, bl: Blocklist): TableItem[] {
  return p.table.filter((t) => !bl.elements.includes(t.id))
}

/** The recipe result for (a, b), or null when there is none or the recipe, an input or the result is blocked. */
export async function lookupRecipe(ctx: Ctx, a: string, b: string): Promise<GraphResult | null> {
  const bl = ctx.blocklist
  if (bl.recipes.length > 0 && bl.recipes.includes(await lookupKey(a, b))) return null
  if (bl.elements.length > 0) {
    const [ia, ib] = await Promise.all([elementId(a), elementId(b)])
    if (bl.elements.includes(ia) || bl.elements.includes(ib)) return null
  }
  const result = await decryptEntry(ctx.graph, a, b)
  if (!result || bl.elements.includes(result.id)) return null
  return result
}

/** FNV-1a over the order-independent folded pair: same pair, same line, on every device. */
export function missLine(lines: string[], a: string, b: string): string {
  const [x, y] = [fold(a), fold(b)].sort()
  const text = `${x}\0${y}`
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return lines[h % lines.length] ?? 'Nồi trào rồi!'
}

const HINT_MAX_LOOKUPS = 5000 // bounds the scan on a very full plate so the third miss never freezes the UI

/** First owned element X with a recipe X + Y (Y owned) whose result is not on the plate yet. */
async function findHint(ctx: Ctx, items: Item[]): Promise<string | null> {
  const owned = new Set(items.map((i) => i.id))
  let budget = HINT_MAX_LOOKUPS
  for (let i = 0; i < items.length && budget > 0; i++) {
    const x = items[i]!
    const partners = items.slice(i, i + budget)
    budget -= partners.length
    const results = await Promise.all(partners.map((y) => lookupRecipe(ctx, x.name, y.name)))
    if (results.some((r) => r && !owned.has(r.id))) return `Thử ${x.emoji} ${x.name} xem`
  }
  return null
}

/** Combine a with b. Never mutates `p`; the outcome carries the next progress. */
export async function combine(ctx: Ctx, p: Progress, a: string, b: string): Promise<CombineOutcome> {
  const result = await lookupRecipe(ctx, a, b)
  if (result) {
    const known = p.items.some((i) => i.id === result.id)
    const now = (ctx.now ?? (() => new Date()))()
    // a newer graph may carry a new tier for an element already on the plate (AC-TIER-03): take it on re-combine
    const items = known
      ? p.items.map((i) => (i.id === result.id && i.tier !== result.tier ? { ...i, tier: result.tier } : i))
      : [...p.items, { ...result, discovered_at: now.toISOString(), pair: [a, b] as [string, string] }]
    return { kind: 'hit', result, isNew: !known, progress: { ...p, items, miss_streak: 0 } }
  }
  const line = missLine(ctx.manifest.miss_lines, a, b)
  const streak = p.miss_streak + 1
  if (streak < HINT_AFTER_MISSES) return { kind: 'miss', line, hint: null, progress: { ...p, miss_streak: streak } }
  const hint = await findHint(ctx, visibleItems(p, ctx.blocklist))
  return { kind: 'miss', line, hint, progress: { ...p, miss_streak: 0 } }
}

export function filterItems(items: Item[], query: string): Item[] {
  const q = fold(query)
  return q === '' ? items : items.filter((i) => fold(i.name).includes(q))
}

function byName(x: Item, y: Item): number {
  const [fx, fy] = [fold(x.name), fold(y.name)]
  if (fx !== fy) return fx < fy ? -1 : 1
  return x.name < y.name ? -1 : x.name > y.name ? 1 : 0
}

export function sortItems(items: Item[], mode: SortMode): Item[] {
  const out = [...items]
  if (mode === 'newest') out.sort((x, y) => Date.parse(y.discovered_at) - Date.parse(x.discovered_at) || byName(x, y))
  else if (mode === 'name') out.sort(byName)
  else out.sort((x, y) => x.depth - y.depth || byName(x, y))
  return out
}

export const TIER_NAMES = ['Xám', 'Xanh lá', 'Xanh dương', 'Vàng', 'Đỏ'] as const

/** Tier 1-5 of an element; missing (older graph or progress) or out-of-range values read as 1 (AC-TIER-03). */
export function tierOf(item: { tier?: unknown } | undefined): number {
  const t = item?.tier
  return typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= 5 ? t : 1
}

export function isNew(item: Item, manifestVersion: number, bl: Blocklist): boolean {
  return item.added_version === manifestVersion && !bl.elements.includes(item.id)
}

export function resolveTableStyle(stored: string | null): TableStyle {
  return stored === 'wood' ? 'wood' : 'plastic'
}

export function resolveTheme(stored: string | null, systemDark: boolean): 'light' | 'dark' {
  if (stored === 'light' || stored === 'dark') return stored
  return systemDark ? 'dark' : 'light'
}

// ---------------------------------------------------------------- account plate (SYNC, ADR 0015)
/**
 * Items for the server ids this plate lacks. The graph is encrypted (ADR 0002), so each one is found by combining
 * what the plate already has, round after round, until nothing new opens. Blocked items still count as inputs: they
 * are kept, only hidden (AC-SYNC-08). An id the current graph cannot make is left out.
 */
export async function resolvePlate(graph: Graph, items: Item[], wanted: Set<string>, now: Date): Promise<Item[]> {
  const known = new Map(items.map((i) => [i.id, i]))
  const missing = new Set([...wanted].filter((id) => !known.has(id)))
  const found: Item[] = []
  let fresh = [...known.values()]
  while (missing.size > 0 && fresh.length > 0) {
    const all = [...known.values()]
    const tries = fresh.flatMap((x) => all.map((y) => [x.name, y.name] as [string, string]))
    const results = await Promise.all(tries.map(([a, b]) => decryptEntry(graph, a, b)))
    fresh = []
    results.forEach((r, i) => {
      if (!r || !missing.has(r.id)) return
      missing.delete(r.id)
      const item: Item = { ...r, discovered_at: now.toISOString(), pair: tries[i]! }
      known.set(r.id, item)
      found.push(item)
      fresh.push(item)
    })
  }
  return found
}

const earlier = (a: string, b: string): string => (Date.parse(b) < Date.parse(a) ? b : a)

/** Local plate ∪ account plate; each discovery time is the earliest of every browser (AC-SYNC-02). */
export function mergePlate(p: Progress, server: PlateItem[], resolved: Item[]): Progress {
  const at = new Map(server.map((s) => [s.element_id, s.found_at]))
  const items = p.items.map((i) => {
    const t = at.get(i.id)
    const first = t === undefined ? i.discovered_at : earlier(i.discovered_at, t)
    return first === i.discovered_at ? i : { ...i, discovered_at: first }
  })
  const have = new Set(items.map((i) => i.id))
  for (const r of resolved) {
    if (have.has(r.id)) continue
    have.add(r.id)
    items.push({ ...r, discovered_at: at.get(r.id) ?? r.discovered_at })
  }
  const changed = items.length !== p.items.length || items.some((i, n) => i !== p.items[n])
  return changed ? { ...p, items } : p
}

/** Items the account plate refused (404/422/skipped) lose their pair, so they stay on this browser only (AC-SYNC-04). */
export function dropPairs(p: Progress, ids: Set<string>): Progress {
  return { ...p, items: p.items.map((i) => (ids.has(i.id) ? withoutPair(i) : i)) }
}
