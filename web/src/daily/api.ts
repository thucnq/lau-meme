import { withBase } from '../base'
import { SendError } from '../disc/api'
import { playerFetch, type PlayerOpts } from '../privacy/client'

/**
 * Món đặc biệt results and leaderboards (AC-DAILY-06/08/09/14). Submitting needs consent and the sign-in cookie
 * (sent by the browser on its own); the leaderboards are public and add the own row when the cookie is there.
 */
export type DailyResult = {
  version: number
  solve_ms: number
  rank: number
  streak: { current: number; longest: number }
  solved_at: string
}
export type BoardRow = { rank: number; nickname: string; value: number }
export type DailyLeaderboard = { version: number; rows: BoardRow[]; me: BoardRow | null }
export type PeriodRow = { rank: number; nickname: string; solved: number; total_ms: number }
export type PeriodLeaderboard = {
  period: string
  starts_at: string
  ends_at: string
  batches: number
  rows: PeriodRow[]
  me: PeriodRow | null
}

/** A 409 is not an error for the player: the stored result is shown instead (AC-DAILY-08). 401 = not signed in. */
export async function submitDailyResult(
  version: number,
  pair: { a: string; b: string },
  opts: PlayerOpts,
): Promise<{ result: DailyResult; already: boolean }> {
  const body = JSON.stringify({ a: pair.a, b: pair.b })
  const res = await playerFetch(`api/daily/${version}/results`, { method: 'POST', body }, opts)
  if (res.status === 201) return { result: (await res.json()) as DailyResult, already: false }
  if (res.status === 409) return { result: ((await res.json()) as { result: DailyResult }).result, already: true }
  throw new SendError(res.status)
}

async function read<T>(path: string): Promise<T> {
  const res = await fetch(withBase(path))
  if (!res.ok) throw new SendError(res.status)
  return (await res.json()) as T
}

export const getDailyLeaderboard = (version: number) => read<DailyLeaderboard>(`api/daily/${version}/leaderboard`)

export const getPeriodLeaderboard = (period: string) =>
  read<PeriodLeaderboard>(`api/daily/leaderboard?period=${encodeURIComponent(period)}`)
