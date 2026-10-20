import { withBase } from '../base'
import { EMPTY_BLOCKLIST } from '../game/engine'
import type { Blocklist } from '../game/engine'
import { storageKey } from '../storage'

/** Hot block list (AC-REPORT-07): the last copy that loaded is kept, so a failed load still hides what it hid. */
export const BLOCKLIST_KEY = storageKey('blocklist')
/** New blocks reach a running game within a minute, without a new batch (AC-REPORT-07). */
export const BLOCKLIST_POLL_MS = 60_000

function asBlocklist(value: unknown): Blocklist | null {
  const v = value as Partial<Blocklist> | null
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  if (!Array.isArray(v.elements) || !Array.isArray(v.recipes) || !Array.isArray(v.images)) return null
  return { elements: v.elements, recipes: v.recipes, images: v.images }
}

function cached(storage: Storage | null): Blocklist {
  try {
    const raw = storage?.getItem(BLOCKLIST_KEY)
    return (raw ? asBlocklist(JSON.parse(raw)) : null) ?? EMPTY_BLOCKLIST
  } catch {
    return EMPTY_BLOCKLIST
  }
}

/** `fresh` skips the 60 s cache, right after the player's own report (AC-REPORT-04/05). */
export async function loadBlocklist(
  signal: AbortSignal | undefined,
  storage: Storage | null,
  fresh = false,
): Promise<Blocklist> {
  try {
    const res = await fetch(withBase(fresh ? 'api/blocklist?fresh=1' : 'api/blocklist'), { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = asBlocklist(await res.json())
    if (!list) throw new Error('blocklist: unexpected shape')
    try {
      storage?.setItem(BLOCKLIST_KEY, JSON.stringify(list))
    } catch {
      // storage blocked or full: still use the fresh list
    }
    return list
  } catch {
    return cached(storage)
  }
}
