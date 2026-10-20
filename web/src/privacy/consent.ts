import { storageKey } from '../storage'

/** The player's choice in the consent box, per policy version (AC-PRIV-02/09). */
export const CONSENT_KEY = storageKey('consent')

export type ConsentChoice = 'granted' | 'declined'
export type StoredConsent = { version: number; choice: ConsentChoice }

export function readConsent(storage: Storage | null): StoredConsent | null {
  try {
    const raw = storage?.getItem(CONSENT_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredConsent>
    if (!Number.isInteger(value.version) || (value.choice !== 'granted' && value.choice !== 'declined')) return null
    return { version: value.version as number, choice: value.choice }
  } catch {
    return null
  }
}

export function saveConsent(storage: Storage | null, version: number, choice: ConsentChoice): void {
  try {
    storage?.setItem(CONSENT_KEY, JSON.stringify({ version, choice }))
  } catch {
    // storage blocked: the box shows again next visit
  }
}

/** Requests carrying the player id are allowed only after "Đồng ý" for the current policy version. */
export function canSend(storage: Storage | null, policyVersion: number): boolean {
  const c = readConsent(storage)
  return c !== null && c.choice === 'granted' && c.version === policyVersion
}
