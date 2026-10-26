/**
 * Đĩa nhúng of the signed-in account (docs/acceptance/sync.md, ADR 0015). The local plate stays the source the game
 * plays from: every write runs in the background and never blocks a combine. A failed write is not queued anywhere:
 * the item keeps its pair on the local plate, and the next new discovery or page load sends whatever the account
 * plate still lacks (AC-SYNC-06). A 401 stops syncing for this session, a 429 waits for Retry-After (AC-SYNC-05/09).
 * Items kept before pairs were stored get one from this plate first (AC-SYNC-03); a tab shown again pulls the account
 * plate anew, at most once per 30 s (AC-SYNC-11).
 */
import type { Graph } from '../graph/crypto'
import { playerFetch, type PlayerOpts } from '../privacy/client'
import { dropPairs, findPairs, mergePlate, resolvePlate } from './engine'
import type { Blocklist, Item, PlateItem, Progress } from './engine'

const MAX_MERGE = 500 // AC-SYNC-09
const DEFAULT_RETRY_S = 60
const PULL_GAP_MS = 30_000 // AC-SYNC-11

type Deps = {
  graph: Graph
  blocklist: () => Blocklist
  opts: PlayerOpts
  progress: () => Progress | null
  commit: (p: Progress) => void
}
export type PlateSync = { kick: () => void; stop: () => void }

const combination = (i: Item) => ({ a: i.pair![0], b: i.pair![1], result: i.name })

export function startPlateSync(d: Deps): PlateSync {
  let server: Set<string> | null = null // ids the account plate holds; null until read
  let pulling: Promise<boolean> | null = null
  const inflight = new Set<string>()
  let stopped = false
  let retryAt = 0
  let pulledAt = -Infinity
  let paired = false

  const waiting = () => stopped || Date.now() < retryAt

  /** True when the response can be used; otherwise remembers a 401 or a 429. */
  function usable(res: Response): boolean {
    if (res.status === 401) stopped = true
    if (res.status === 429) {
      const s = Number(res.headers.get('Retry-After'))
      retryAt = Date.now() + (Number.isFinite(s) && s > 0 ? s : DEFAULT_RETRY_S) * 1000
    }
    return res.ok
  }

  const refuse = (ids: string[]) => {
    const p = d.progress()
    if (p && ids.length > 0) d.commit(dropPairs(p, new Set(ids)))
  }

  async function pull(): Promise<boolean> {
    pulledAt = Date.now()
    const res = await playerFetch('api/me/plate', {}, d.opts)
    if (!usable(res)) return false
    const { items } = (await res.json()) as { items: PlateItem[] }
    const ids = new Set(items.map((i) => i.element_id))
    const before = d.progress()
    const resolved = before ? await resolvePlate(d.graph, before.items, ids, new Date()) : []
    const p = d.progress()
    if (stopped || !p) return false
    const next = mergePlate(p, items, resolved)
    if (next !== p) d.commit(next)
    server = ids
    return true
  }

  async function write(path: string, body: unknown): Promise<Response | null> {
    const res = await playerFetch(path, { method: 'POST', body: JSON.stringify(body) }, d.opts)
    return usable(res) || res.status === 404 || res.status === 422 ? res : null
  }

  async function push(todo: Item[]): Promise<void> {
    todo.forEach((i) => inflight.add(i.id))
    try {
      if (todo.length === 1) {
        const res = await write('api/me/plate', combination(todo[0]!))
        if (res?.ok) server?.add(todo[0]!.id)
        else if (res) refuse([todo[0]!.id])
        return
      }
      for (let at = 0; at < todo.length && !waiting(); at += MAX_MERGE) {
        const chunk = todo.slice(at, at + MAX_MERGE)
        const res = await write('api/me/plate/merge', { items: chunk.map(combination) })
        if (!res?.ok) return
        const skipped = new Set(((await res.json()) as { skipped: number[] }).skipped)
        chunk.forEach((i, n) => {
          if (!skipped.has(n)) server?.add(i.id)
        })
        refuse(chunk.filter((_, n) => skipped.has(n)).map((i) => i.id))
      }
    } finally {
      todo.forEach((i) => inflight.delete(i.id))
    }
  }

  async function pair(): Promise<void> {
    const p = d.progress()
    if (!p) return
    const next = await findPairs(d.graph, p, d.blocklist())
    if (next === p || stopped) return
    const now = d.progress() ?? p
    const pairs = new Map(next.items.flatMap((i) => (i.pair ? [[i.id, i.pair] as const] : [])))
    d.commit({ ...now, items: now.items.map((i) => (i.pair || !pairs.has(i.id) ? i : { ...i, pair: pairs.get(i.id)! })) })
  }

  async function run(): Promise<void> {
    if (waiting()) return
    if (!paired) {
      paired = true
      await pair()
    }
    if (server === null) {
      pulling ??= pull().finally(() => {
        pulling = null
      })
      if (!(await pulling)) return
    }
    if (waiting() || server === null) return
    const known = server
    const todo = (d.progress()?.items ?? []).filter((i) => i.pair && !known.has(i.id) && !inflight.has(i.id))
    if (todo.length > 0) await push(todo)
  }

  const onVisible = () => {
    if (document.visibilityState !== 'visible' || Date.now() - pulledAt < PULL_GAP_MS || pulling) return
    server = null
    void run().catch(() => undefined)
  }
  document.addEventListener('visibilitychange', onVisible)

  return {
    // network errors, 5xx and missing consent: nothing to do now, the next discovery or load tries again
    kick: () => void run().catch(() => undefined),
    stop: () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisible)
    },
  }
}
