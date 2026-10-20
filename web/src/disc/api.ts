import { withBase } from '../base'
import { playerFetch, type PlayerOpts } from '../privacy/client'

/** Công thức gia truyền on the client (AC-DISC-05..09). Writes go through playerFetch: no consent, no request. */
export type Combination = { a: string; b: string; result: string }
export type Discovery = { element_id: string; nickname: string; discovered_at: string }
export type DiscoveryResult = Discovery & { first: boolean }

const MAX_IDS = 50

export const heirloomLine = (nickname: string): string => `Công thức gia truyền của ${nickname}`

export async function submitDiscovery(combo: Combination, opts: PlayerOpts): Promise<DiscoveryResult> {
  const res = await playerFetch('api/discoveries', { method: 'POST', body: JSON.stringify(combo) }, opts)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as DiscoveryResult
}

/** Public read, no player id; at most 50 ids per request (the API's limit). */
export async function listDiscoveries(ids: string[]): Promise<Discovery[]> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += MAX_IDS) chunks.push(ids.slice(i, i + MAX_IDS))
  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const res = await fetch(withBase(`api/discoveries?ids=${chunk.map(encodeURIComponent).join(',')}`))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return ((await res.json()) as { items: Discovery[] }).items
    }),
  )
  return pages.flat()
}

export class NicknameError extends Error {
  constructor(readonly reason: 'invalid' | 'taken' | 'consent') {
    super(reason)
    this.name = 'NicknameError'
  }
}

export async function putNickname(nickname: string, opts: PlayerOpts): Promise<string> {
  const res = await playerFetch('api/me/nickname', { method: 'PUT', body: JSON.stringify({ nickname }) }, opts)
  if (res.status === 422 || res.status === 400) throw new NicknameError('invalid')
  if (res.status === 409) throw new NicknameError('taken')
  if (res.status === 403) throw new NicknameError('consent')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return ((await res.json()) as { nickname: string }).nickname
}
