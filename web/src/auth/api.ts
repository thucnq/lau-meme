import { withBase } from '../base'
import { playerFetch, type PlayerOpts } from '../privacy/client'

/**
 * Google sign-in calls (ADR 0010). The session lives in the HttpOnly cookie `laumeme_sid` that the server sets;
 * this code never reads or stores it (AC-AUTH-02) - same-origin fetches send it on their own.
 */
export type SessionInfo = { nickname: string | null; created_at: string }

/** Sends the Google ID token once; needs the player's consent like every send (AC-AUTH-01, AC-PRIV-02). */
export async function signIn(credential: string, opts: PlayerOpts): Promise<SessionInfo> {
  const res = await playerFetch('api/auth/google', { method: 'POST', body: JSON.stringify({ credential }) }, opts)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as SessionInfo
}

/** The current session after a reload, or null when signed out or expired. */
export async function getSession(): Promise<SessionInfo | null> {
  const res = await fetch(withBase('api/auth/session'))
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as SessionInfo
}

export async function signOut(): Promise<void> {
  const res = await fetch(withBase('api/auth/session'), { method: 'DELETE' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}
