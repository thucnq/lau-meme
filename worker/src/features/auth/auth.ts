import { createRemoteJWKSet, jwtVerify } from 'jose'
import { HttpError, ResponseError, json, readJson } from '../../http'
import { playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import {
  SESSION_TTL_MS,
  clearedCookie,
  newSessionToken,
  requireSession,
  sessionCookie,
  sessionToken,
  tokenHash,
} from '../../session'
import { uuidv7 } from '../../uuid'
import { type ConsentRow, playConsentStatement, requirePlayConsent } from '../player/consent'

/**
 * Google sign-in (ADR 0010, AC-AUTH-01..07): the ID token from Google Identity Services is checked here, the
 * account key is HMAC-SHA256(ACCOUNT_HASH_KEY, sub) - the raw sub, the token, email, name and picture are never
 * stored or logged.
 */
const SIGNIN_LIMIT: Limit = { scope: 'auth', windowMs: 60_000, perPlayer: 30, perIp: 10 } // AC-AUTH-07: 10/min per IP
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com']
const MAX_CREDENTIAL = 4096

const iso = (ms: number) => new Date(ms).toISOString()
const unauthorized = () => new HttpError(401, 'Đăng nhập Google không hợp lệ', 'ID token không hợp lệ hoặc đã hết hạn.')

/** The Google `sub` of a valid ID token for this game; every failure (JWKS fetch included) is the same 401. */
async function googleSub(credential: string, env: Env): Promise<string> {
  try {
    const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256'],
      clockTolerance: 60,
      requiredClaims: ['sub', 'exp'],
    })
    if (typeof payload.sub !== 'string' || payload.sub === '') throw unauthorized()
    return payload.sub
  } catch {
    throw unauthorized() // never the jose message: it may quote claims
  }
}

async function subHash(env: Env, sub: string): Promise<ArrayBuffer> {
  if (!env.ACCOUNT_HASH_KEY) throw new Error('ACCOUNT_HASH_KEY is not configured') // fail closed
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(env.ACCOUNT_HASH_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return crypto.subtle.sign('HMAC', key, enc.encode(sub))
}

function credentialOf(body: Record<string, unknown>): string {
  const credential = body.credential
  if (Object.keys(body).some((k) => k !== 'credential') || typeof credential !== 'string')
    throw new HttpError(400, 'Dữ liệu không hợp lệ', 'Cần đúng một trường credential kiểu chuỗi.')
  if (credential === '') throw unauthorized()
  if (credential.length > MAX_CREDENTIAL) throw new HttpError(400, 'Dữ liệu không hợp lệ', 'credential quá dài.')
  return credential
}

type AccountRow = { id: string; nickname: string | null; created_at: number }

/** POST /api/auth/google - find or create the account, link this browser's UUID, open a new session. */
export async function signInWithGoogle(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const credential = credentialOf(await readJson(req))
  const db = env.DB
  const limit = await rateCounters(req, env, SIGNIN_LIMIT, player)
  const results = await db.batch([...limit.statements, playConsentStatement(db, player)])
  const over = limit.verdict(results)
  if (over) throw new ResponseError(over)
  requirePlayConsent(env, results[limit.statements.length]?.results[0] as ConsentRow | undefined)

  const hash = await subHash(env, await googleSub(credential, env))
  const now = Date.now()
  const token = newSessionToken()
  const [, , , account] = await db.batch([
    db
      .prepare('INSERT INTO account (id, sub_hash, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (sub_hash) DO NOTHING')
      .bind(uuidv7(now), hash, now, now),
    // one account per UUID: signing in with another account on this browser moves the link
    db
      .prepare(
        `INSERT INTO account_player (player_id, account_id, linked_at) SELECT ?, id, ? FROM account WHERE sub_hash = ?
         ON CONFLICT (player_id) DO UPDATE SET account_id = excluded.account_id, linked_at = excluded.linked_at`,
      )
      .bind(player, now, hash),
    db
      .prepare(
        `INSERT INTO session (token_hash, account_id, created_at, last_used_at, expires_at)
         SELECT ?, id, ?, ?, ? FROM account WHERE sub_hash = ?`,
      )
      .bind(await tokenHash(token), now, now, now + SESSION_TTL_MS, hash),
    db.prepare('SELECT id, nickname, created_at FROM account WHERE sub_hash = ?').bind(hash),
  ])
  const row = account?.results[0] as AccountRow | undefined
  if (!row) throw new Error('account missing after upsert')
  return json(
    { nickname: row.nickname, created_at: iso(row.created_at) },
    { headers: { 'Set-Cookie': sessionCookie(env, token) } },
  )
}

/** GET /api/auth/session - the signed-in account after a reload; renews the session (AC-AUTH-02). */
export async function getSession(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env)
  const row = await env.DB.prepare('SELECT id, nickname, created_at FROM account WHERE id = ?')
    .bind(session.accountId)
    .first<AccountRow>()
  if (!row) throw new HttpError(401, 'Chưa đăng nhập')
  return json(
    { nickname: row.nickname, created_at: iso(row.created_at) },
    { headers: { 'Set-Cookie': sessionCookie(env, session.token) } },
  )
}

/** DELETE /api/auth/session - idempotent sign-out: the session row goes, so the old cookie is a 401 (AC-AUTH-05). */
export async function signOut(req: Request, env: Env): Promise<Response> {
  const token = sessionToken(req)
  if (token) await env.DB.prepare('DELETE FROM session WHERE token_hash = ?').bind(await tokenHash(token)).run()
  return new Response(null, { status: 204, headers: { 'Set-Cookie': clearedCookie(env) } })
}
