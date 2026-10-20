import { withBase } from '../base'
import { EMPTY_BLOCKLIST } from '../game/engine'
import type { Blocklist } from '../game/engine'
import { storageKey } from '../storage'

/** Hot block list (AC-REPORT-07): the last copy that loaded is kept, so a failed load still hides what it hid. */
export const BLOCKLIST_KEY = storageKey('blocklist')

function cached(storage: Storage | null): Blocklist {
  try {
    const raw = storage?.getItem(BLOCKLIST_KEY)
    const value = raw ? (JSON.parse(raw) as Partial<Blocklist>) : null
    if (value && Array.isArray(value.elements) && Array.isArray(value.recipes) && Array.isArray(value.images))
      return { elements: value.elements, recipes: value.recipes, images: value.images }
  } catch {
    // unreadable copy: fall through to empty
  }
  return EMPTY_BLOCKLIST
}

export async function loadBlocklist(signal: AbortSignal | undefined, storage: Storage | null): Promise<Blocklist> {
  try {
    const res = await fetch(withBase('api/blocklist'), { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = (await res.json()) as Blocklist
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
