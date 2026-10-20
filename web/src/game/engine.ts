/**
 * Pure game logic for "Nhúng lẩu" (docs/acceptance/game.md): progress, combining against the in-memory
 * graph, deterministic miss lines, hints, plate search/sort, hot blocklist. No network, no randomness.
 */
import { decryptEntry, elementId, fold, lookupKey } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'

export type SortMode = 'newest' | 'name' | 'depth'
export type Item = GraphResult & { discovered_at: string }
export type TableItem = { uid: string; id: string; name: string; emoji: string; x: number; y: number }
export type Progress = {
  graph_version: number
  items: Item[]
  table: TableItem[]
  sort: SortMode
  tutorial_seen: boolean
  miss_streak: number
}
export type Starter = { id: string; name: string; emoji: string }
export type Manifest = {
  version: number
  batch_at: string
  graph_url: string
  starters: Starter[]
  miss_lines: string[]
  daily: { element_id: string; emoji: string; hint: string; depth: number }
  policy_version: number
}
export type Blocklist = { elements: string[]; recipes: string[]; images: string[] }
export type Ctx = { graph: Graph; manifest: Manifest; blocklist: Blocklist; now?: () => Date }
export type CombineOutcome =
  | { kind: 'hit'; result: GraphResult; isNew: boolean; progress: Progress }
  | { kind: 'miss'; line: string; hint: string | null; progress: Progress }

export const PROGRESS_KEY = 'lm.game.progress'
export const THEME_KEY = 'lm.theme'
export const HINT_AFTER_MISSES = 3 // open question 9 — default
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
  const items = data.items.filter(isItem)
  if (items.length === 0) return null
  return {
    graph_version: data.graph_version,
    items,
    table: Array.isArray(data.table) ? data.table.filter(isTableItem) : [],
    sort: SORT_MODES.includes(data.sort as SortMode) ? (data.sort as SortMode) : 'newest',
    tutorial_seen: data.tutorial_seen === true,
    miss_streak: typeof data.miss_streak === 'number' ? data.miss_streak : 0,
  }
}

export function saveProgress(storage: Storage, p: Progress): void {
  try {
    storage.setItem(PROGRESS_KEY, JSON.stringify(p))
  } catch {
    // Storage full or blocked: the game keeps working for this session.
  }
}

/** Only the game progress is removed; UUID, nickname, Daily/streak and theme keys are kept (AC-GAME-11). */
export function resetProgress(storage: Storage): void {
  storage.removeItem(PROGRESS_KEY)
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
    const items = known ? p.items : [...p.items, { ...result, discovered_at: now.toISOString() }]
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

export function isNew(item: Item, manifestVersion: number, bl: Blocklist): boolean {
  return item.added_version === manifestVersion && !bl.elements.includes(item.id)
}

export function resolveTheme(stored: string | null, systemDark: boolean): 'light' | 'dark' {
  if (stored === 'light' || stored === 'dark') return stored
  return systemDark ? 'dark' : 'light'
}
