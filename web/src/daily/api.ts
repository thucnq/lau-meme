import { withBase } from '../base'
import { SendError } from '../disc/api'
import { playerFetch, type PlayerOpts } from '../privacy/client'
import { canSend } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import type { PathStep } from './challenge'

/** Món đặc biệt results and leaderboard (AC-DAILY-06/08/09). Writes need consent; reads send the id only with it. */
export type DailyResult = {
  version: number
  steps: number
  rank: number
  streak: { current: number; longest: number }
  submitted_at: string
}
export type BoardRow = { rank: number; nickname: string; value: number }
export type DailyLeaderboard = { version: number; rows: BoardRow[]; me: BoardRow | null }

/** A 409 is not an error for the player: the stored result is shown instead (AC-DAILY-08). */
export async function submitDailyResult(
  version: number,
  body: { steps: number; path: PathStep[] },
  opts: PlayerOpts,
): Promise<{ result: DailyResult; already: boolean }> {
  const res = await playerFetch(`api/daily/${version}/results`, { method: 'POST', body: JSON.stringify(body) }, opts)
  if (res.status === 201) return { result: (await res.json()) as DailyResult, already: false }
  if (res.status === 409) return { result: ((await res.json()) as { result: DailyResult }).result, already: true }
  throw new SendError(res.status)
}

export async function getDailyLeaderboard(version: number, opts: PlayerOpts): Promise<DailyLeaderboard> {
  const headers: Record<string, string> = {}
  if (canSend(opts.storage, opts.policyVersion)) headers['X-Player-Id'] = getPlayerId(opts.storage)
  const res = await fetch(withBase(`api/daily/${version}/leaderboard`), { headers })
  if (!res.ok) throw new SendError(res.status)
  return (await res.json()) as DailyLeaderboard
}
