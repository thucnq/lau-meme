import { storageKey } from '../storage'

/** Anonymous player id (ADR 0004): a browser UUID v4, created once; in memory when storage is blocked. */
export const PLAYER_KEY = storageKey('player-id')

let memoryId: string | null = null

export function getPlayerId(storage: Storage | null): string {
  try {
    const stored = storage?.getItem(PLAYER_KEY)
    if (stored) return stored
  } catch {
    // storage blocked: fall back to memory
  }
  return save(storage, memoryId ?? crypto.randomUUID())
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
