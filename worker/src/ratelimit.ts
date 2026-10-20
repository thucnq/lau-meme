import { problem } from './http'

/**
 * Fixed-window rate limits in D1 (ADR 0004): one counter per (scope, UUID) and per (scope, IP hash).
 * The raw IP never leaves this function; only HMAC-SHA256(IP_HASH_KEY, ip) is used.
 */
export type Limit = {
  scope: string
  windowMs: number
  perPlayer: number
  perIp: number
}

const enc = new TextEncoder()

function hex(bytes: ArrayBuffer, length: number): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}

async function sha256hex16(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)), 16)
}

/** HMAC-SHA256(IP_HASH_KEY, CF-Connecting-IP) as hex, or null when the request carries no client IP. */
export async function ipHash(req: Request, env: Env): Promise<string | null> {
  const ip = req.headers.get('CF-Connecting-IP')
  if (!ip) return null
  if (!env.IP_HASH_KEY) throw new Error('IP_HASH_KEY is not configured') // fail closed
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.IP_HASH_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(ip)), 64)
}

/**
 * Counter statements for this request, to run in the caller's D1 batch (one round trip), and the verdict on
 * their results: a 429 problem with Retry-After when a counter is over its limit, otherwise null.
 */
export async function rateCounters(
  req: Request,
  env: Env,
  limit: Limit,
  player: string,
): Promise<{
  statements: D1PreparedStatement[]
  verdict: (results: D1Result[]) => Response | null
}> {
  const now = Date.now()
  const windowStart = now - (now % limit.windowMs)
  const expiresAt = windowStart + limit.windowMs
  const keys: Array<[string, number]> = [
    [`${limit.scope}:u:${await sha256hex16(player)}:${windowStart}`, limit.perPlayer],
  ]
  const ip = await ipHash(req, env)
  if (ip !== null) keys.push([`${limit.scope}:i:${await sha256hex16(ip)}:${windowStart}`, limit.perIp])
  const statements = keys.map(([bucket]) =>
    env.DB.prepare(
      `INSERT INTO rate_counter (bucket, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT (bucket) DO UPDATE SET count = count + 1 RETURNING count`,
    ).bind(bucket, expiresAt),
  )
  const verdict = (results: D1Result[]): Response | null => {
    const over = keys.some(
      ([, max], i) => ((results[i]?.results[0] as { count?: number } | undefined)?.count ?? 0) > max,
    )
    if (!over) return null
    const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000))
    return problem(429, 'Gửi quá nhanh', `Thử lại sau ${retryAfter} giây.`, {}, { 'Retry-After': String(retryAfter) })
  }
  return { statements, verdict }
}
