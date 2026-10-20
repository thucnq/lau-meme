import { withBase } from '../base'
import { canSend, saveConsent } from './consent'
import { getPlayerId, resetPlayerId } from './player'

/**
 * The only way the app sends the player id (AC-PRIV-02): without consent for the current policy version nothing
 * leaves the browser. Reading and erasing one's own data (`/me`) needs no consent (ADR 0004).
 */
export class ConsentRequiredError extends Error {
  constructor() {
    super('Cần đồng ý chính sách dữ liệu trước khi gửi')
    this.name = 'ConsentRequiredError'
  }
}

export type PlayerOpts = { storage: Storage | null; policyVersion: number }

function send(path: string, init: RequestInit, storage: Storage | null): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Player-Id', getPlayerId(storage))
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  return fetch(withBase(path), { ...init, headers })
}

export async function playerFetch(path: string, init: RequestInit, opts: PlayerOpts): Promise<Response> {
  if (!canSend(opts.storage, opts.policyVersion)) throw new ConsentRequiredError()
  return send(path, init, opts.storage)
}

async function postConsent(storage: Storage | null, body: object): Promise<void> {
  const res = await send('api/consents', { method: 'POST', body: JSON.stringify(body) }, storage)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** Records the grant on the server, then remembers it locally (the server is the second check). */
export async function grantConsent(opts: PlayerOpts, purpose: 'play' | 'nickname' = 'play'): Promise<void> {
  await postConsent(opts.storage, { purpose, action: 'grant', policy_version: opts.policyVersion })
  if (purpose === 'play') saveConsent(opts.storage, opts.policyVersion, 'granted')
}

/** AC-PRIV-04: the withdraw row is the last request sent with the player id. */
export async function withdrawConsent(opts: PlayerOpts): Promise<void> {
  await postConsent(opts.storage, { purpose: 'play', action: 'withdraw', policy_version: opts.policyVersion })
  saveConsent(opts.storage, opts.policyVersion, 'declined')
}

export async function getMyData(storage: Storage | null): Promise<MyData> {
  const res = await send('api/me', {}, storage)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as MyData
}

/** AC-PRIV-05: erase on the server, then a new local id. */
export async function deleteMyData(storage: Storage | null): Promise<void> {
  const res = await send('api/me', { method: 'DELETE' }, storage)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  resetPlayerId(storage)
}

export type MyData = {
  nickname: string | null
  discoveries: Array<{ element_id: string; discovered_at: string }>
  daily_results: Array<{ version: number; steps: number; rank: number; submitted_at: string }>
  streak: { current: number; longest: number }
  reports: Array<{ target: string; id: string; reason: string; created_at: string }>
  votes: Array<{ recipe_id: string; value: string; updated_at: string }>
  consents: Array<{ purpose: string; action: string; policy_version: number; created_at: string }>
  event_counts: Record<string, number>
}
