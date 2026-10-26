import { SendError } from '../disc/api'
import { playerFetch, type PlayerOpts } from '../privacy/client'

/** Ngon / Nhạt (AC-FEEDBACK-01..03). Goes through playerFetch: no consent, no request. */
export type VoteValue = 'ngon' | 'nhat'
export type VoteRequest = { a: string; b: string; value: VoteValue }
export type Vote = { recipe_id: string; value: VoteValue; updated_at: string }

export async function submitVote(req: VoteRequest, opts: PlayerOpts): Promise<Vote> {
  const res = await playerFetch('api/votes', { method: 'PUT', body: JSON.stringify(req) }, opts)
  if (!res.ok) throw new SendError(res.status)
  return (await res.json()) as Vote
}
