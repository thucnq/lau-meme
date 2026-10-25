import { withBase } from '../base'
import { playerFetch, type PlayerOpts } from '../privacy/client'

/**
 * Meme contributions on the client (AC-CONTRIB-01..11). Submitting needs consent and the sign-in cookie (sent by the
 * browser on its own); the creators snapshot and the leaderboard are public.
 */
export type StarterRef = { id: string; name: string; emoji: string }
export type ContributionStatus = 'pending' | 'approved' | 'rejected'
export type Contribution = {
  id: string
  a: StarterRef
  b: StarterRef
  name: string
  emoji: string | null
  description: string | null
  image_url: string | null
  status: ContributionStatus
  reject_reason: string | null
  created_at: string
}
export type ContributionRequest = {
  a: string
  b: string
  name: string
  emoji?: string
  description?: string
  image_url?: string
}
export type ContributorRow = { rank: number; nickname: string; approved: number }
export type ContributorLeaderboard = { rows: ContributorRow[]; me: ContributorRow | null }
/** element id → nickname of its creator (null: "Thực khách ẩn danh") */
export type Creators = Record<string, string | null>

export const STATUS_LABEL: Record<ContributionStatus, string> = {
  pending: 'Chờ duyệt',
  approved: 'Đã duyệt',
  rejected: 'Bị từ chối',
}

/** A refused submission with the server's explanation (problem+json `detail`, else `title`). */
export class ContributionError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'ContributionError'
  }
}

async function problemText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { title?: string; detail?: string }
    return body.detail ?? body.title ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function submitContribution(body: ContributionRequest, opts: PlayerOpts): Promise<Contribution> {
  const res = await playerFetch('api/contributions', { method: 'POST', body: JSON.stringify(body) }, opts)
  if (res.status !== 201) throw new ContributionError(res.status, await problemText(res))
  return (await res.json()) as Contribution
}

async function read<T>(path: string): Promise<T> {
  const res = await fetch(withBase(path), { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export const listMyContributions = () => read<{ items: Contribution[] }>('api/me/contributions?size=100').then((p) => p.items)
export const getContributorLeaderboard = () => read<ContributorLeaderboard>('api/contributors/leaderboard')
export const getCreators = (version: number) => read<Creators>(`api/creators/${version}`)
