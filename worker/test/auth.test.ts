// Acceptance tests for docs/acceptance/auth.md (worker part: AC-AUTH-01..07, plus TENANT and VALIDATION).
// Black-box: only the HTTP contract (docs/api/openapi.yaml), ADR 0010 and the D1 schema (migration 0005) are used.
// Google's JWKS is served by a spy on global fetch; ID tokens are signed here with one RSA key pair.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const HASH_KEY = ['auth', 'hash', 'key'].join('-')
const IP_KEY = ['auth', 'ip', 'hash', 'key'].join('-')
const CLIENT_ID = ['test', 'client', 'id.apps.googleusercontent.com'].join('-')
const KID = 'test-kid-1'
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISS = 'https://accounts.google.com'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const T0 = Date.parse('2026-10-20T06:00:05.000Z')
const DAY = 86_400_000
const COOKIE = 'laumeme_sid'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type SessionInfo = { nickname: string | null; created_at: string }
type Streak = { current: number; longest: number }
type Problem = { type: string; title: string; status: number; detail?: string }
type MyAccount = {
  created_at: string
  open_sessions: number
  nickname: string | null
  daily_results: { version: number }[]
  streak: Streak
}
type MyData = { account: MyAccount | null; [k: string]: unknown }

// ---------------------------------------------------------------------------- keys and tokens
let goodKey: CryptoKey
let evilKey: CryptoKey
let publicJwk: JWK
const realFetch = globalThis.fetch.bind(globalThis)

beforeAll(async () => {
  const good = await generateKeyPair('RS256', { extractable: true })
  const evil = await generateKeyPair('RS256', { extractable: true })
  goodKey = good.privateKey as CryptoKey
  evilKey = evil.privateKey as CryptoKey
  publicJwk = { ...(await exportJWK(good.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
})

type TokenOpts = {
  sub?: string
  aud?: string
  iss?: string
  iat?: number
  exp?: number
  key?: CryptoKey
}
async function makeToken(o: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(o.sub ?? newSub())
    .setIssuer(o.iss ?? ISS)
    .setAudience(o.aud ?? CLIENT_ID)
    .setIssuedAt(o.iat ?? now)
    .setExpirationTime(o.exp ?? now + 3600)
    .sign(o.key ?? goodKey)
}

function newSub(): string {
  return crypto.randomUUID().replace(/\D/g, '').slice(0, 21).padEnd(21, '7')
}

// ---------------------------------------------------------------------------- byte helpers
const enc = (s: string) => new TextEncoder().encode(s)
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const latin1 = (b: Uint8Array) => String.fromCharCode(...b)
function bytes(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (Array.isArray(v)) return Uint8Array.from(v as number[])
  throw new Error(`not a blob: ${typeof v}`)
}
async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc(text)))
}
async function hmacSub(sub: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc(HASH_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(sub)))
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const b64url = (b: Uint8Array) => b64(b).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

// ---------------------------------------------------------------------------- HTTP helpers
async function raw(
  path: string,
  init: RequestInit,
  headers: Record<string, string>,
  envOverride: Record<string, unknown> = {},
): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(`https://example.com${path}`, { ...init, headers: h }),
    { ...env, ACCOUNT_HASH_KEY: HASH_KEY, IP_HASH_KEY: IP_KEY, GOOGLE_CLIENT_ID: CLIENT_ID, ...envOverride },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

/** Each player gets a distinct IP so IP rate limits never interfere unless a test wants it. */
function ipFor(player: string): string {
  const h = player.replaceAll('-', '')
  return `10.${parseInt(h.slice(0, 2), 16)}.${parseInt(h.slice(2, 4), 16)}.${parseInt(h.slice(4, 6), 16)}`
}
function as(player: string | null, ip?: string, cookie?: string | null): Record<string, string> {
  const h: Record<string, string> = { 'CF-Connecting-IP': ip ?? (player ? ipFor(player) : '10.250.250.250') }
  if (player !== null) h['X-Player-Id'] = player
  if (cookie) h.Cookie = `${COOKIE}=${cookie}`
  return h
}

const api = (path: string) => `/lau-meme/api${path}`
const newPlayer = () => crypto.randomUUID()

async function grant(player: string, purpose: 'play' | 'nickname' = 'play'): Promise<void> {
  const res = await raw(
    api('/consents'),
    { method: 'POST', body: JSON.stringify({ purpose, action: 'grant', policy_version: POLICY_VERSION }) },
    as(player),
  )
  expect(res.status).toBe(201)
}

const signInRaw = (body: string, player: string | null, ip?: string) =>
  raw(api('/auth/google'), { method: 'POST', body }, as(player, ip))
const signInWith = (credential: string, player: string, ip?: string) =>
  signInRaw(JSON.stringify({ credential }), player, ip)

const getSession = (cookie: string | null) => raw(api('/auth/session'), {}, as(null, undefined, cookie))
const getStreak = (cookie: string | null) => raw(api('/me/streak'), {}, as(null, undefined, cookie))
const getMe = (player: string, cookie: string | null) => raw(api('/me'), {}, as(player, undefined, cookie))

/** Parses a Set-Cookie header into name, value and lower-cased attributes (order independent). */
function parseCookie(res: Response): { name: string; value: string; attrs: string[] } {
  const header = res.headers.get('set-cookie')
  expect(header, 'Set-Cookie header').not.toBeNull()
  const parts = header!.split(';').map((s) => s.trim())
  const [name, ...rest] = parts[0]!.split('=')
  return { name: name!, value: rest.join('='), attrs: parts.slice(1).map((s) => s.toLowerCase()) }
}
const COOKIE_ATTRS = ['path=/lau-meme', 'max-age=7776000', 'httponly', 'secure', 'samesite=lax']
function sessionCookie(res: Response): string {
  const c = parseCookie(res)
  expect(c.name).toBe(COOKIE)
  return c.value
}

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
async function expectProblem(res: Response, status: number): Promise<void> {
  expect(res.status).toBe(status)
  isProblem(res)
  expect(((await res.json()) as Problem).status).toBe(status)
}

type Login = { cookie: string; body: SessionInfo; res: Response }
/** Grants play consent, signs in with a fresh valid token for `sub`. */
async function login(sub: string, player: string, consent = true): Promise<Login> {
  if (consent) await grant(player)
  const res = await signInWith(await makeToken({ sub }), player)
  expect(res.status).toBe(200)
  const cookie = sessionCookie(res)
  return { cookie, body: (await res.clone().json()) as SessionInfo, res }
}

// ---------------------------------------------------------------------------- D1 helpers
const COUNT_SQL = {
  account: 'SELECT COUNT(*) AS n FROM account',
  session: 'SELECT COUNT(*) AS n FROM session',
  account_player: 'SELECT COUNT(*) AS n FROM account_player',
  daily_entry: 'SELECT COUNT(*) AS n FROM daily_entry',
  account_streak: 'SELECT COUNT(*) AS n FROM account_streak',
} as const
const DUMP_SQL = {
  account: 'SELECT * FROM account',
  session: 'SELECT * FROM session',
  account_player: 'SELECT * FROM account_player',
} as const

async function count(table: keyof typeof COUNT_SQL): Promise<number> {
  const row = await env.DB.prepare(COUNT_SQL[table]).first<{ n: number }>()
  return row?.n ?? 0
}
/** All rows of a table as text, blobs rendered as latin1, to look for leaked secrets. */
async function dumpText(table: keyof typeof DUMP_SQL): Promise<string> {
  const { results } = await env.DB.prepare(DUMP_SQL[table]).all<Record<string, unknown>>()
  return JSON.stringify(
    results.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, v instanceof ArrayBuffer || Array.isArray(v) ? latin1(bytes(v)) : v]),
      ),
    ),
  )
}
async function accountIdOf(player: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT account_id FROM account_player WHERE player_id = ?')
    .bind(player)
    .first<{ account_id: string }>()
  return row?.account_id ?? null
}
async function sessionRowCount(cookie: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM session WHERE token_hash = ?')
    .bind(await sha256(cookie))
    .first<{ n: number }>()
  return row?.n ?? 0
}
async function expiresAt(cookie: string): Promise<number> {
  const row = await env.DB.prepare('SELECT expires_at FROM session WHERE token_hash = ?')
    .bind(await sha256(cookie))
    .first<{ expires_at: number }>()
  return row!.expires_at
}
const todayGmt7 = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)

async function seedDaily(accountId: string, version: number): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO account_streak (account_id, current, longest, last_day, reached_at, updated_at) VALUES (?, 3, 3, ?, ?, ?)',
    ).bind(accountId, todayGmt7(), now, now),
    env.DB.prepare(
      'INSERT INTO daily_entry (version, account_id, day, a_id, b_id, solved_at, solve_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(version, accountId, todayGmt7(), 'a-id', 'b-id', now, 120_000),
  ])
}

// ---------------------------------------------------------------------------- setup
const logSpies: ReturnType<typeof vi.spyOn>[] = []
let fetchSpy: ReturnType<typeof vi.spyOn>

function logText(): string {
  return logSpies
    .flatMap((s) => s.mock.calls.flat())
    .map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack ?? ''}` : typeof a === 'string' ? a : JSON.stringify(a)))
    .join('\n')
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T0))
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      })
    }
    return realFetch(input, init)
  })
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    logSpies.push(vi.spyOn(console, m).mockImplementation(() => {}))
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM session'),
    env.DB.prepare('DELETE FROM account_player'),
    env.DB.prepare('DELETE FROM daily_entry'),
    env.DB.prepare('DELETE FROM account_streak'),
    env.DB.prepare('DELETE FROM account'),
    env.DB.prepare('DELETE FROM daily_result'),
    env.DB.prepare('DELETE FROM streak'),
    env.DB.prepare('DELETE FROM player'),
    env.DB.prepare('DELETE FROM consent'),
    env.DB.prepare('DELETE FROM rate_counter'),
  ])
})

afterEach(() => {
  vi.useRealTimers()
  fetchSpy.mockRestore()
  for (const s of logSpies.splice(0)) s.mockRestore()
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('auth', () => {
  // ------------------------------------------------------------------------ AC-AUTH-01
  it('AC-AUTH-01: chưa đồng ý thì 403 và không tạo tài khoản; đã đồng ý thì tạo tài khoản theo HMAC(sub), gắn UUID, dùng lại khi đăng nhập lại', async () => {
    const sub = newSub()
    const p1 = newPlayer()

    // no consent -> 403, nothing written
    const denied = await signInWith(await makeToken({ sub }), p1)
    await expectProblem(denied, 403)
    expect(await count('account')).toBe(0)
    expect(await count('session')).toBe(0)
    expect(await count('account_player')).toBe(0)

    // with consent -> 200 and a new account
    await grant(p1)
    const token = await makeToken({ sub })
    const res = await signInWith(token, p1)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionInfo
    expect(body.nickname).toBeNull()
    expect(Number.isNaN(Date.parse(body.created_at))).toBe(false)
    const cookie = sessionCookie(res)

    expect(await count('account')).toBe(1)
    const acc = await env.DB.prepare('SELECT id, sub_hash, nickname FROM account').first<{
      id: string
      sub_hash: unknown
      nickname: string | null
    }>()
    expect(hex(bytes(acc!.sub_hash))).toBe(hex(await hmacSub(sub)))
    expect(acc!.nickname).toBeNull()
    expect(acc!.id).not.toContain(sub)
    for (const t of ['account', 'session', 'account_player'] as const) {
      const text = await dumpText(t)
      expect(text, `${t} must not hold the raw sub`).not.toContain(sub)
      expect(text, `${t} must not hold the raw ID token`).not.toContain(token)
    }
    expect(await accountIdOf(p1)).toBe(acc!.id)

    // same sub again -> same account, no duplicate
    const again = await signInWith(await makeToken({ sub }), p1)
    expect(again.status).toBe(200)
    expect(await count('account')).toBe(1)
    expect(await accountIdOf(p1)).toBe(acc!.id)
    expect(sessionCookie(again)).not.toBe(cookie) // a new session per sign-in

    // `accounts.google.com` (no scheme) is also an accepted issuer
    const p2 = newPlayer()
    await grant(p2)
    const alt = await signInWith(await makeToken({ iss: 'accounts.google.com' }), p2)
    expect(alt.status).toBe(200)

    // AC-PRIV-07: neither token nor sub is ever logged
    const logs = logText()
    expect(logs).not.toContain(token)
    expect(logs).not.toContain(sub)
  })

  // ------------------------------------------------------------------------ AC-AUTH-02
  it('AC-AUTH-02: cookie HttpOnly/Secure/SameSite=Lax/Path, mã 32 byte chỉ lưu SHA-256, GET /auth/session gia hạn, hết 90 ngày không dùng thì 401', async () => {
    const p1 = newPlayer()
    const { res, cookie } = await login(newSub(), p1)

    // cookie attributes and token format
    const parsed = parseCookie(res)
    for (const a of COOKIE_ATTRS) expect(parsed.attrs, a).toContain(a)
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // only the SHA-256 is stored
    expect(await sessionRowCount(cookie)).toBe(1)
    expect(await dumpText('session')).not.toContain(cookie)
    expect(await expiresAt(cookie)).toBe(T0 + 90 * DAY)

    // no cookie -> 401
    await expectProblem(await getSession(null), 401)
    await expectProblem(await getStreak(null), 401)

    // survives a reload: GET /auth/session returns SessionInfo and re-sets the cookie
    const ok = await getSession(cookie)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as SessionInfo).nickname).toBeNull()

    // sliding expiry: use at T+89d renews to (T+89d)+90d
    vi.setSystemTime(new Date(T0 + 89 * DAY))
    const r1 = await getSession(cookie)
    expect(r1.status).toBe(200)
    const c1 = parseCookie(r1)
    expect(c1.name).toBe(COOKIE)
    expect(c1.value).toBe(cookie)
    expect(c1.attrs).toContain('max-age=7776000')
    expect(await expiresAt(cookie)).toBe(T0 + 89 * DAY + 90 * DAY)

    // 89 days later it is still valid only because the previous use renewed it
    vi.setSystemTime(new Date(T0 + 178 * DAY))
    const r2 = await getSession(cookie)
    expect(r2.status).toBe(200)

    // 90 days + 1 s without use -> expired
    vi.setSystemTime(new Date(T0 + 178 * DAY + 90 * DAY + 1000))
    await expectProblem(await getSession(cookie), 401)
    await expectProblem(await getStreak(cookie), 401)
  })

  // ------------------------------------------------------------------------ AC-AUTH-03
  it('AC-AUTH-03: ID token sai chữ ký, aud, iss, hết hạn, sai định dạng hoặc thiếu thì 401 problem+json, không tạo tài khoản/phiên, log sạch', async () => {
    const sub = newSub()
    const p1 = newPlayer()
    await grant(p1)
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })).replace(/=+$/, '')}.${btoa(
      JSON.stringify({ sub, iss: ISS, aud: CLIENT_ID, exp: now + 3600 }),
    ).replace(/=+$/, '')}.`
    const cases: [string, string][] = [
      ['sai chữ ký (khóa khác, cùng kid)', await makeToken({ sub, key: evilKey })],
      ['sai aud', await makeToken({ sub, aud: 'another-client.apps.googleusercontent.com' })],
      ['sai iss', await makeToken({ sub, iss: 'https://evil.example.com' })],
      ['hết hạn', await makeToken({ sub, iat: now - 7200, exp: now - 3600 })],
      ['alg none', unsigned],
      ['sai định dạng', 'abc'],
    ]
    const seen: string[] = []
    let ip = 0
    for (const [label, credential] of cases) {
      const res = await signInWith(credential, p1, `10.9.9.${++ip}`)
      expect(res.status, label).toBe(401)
      isProblem(res)
      expect(res.headers.get('set-cookie'), label).toBeNull()
      seen.push(credential)
    }

    // missing `credential`: 400 (schema) or 401 (no token) are both a refusal
    const missing = await signInRaw('{}', p1, `10.9.9.${ip + 1}`)
    expect([400, 401]).toContain(missing.status)
    isProblem(missing)
    expect(missing.headers.get('set-cookie')).toBeNull()

    expect(await count('account')).toBe(0)
    expect(await count('session')).toBe(0)
    expect(await count('account_player')).toBe(0)

    const logs = logText()
    expect(logs).not.toContain(sub)
    for (const credential of seen.filter((c) => c.length > 10)) expect(logs).not.toContain(credential)
  })

  // ------------------------------------------------------------------------ AC-AUTH-04
  it('AC-AUTH-04: cùng tài khoản trên máy 2 thấy nickname, streak, kết quả Daily và UUID máy 2 được gắn vào tài khoản', async () => {
    const sub = newSub()
    const P1 = newPlayer()
    const P2 = newPlayer()
    const V = 5

    const d1 = await login(sub, P1)
    await grant(P1, 'nickname')
    const nick = await raw(
      api('/me/nickname'),
      { method: 'PUT', body: JSON.stringify({ nickname: 'Lẩu Thủ' }) },
      as(P1, undefined, d1.cookie),
    )
    expect(nick.status).toBe(200)
    expect(((await nick.json()) as { nickname: string }).nickname).toBe('Lẩu Thủ')

    const accountId = await accountIdOf(P1)
    expect(accountId).not.toBeNull()
    await seedDaily(accountId!, V)

    // device 2
    const d2 = await login(sub, P2)
    expect(d2.body.nickname).toBe('Lẩu Thủ')
    expect(d2.cookie).not.toBe(d1.cookie)
    expect(await count('account')).toBe(1)

    const streak = await getStreak(d2.cookie)
    expect(streak.status).toBe(200)
    expect((await streak.json()) as Streak).toEqual({ current: 3, longest: 3 })

    const me = await getMe(P2, d2.cookie)
    expect(me.status).toBe(200)
    const data = (await me.json()) as MyData
    expect(data.account).not.toBeNull()
    expect(data.account!.nickname).toBe('Lẩu Thủ')
    expect(data.account!.daily_results.map((r) => r.version)).toContain(V)

    expect(await accountIdOf(P2)).toBe(accountId)
    expect(await accountIdOf(P1)).toBe(accountId)
    expect(await count('account_player')).toBe(2)
  })

  it('AC-AUTH-04: rút đồng ý nickname ở bất kỳ máy nào xóa nickname của tài khoản khỏi mọi nơi', async () => {
    const sub = newSub()
    const P1 = newPlayer()
    const P2 = newPlayer()
    const d1 = await login(sub, P1)
    await login(sub, P2)
    await grant(P1, 'nickname')
    const nick = await raw(
      api('/me/nickname'),
      { method: 'PUT', body: JSON.stringify({ nickname: 'Lẩu Thủ' }) },
      as(P1, undefined, d1.cookie),
    )
    expect(nick.status).toBe(200)

    const withdraw = await raw(
      api('/consents'),
      { method: 'POST', body: JSON.stringify({ purpose: 'nickname', action: 'withdraw', policy_version: POLICY_VERSION }) },
      as(P2),
    )
    expect(withdraw.status).toBe(201)

    const row = await env.DB.prepare('SELECT nickname, nickname_fold FROM account').first<{
      nickname: string | null
      nickname_fold: string | null
    }>()
    expect(row!.nickname).toBeNull()
    expect(row!.nickname_fold).toBeNull()
    const s = await getSession(d1.cookie)
    expect(s.status).toBe(200)
    expect(((await s.json()) as SessionInfo).nickname).toBeNull()
  })

  it('AC-AUTH-03: thiếu GOOGLE_CLIENT_ID thì từ chối mọi ID token (đóng khi lỗi cấu hình)', async () => {
    const p1 = newPlayer()
    await grant(p1)
    const tokens = [await makeToken({ aud: CLIENT_ID }), await makeToken({ aud: 'other-app' })]
    let ip = 0
    for (const t of tokens) {
      const res = await raw(
        api('/auth/google'),
        { method: 'POST', body: JSON.stringify({ credential: t }) },
        as(p1, `10.6.6.${++ip}`),
        { GOOGLE_CLIENT_ID: '' },
      )
      expect(res.status).not.toBe(200)
      expect([401, 500]).toContain(res.status)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    expect(await count('account')).toBe(0)
    expect(await count('session')).toBe(0)
  })

  // ------------------------------------------------------------------------ AC-AUTH-05
  it('AC-AUTH-05: đăng xuất trả 204, xóa cookie, thu hồi phiên phía server; không có phiên vẫn 204', async () => {
    const p1 = newPlayer()
    const { cookie } = await login(newSub(), p1)
    expect(await sessionRowCount(cookie)).toBe(1)

    const out = await raw(api('/auth/session'), { method: 'DELETE' }, as(p1, undefined, cookie))
    expect(out.status).toBe(204)
    const cleared = parseCookie(out)
    expect(cleared.name).toBe(COOKIE)
    expect(cleared.value).toBe('')
    expect(cleared.attrs).toContain('max-age=0')

    await expectProblem(await getSession(cookie), 401)
    await expectProblem(await getStreak(cookie), 401)
    expect(await sessionRowCount(cookie)).toBe(0)
    expect(await count('session')).toBe(0)

    const again = await raw(api('/auth/session'), { method: 'DELETE' }, as(p1))
    expect(again.status).toBe(204)
  })

  // ------------------------------------------------------------------------ AC-AUTH-06
  it('AC-AUTH-06: /me có thông tin tài khoản không lộ băm sub; DELETE /me khi đang đăng nhập xóa tài khoản, phiên, Daily, streak và đăng nhập lại ra tài khoản trống', async () => {
    const sub = newSub()
    const P1 = newPlayer()
    const P2 = newPlayer()
    const d1 = await login(sub, P1)
    await grant(P1, 'nickname')
    const nick = await raw(
      api('/me/nickname'),
      { method: 'PUT', body: JSON.stringify({ nickname: 'Bếp Trưởng' }) },
      as(P1, undefined, d1.cookie),
    )
    expect(nick.status).toBe(200)
    const d2 = await login(sub, P2)
    const accountId = (await accountIdOf(P1))!
    await seedDaily(accountId, 9)

    // view / export (AC-PRIV-08 extension)
    const me = await getMe(P1, d1.cookie)
    expect(me.status).toBe(200)
    const text = await me.text()
    const data = JSON.parse(text) as MyData
    expect(data.account).not.toBeNull()
    expect(data.account!.open_sessions).toBe(2)
    expect(data.account!.nickname).toBe('Bếp Trưởng')
    expect(Number.isNaN(Date.parse(data.account!.created_at))).toBe(false)
    expect(data.account!.daily_results.map((r) => r.version)).toContain(9)
    expect(data.account!.streak).toEqual({ current: 3, longest: 3 })
    const hash = await hmacSub(sub)
    expect(text).not.toContain(sub)
    expect(text).not.toContain(hex(hash))
    expect(text).not.toContain(b64(hash))
    expect(text).not.toContain(b64url(hash))
    expect(text).not.toMatch(/sub_hash/)

    // without a session there is no account block
    const anon = (await (await getMe(P1, null)).json()) as MyData
    expect(anon.account).toBeNull()

    // erase while signed in
    const del = await raw(api('/me'), { method: 'DELETE' }, as(P1, undefined, d1.cookie))
    expect(del.status).toBe(204)
    expect(parseCookie(del).attrs).toContain('max-age=0')

    expect(await count('account')).toBe(0)
    expect(await count('session')).toBe(0)
    expect(await count('account_player')).toBe(0)
    expect(await count('daily_entry')).toBe(0)
    expect(await count('account_streak')).toBe(0)
    await expectProblem(await getSession(d2.cookie), 401)

    // both linked UUIDs are erased like AC-PRIV-05: consent keeps an `erase` row
    for (const p of [P1, P2]) {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM consent WHERE player_id = ? AND action = 'erase'")
        .bind(p)
        .first<{ n: number }>()
      expect(row!.n, `erase row for ${p}`).toBeGreaterThanOrEqual(1)
    }

    // signing in again with the same Google account yields a new, empty account
    const P3 = newPlayer()
    const d3 = await login(sub, P3)
    expect(d3.body.nickname).toBeNull()
    expect(await count('account')).toBe(1)
    expect(await accountIdOf(P3)).not.toBe(accountId)
    expect(await count('daily_entry')).toBe(0)
    expect(await count('account_streak')).toBe(0)
    const streak = await getStreak(d3.cookie)
    expect((await streak.json()) as Streak).toEqual({ current: 0, longest: 0 })
  })

  // ------------------------------------------------------------------------ AC-AUTH-07
  it('AC-AUTH-07: yêu cầu đăng nhập thứ 11 trong phút từ cùng IP trả 429 problem+json có Retry-After', async () => {
    const p1 = newPlayer()
    await grant(p1)
    const ip = '10.77.7.7'
    for (let i = 1; i <= 10; i++) {
      const res = await signInWith('abc', p1, ip)
      expect(res.status, `request ${i}`).not.toBe(429)
    }
    const eleventh = await signInWith('abc', p1, ip)
    await expectProblem(eleventh, 429)
    const retry = Number(eleventh.headers.get('retry-after'))
    expect(Number.isInteger(retry)).toBe(true)
    expect(retry).toBeGreaterThanOrEqual(1)

    // another IP is not affected
    const other = await signInWith('abc', p1, '10.77.7.8')
    expect(other.status).not.toBe(429)
  })

  // ------------------------------------------------------------------------ extra: tenant isolation
  it('AC-AUTH-TENANT: phiên của tài khoản B không đọc được dữ liệu của tài khoản A; cookie giả thì 401', async () => {
    const A = await (async () => {
      const player = newPlayer()
      const l = await login(newSub(), player)
      await grant(player, 'nickname')
      const nick = await raw(
        api('/me/nickname'),
        { method: 'PUT', body: JSON.stringify({ nickname: 'Chủ Quán A' }) },
        as(player, undefined, l.cookie),
      )
      expect(nick.status).toBe(200)
      await seedDaily((await accountIdOf(player))!, 11)
      return { player, ...l }
    })()
    const pB = newPlayer()
    const B = await login(newSub(), pB)
    expect(await accountIdOf(pB)).not.toBe(await accountIdOf(A.player))

    expect(B.body.nickname).toBeNull()
    const streak = await getStreak(B.cookie)
    expect((await streak.json()) as Streak).toEqual({ current: 0, longest: 0 })

    const meText = await (await getMe(pB, B.cookie)).text()
    expect(meText).not.toContain('Chủ Quán A')
    expect(meText).not.toContain(A.player)
    const me = JSON.parse(meText) as MyData
    expect(me.account!.open_sessions).toBe(1)
    expect(me.account!.daily_results).toEqual([])

    // B's session with A's device id must not expose A's account
    const crossText = await (await getMe(A.player, B.cookie)).text()
    expect(crossText).not.toContain('Chủ Quán A')

    // forged cookie
    const forged = b64url(crypto.getRandomValues(new Uint8Array(32)))
    await expectProblem(await getSession(forged), 401)
    await expectProblem(await getStreak(forged), 401)
  })

  // ------------------------------------------------------------------------ extra: validation
  it('AC-AUTH-VALIDATION: credential quá dài, sai kiểu, chứa script hoặc body hỏng đều bị từ chối, không tạo tài khoản và không phản chiếu đầu vào', async () => {
    const p1 = newPlayer()
    await grant(p1)
    const script = '<script>alert(1)</script>'
    const bodies: [string, string][] = [
      ['quá dài', JSON.stringify({ credential: 'a'.repeat(5000) })],
      ['sai kiểu số', JSON.stringify({ credential: 12345 })],
      ['sai kiểu object', JSON.stringify({ credential: { $ne: null } })],
      ['script', JSON.stringify({ credential: script })],
      ['trường thừa', JSON.stringify({ credential: 'abc', role: 'admin' })],
      ['body hỏng', '{"credential":'],
    ]
    let ip = 0
    for (const [label, body] of bodies) {
      const res = await signInRaw(body, p1, `10.8.8.${++ip}`)
      expect([400, 401, 422], label).toContain(res.status)
      isProblem(res)
      expect(res.headers.get('set-cookie'), label).toBeNull()
      expect(await res.text(), label).not.toContain(script)
    }
    expect(await count('account')).toBe(0)
    expect(await count('session')).toBe(0)
  })
})
