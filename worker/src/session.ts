import { HttpError } from './http'

/**
 * Sign-in session (ADR 0010, AC-AUTH-02): 32 random bytes as base64url in the `laumeme_sid` cookie (HttpOnly, so
 * page scripts never see it); D1 keeps only SHA-256 of it. Sliding expiry: every use moves `expires_at` to
 * now + 90 days and sets the cookie again.
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

/** Checks and renews the request's session in one statement; null when absent, unknown or expired. */
export async function readSession(req: Request, env: Env): Promise<Session | null> {
  const token = sessionToken(req)
  if (!token || !csrfSafe(req)) return null
  const now = Date.now()
  const row = await env.DB.prepare(
    `UPDATE session SET last_used_at = ?, expires_at = ? WHERE token_hash = ? AND expires_at > ? RETURNING account_id`,
  )
    .bind(now, now + SESSION_TTL_MS, await tokenHash(token), now)
    .first<{ account_id: string }>()
  return row ? { token, accountId: row.account_id } : null
}

/** For endpoints that need a session: 401 when there is none (missing, expired, signed out). */
export async function requireSession(req: Request, env: Env): Promise<Session> {
  const session = await readSession(req, env)
  if (!session) throw new HttpError(401, 'Chưa đăng nhập', 'Phiên đăng nhập không có hoặc đã hết hạn.')
  return session
}
