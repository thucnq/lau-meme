import { storageKey } from '../storage'

/** Anonymous player id (ADR 0004): a browser UUID v4, created once; in memory when storage is blocked. */
export const PLAYER_KEY = storageKey('player-id')

let memoryId: string | null = null
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function getPlayerId(storage: Storage | null): string {
  try {
    if (storage) {
      // a damaged value would make every request a 400: replace it
      const stored = storage.getItem(PLAYER_KEY)
      return stored !== null && UUID_V4.test(stored) ? stored : save(storage, crypto.randomUUID())
    }
  } catch {
    // storage blocked: fall back to memory
  }
  return (memoryId ??= crypto.randomUUID())
}

/** A fresh id after erasure (AC-PRIV-05): the old one never comes back. */
export function resetPlayerId(storage: Storage | null): string {
  return save(storage, crypto.randomUUID())
}

function save(storage: Storage | null, id: string): string {
  memoryId = id
  try {
    storage?.setItem(PLAYER_KEY, id)
  } catch {
    // storage blocked or full: the id lives for this page only
  }
  return id
}
