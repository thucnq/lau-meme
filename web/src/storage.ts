/**
 * localStorage on the shared dinoduct.fun origin (ADR 0007): every key carries the `laumeme:` prefix so games never
 * collide. The prefix is not a security boundary — nothing sensitive is stored client-side.
 */
export const PREFIX = 'laumeme:'

export const storageKey = (name: string): string => PREFIX + name

/** localStorage, or null when the browser blocks it (private mode, cookies off): callers then run in memory. */
export function localStore(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// Keys written before the prefix existed → their prefixed name.
const LEGACY_KEYS: Record<string, string> = {
  'lm.game.progress': 'game.progress',
  'lm.theme': 'theme',
  'lau-meme:daily-challenge': 'daily-challenge',
}

/** Moves the pre-prefix keys once; an existing prefixed value wins. Idempotent, never throws. */
export function migrateLegacyKeys(storage: Storage): void {
  try {
    for (const [legacy, name] of Object.entries(LEGACY_KEYS)) {
      const value = storage.getItem(legacy)
      if (value === null) continue
      if (storage.getItem(storageKey(name)) === null) storage.setItem(storageKey(name), value)
      storage.removeItem(legacy)
    }
  } catch {
    // storage blocked or full: old keys stay where they are and are tried again next time
  }
}
