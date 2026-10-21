import { HttpError } from './http'

/**
 * Sign-in session (ADR 0010, AC-AUTH-02): 32 random bytes as base64url in the `laumeme_sid` cookie (HttpOnly, so
 * page scripts never see it); D1 keeps only SHA-256 of it. Sliding expiry: every use by an endpoint that needs or
 * manages the session moves `expires_at` to now + 90 days and sets the cookie again; public leaderboard reads only
 * peek.
 */
export const SESSION_COOKIE = 'laumeme_sid'
export const SESSION_TTL_MS = 90 * 86_400_000
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export type Session = { token: string; accountId: string }

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export function newSessionToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function tokenHash(token: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
}

/** The cookie value when it has the token's shape, otherwise null (a forged or mangled cookie is no session). */
export function sessionToken(req: Request): string | null {
  const header = req.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) {
      const value = rest.join('=')
      return TOKEN.test(value) ? value : null
    }
  }
  return null
}

export function hasSessionCookie(req: Request): boolean {
  return (req.headers.get('Cookie') ?? '').split(';').some((p) => p.trim().startsWith(`${SESSION_COOKIE}=`))
}

const ATTRS = 'HttpOnly; Secure; SameSite=Lax'

export function sessionCookie(env: Env, token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=${env.BASE_PATH}; Max-Age=${SESSION_TTL_MS / 1000}; ${ATTRS}`
}

export function clearedCookie(env: Env): string {
  return `${SESSION_COOKIE}=; Path=${env.BASE_PATH}; Max-Age=0; ${ATTRS}`
}

/**
 * ADR 0010 CSRF rule: on top of SameSite=Lax, a POST/PUT/PATCH only counts as signed in when it is JSON - an HTML
 * form cannot send that content type cross-site.
 */
function csrfSafe(req: Request): boolean {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return true
  return (req.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')
}

/**
 * The statement that checks and renews the request's session, for the caller's D1 batch; null when the request
 * carries no usable session token. Read the result with `sessionFrom`.
 */
export async function sessionStatement(
  req: Request,
  env: Env,
): Promise<{ token: string; statement: D1PreparedStatement } | null> {
  const token = sessionToken(req)
  if (!token || !csrfSafe(req)) return null
  const now = Date.now()
  const statement = env.DB.prepare(
    `UPDATE session SET last_used_at = ?, expires_at = ? WHERE token_hash = ? AND expires_at > ? RETURNING account_id`,
  ).bind(now, now + SESSION_TTL_MS, await tokenHash(token), now)
  return { token, statement }
}

export function sessionFrom(token: string, result: D1Result | undefined): Session | null {
  const row = result?.results[0] as { account_id: string } | undefined
  return row ? { token, accountId: row.account_id } : null
}

/** Checks and renews the request's session in one statement; null when absent, unknown or expired. */
export async function readSession(req: Request, env: Env): Promise<Session | null> {
  const lookup = await sessionStatement(req, env)
  if (!lookup) return null
  const [result] = await env.DB.batch([lookup.statement])
  return sessionFrom(lookup.token, result)
}

/**
 * Checks the session without renewing it, for public reads that only mark "me" (Daily leaderboards): they have no
 * rate limit, so they must not write D1 on every request. Renewal stays with the endpoints that need a session.
 */
export async function peekSession(req: Request, env: Env): Promise<Session | null> {
  const token = sessionToken(req)
  if (!token || !csrfSafe(req)) return null
  const row = await env.DB.prepare('SELECT account_id FROM session WHERE token_hash = ? AND expires_at > ?')
    .bind(await tokenHash(token), Date.now())
    .first<{ account_id: string }>()
  return row ? { token, accountId: row.account_id } : null
}

/** For endpoints that need a session: 401 when there is none (missing, expired, signed out). */
export async function requireSession(req: Request, env: Env): Promise<Session> {
  return mustHave(await readSession(req, env))
}

export function mustHave(session: Session | null): Session {
  if (!session) throw new HttpError(401, 'Chưa đăng nhập', 'Phiên đăng nhập không có hoặc đã hết hạn.')
  return session
}
