import { storageKey } from '../storage'

/**
 * The batch's Món đặc biệt solved on this browser (AC-DAILY-05): the pair that made it, kept until the next batch
 * so a reload still shows "Đã giải" and can send the result once the player signs in.
 */
export type SolvedDaily = { a: string; b: string; name: string }

const KEY = storageKey('daily-solved')

export function loadSolved(storage: Storage | null, version: number): SolvedDaily | null {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return null
    const { version: v, a, b, name } = raw as Record<string, unknown>
    if (v !== version || typeof a !== 'string' || typeof b !== 'string' || typeof name !== 'string') return null
    return { a, b, name }
  } catch {
    return null
  }
}

export function saveSolved(storage: Storage | null, version: number, s: SolvedDaily): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ version, a: s.a, b: s.b, name: s.name }))
  } catch {
    // storage blocked: the solved state lasts until the page closes
  }
}
