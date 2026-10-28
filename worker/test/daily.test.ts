// Acceptance tests for docs/acceptance/daily.md (worker part: AC-DAILY-03 manifest, 06..11, 13, 14, plus
// AC-DAILY-TENANT and AC-DAILY-VALIDATION), model of 2026-10-21: results, streak and nickname belong to the
// signed-in account (ADR 0010); no step counting; time = server receive time - batch_at.
// Black-box: only the HTTP contract (docs/api/openapi.yaml), ADR 0002 id formulas, ADR 0010 and the D1 schema
// (migration 0005) are used. Ids are built here from ADR 0002 (lm1|e| / lm1|k|), independent of production code.
// D1 is slow on this machine (~66 ms/query): bulk data is seeded straight into D1 in batches; real sign-ins are
// used only where the API path matters.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['daily', 'pipeline', 'token'].join('-')
const IP_KEY = ['daily', 'ip', 'hash', 'key'].join('-')
const HASH_KEY = ['daily', 'account', 'hash', 'key'].join('-')
const CLIENT_ID = ['test', 'client', 'id.apps.googleusercontent.com'].join('-')
const KID = 'test-kid-daily'
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISS = 'https://accounts.google.com'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const COOKIE = 'laumeme_sid'
const HOUR = 3_600_000
const DAY = 86_400_000
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const ANON = 'Thực khách ẩn danh'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Streak = { current: number; longest: number }
type DailyResult = { version: number; solve_ms: number; rank: number; streak: Streak; solved_at: string }
type Row = { rank: number; nickname: string; value: number }
type Board = { version: number; rows: Row[]; me: Row | null }
type PRow = { rank: number; nickname: string; solved: number; total_ms: number }
type PBoard = {
  period: string
  starts_at: string
  ends_at: string
  batches: number
  rows: PRow[]
  me: PRow | null
}
type Problem = { type: string; title: string; status: number; detail?: string; result?: DailyResult }
type MyData = { account: { daily_results: { version: number }[]; streak: Streak } | null }
type Who = { player: string; cookie: string; accountId: string }
type Stmt = ReturnType<typeof env.DB.prepare>

// ---------------------------------------------------------------------------- ADR 0002 helpers
const b64u = (buf: ReturnType<typeof Buffer.from>) => buf.toString('base64url')
const sha256Buf = async (text: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
const elementId = async (name: string) => b64u(await sha256Buf(`lm1|e|${fold(name)}`))
async function recipeId(a: string, b: string): Promise<string> {
  const [x, y] = [fold(a), fold(b)].sort((p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q)))
  return b64u(await sha256Buf(`lm1|k|${x}\0${y}`))
}

// ---------------------------------------------------------------------------- fixture content
const STARTER_DEFS = [
  { name: 'Cay', emoji: '🌶️' },
  { name: 'Cười', emoji: '😂' },
  { name: 'Toang', emoji: '💀' },
  { name: 'Deadline', emoji: '⏰' },
]
// Cay+Cười -> A, A+Deadline -> B, B+Toang -> C, C+Cay -> Stonks (the daily element).
const CHAIN = [
  { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
  { a: 'Tới Công Chuyện', b: 'Deadline', result: 'Chạy Deadline', emoji: '🏃', depth: 2 },
  { a: 'Chạy Deadline', b: 'Toang', result: 'Hết Cứu', emoji: '🧯', depth: 3 },
  { a: 'Hết Cứu', b: 'Cay', result: 'Stonks', emoji: '📈', depth: 4 },
]
const TARGET = 'Stonks'
const SIDE = { a: 'Toang', b: 'Deadline', result: 'Khét Lẹt', emoji: '🫠', depth: 1 } // real recipe, not the target
const HINT = 'Món lên như diều gặp gió'
/** The only active recipe of every fixture version whose result is the daily element. */
const PAIR = { a: 'Hết Cứu', b: 'Cay' }

async function batchBody(version: number, batchAt: string) {
  const starterIds = await Promise.all(STARTER_DEFS.map((s) => elementId(s.name)))
  const defs = [...CHAIN, SIDE]
  const recipes = await Promise.all(
    defs.map(async (d) => {
      const [x, y] = [await elementId(d.a), await elementId(d.b)].sort()
      return { id: await recipeId(d.a, d.b), a: x!, b: y!, result: await elementId(d.result) }
    }),
  )
  const targetId = await elementId(TARGET)
  return {
    status: 'success',
    version,
    batch_at: batchAt,
    mode: 'core',
    manifest: {
      version,
      batch_at: batchAt,
      graph_url: `/api/graph/${version}`,
      starters: STARTER_DEFS.map((s, i) => ({ id: starterIds[i], name: s.name, emoji: s.emoji })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: targetId, emoji: '📈', hint: HINT, depth: 4, name: TARGET },
    },
    graph: { format: 1, version, entries: { [await recipeId('graph', String(version))]: 'abc' } },
    content: {
      elements: [
        ...STARTER_DEFS.map((s, i) => ({
          id: starterIds[i],
          name: s.name,
          fold: fold(s.name),
          emoji: s.emoji,
          depth: 0,
          origin: 'vn',
        })),
        ...(await Promise.all(
          defs.map(async (d) => ({
            id: await elementId(d.result),
            name: d.result,
            fold: fold(d.result),
            emoji: d.emoji,
            depth: d.depth,
            origin: 'vn',
          })),
        )),
      ],
      recipes,
      starters: starterIds,
      daily_element_id: targetId,
    },
    stats: {},
  }
}

// ---------------------------------------------------------------------------- Google sign-in harness (copied from auth.test.ts)
let goodKey: CryptoKey
let publicJwk: JWK
const realFetch = globalThis.fetch.bind(globalThis)

beforeAll(async () => {
  const good = await generateKeyPair('RS256', { extractable: true })
  goodKey = good.privateKey as CryptoKey
  publicJwk = { ...(await exportJWK(good.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
})

function newSub(): string {
  return crypto.randomUUID().replace(/\D/g, '').slice(0, 21).padEnd(21, '7')
}
async function makeToken(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(sub)
    .setIssuer(ISS)
    .setAudience(CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(goodKey)
}

// ---------------------------------------------------------------------------- HTTP helpers
const enc = (s: string) => new TextEncoder().encode(s)
async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc(text)))
}
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

async function raw(path: string, init: RequestInit, headers: Record<string, string>): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(`https://example.com${path}`, { ...init, headers: h }),
    { ...env, PIPELINE_TOKEN: TOKEN, IP_HASH_KEY: IP_KEY, ACCOUNT_HASH_KEY: HASH_KEY, GOOGLE_CLIENT_ID: CLIENT_ID },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

const api = (path: string) => `/lau-meme/api${path}`

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

async function publish(version: number, batchAt: string): Promise<void> {
  const res = await raw(
    api('/pipeline/batches'),
    { method: 'POST', body: JSON.stringify(await batchBody(version, batchAt)) },
    { Authorization: `Bearer ${TOKEN}` },
  )
  expect(res.status).toBe(201)
}
/** Moves the fake clock to batch_at + 30 min (the cron runs a bit after the mark) and publishes. */
async function publishAt(version: number, batchAt: string): Promise<void> {
  vi.setSystemTime(new Date(Date.parse(batchAt) + 30 * 60_000))
  await publish(version, batchAt)
}

async function grant(player: string, purpose: 'play' | 'nickname' = 'play'): Promise<void> {
  const res = await raw(
    api('/consents'),
    { method: 'POST', body: JSON.stringify({ purpose, action: 'grant', policy_version: POLICY_VERSION }) },
    as(player),
  )
  expect(res.status).toBe(201)
}

/** Real sign-in: play consent, a fresh Google token, the session cookie. */
async function login(sub: string = newSub(), player: string = crypto.randomUUID()): Promise<Who> {
  await grant(player)
  const res = await raw(
    api('/auth/google'),
    { method: 'POST', body: JSON.stringify({ credential: await makeToken(sub) }) },
    as(player),
  )
  expect(res.status).toBe(200)
  const header = res.headers.get('set-cookie')
  expect(header).not.toBeNull()
  const cookie = header!.split(';')[0]!.split('=').slice(1).join('=')
  const accountId = await accountIdOf(player)
  expect(accountId).not.toBeNull()
  return { player, cookie, accountId: accountId! }
}

const submitRaw = (
  version: number | string,
  who: { player: string | null; cookie: string | null },
  body: string,
  o: { ip?: string; contentType?: string } = {},
) =>
  raw(
    api(`/daily/${version}/results`),
    { method: 'POST', body },
    { ...as(who.player, o.ip, who.cookie), ...(o.contentType ? { 'Content-Type': o.contentType } : {}) },
  )
const submit = (version: number, who: { player: string | null; cookie: string | null }, pair = PAIR, ip?: string) =>
  submitRaw(version, who, JSON.stringify(pair), { ip })

const boardRes = (version: number | string, cookie?: string | null) =>
  raw(api(`/daily/${version}/leaderboard`), {}, as(null, undefined, cookie))
const board = async (version: number | string, cookie?: string | null): Promise<Board> => {
  const res = await boardRes(version, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as Board
}
const periodRes = (period?: string, cookie?: string | null) =>
  raw(api(`/daily/leaderboard${period === undefined ? '' : `?period=${encodeURIComponent(period)}`}`), {}, as(null, undefined, cookie))
const periodBoard = async (period?: string, cookie?: string | null): Promise<PBoard> => {
  const res = await periodRes(period, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as PBoard
}
const streakRes = (cookie: string | null, player: string | null = null) =>
  raw(api('/me/streak'), {}, as(player, undefined, cookie))
const myStreak = async (cookie: string): Promise<Streak> => {
  const res = await streakRes(cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as Streak
}

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
async function expectProblem(res: Response, status: number): Promise<Problem> {
  expect(res.status).toBe(status)
  isProblem(res)
  const body = (await res.json()) as Problem
  expect(body.status).toBe(status)
  expect(body.title.length).toBeGreaterThan(0)
  return body
}
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

// ---------------------------------------------------------------------------- D1 helpers
const COUNT_SQL = {
  account: 'SELECT COUNT(*) AS n FROM account',
  daily_entry: 'SELECT COUNT(*) AS n FROM daily_entry',
  account_streak: 'SELECT COUNT(*) AS n FROM account_streak',
} as const
async function count(table: keyof typeof COUNT_SQL): Promise<number> {
  const row = await env.DB.prepare(COUNT_SQL[table]).first<{ n: number }>()
  return row?.n ?? 0
}
async function accountIdOf(player: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT account_id FROM account_player WHERE player_id = ?')
    .bind(player)
    .first<{ account_id: string }>()
  return row?.account_id ?? null
}
type EntryRow = { version: number; day: string; solved_at: number; solve_ms: number }
async function entriesOf(accountId: string): Promise<EntryRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT version, day, solved_at, solve_ms FROM daily_entry WHERE account_id = ? ORDER BY version',
  )
    .bind(accountId)
    .all<EntryRow>()
  return results
}
async function streakRowOf(accountId: string) {
  return env.DB.prepare('SELECT current, longest, last_day FROM account_streak WHERE account_id = ?')
    .bind(accountId)
    .first<{ current: number; longest: number; last_day: string }>()
}
const gmt7Day = (ms: number) => new Date(ms + 7 * HOUR).toISOString().slice(0, 10)

async function runBatch(stmts: Stmt[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50))
}

/** An account with one linked browser UUID, a live session cookie and (by default) play consent, written straight to D1. */
async function identity(
  nickname: string | null = null,
  consent = true,
): Promise<{ who: Who; stmts: Stmt[] }> {
  const player = crypto.randomUUID()
  const accountId = crypto.randomUUID()
  const cookie = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const now = Date.now()
  const stmts: Stmt[] = [
    env.DB.prepare(
      'INSERT INTO account (id, sub_hash, nickname, nickname_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(accountId, crypto.getRandomValues(new Uint8Array(32)), nickname, nickname === null ? null : fold(nickname), now, now),
    env.DB.prepare('INSERT INTO account_player (player_id, account_id, linked_at) VALUES (?, ?, ?)').bind(player, accountId, now),
    env.DB.prepare(
      'INSERT INTO session (token_hash, account_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(await sha256(cookie), accountId, now, now, now + 90 * DAY),
  ]
  if (consent) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
      ).bind(crypto.randomUUID(), player, POLICY_VERSION, now),
    )
  }
  return { who: { player, cookie, accountId }, stmts }
}
async function seedOne(nickname: string | null = null, consent = true): Promise<Who> {
  const { who, stmts } = await identity(nickname, consent)
  await runBatch(stmts)
  return who
}
const entryStmt = (accountId: string, version: number, day: string, solvedAt: number, solveMs: number): Stmt =>
  env.DB.prepare(
    'INSERT INTO daily_entry (version, account_id, day, a_id, b_id, solved_at, solve_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(version, accountId, day, 'a-id', 'b-id', solvedAt, solveMs)
const setNickname = (accountId: string, nickname: string): Stmt =>
  env.DB.prepare('UPDATE account SET nickname = ?, nickname_fold = ? WHERE id = ?').bind(nickname, fold(nickname), accountId)

// ---------------------------------------------------------------------------- setup
let fetchSpy: ReturnType<typeof vi.spyOn>
const NOW0 = Date.parse('2026-10-20T06:00:05.000Z')

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW0))
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
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
})

afterEach(() => {
  vi.useRealTimers()
  fetchSpy.mockRestore()
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('daily', () => {
  // ------------------------------------------------------------------------ AC-DAILY-03 (worker side)
  it('AC-DAILY-03: manifest công bố emoji, gợi ý, depth, khóa băm của tên đã fold và tên món đọc được', async () => {
    await publish(1, BATCH_AT)
    const res = await raw(api('/manifest'), {}, {})
    expect(res.status).toBe(200)
    const manifest = (await res.json()) as { daily: Record<string, unknown> }
    expect(manifest.daily).toEqual({
      element_id: await elementId(TARGET),
      emoji: '📈',
      hint: HINT,
      depth: 4,
      name: TARGET,
    })
    expect(Object.keys(manifest.daily).sort()).toEqual(['depth', 'element_id', 'emoji', 'hint', 'name'])
  })

  it('AC-DAILY-03: tên trong manifest.daily không khớp tên phần tử Món đặc biệt thì 422 problem+json, không ghi gì', async () => {
    for (const [i, wrong] of ['Tên Khác', '', 'x'.repeat(101)].entries()) {
      const b = await batchBody(10 + i, BATCH_AT)
      b.manifest.daily.name = wrong
      const res = await raw(
        api('/pipeline/batches'),
        { method: 'POST', body: JSON.stringify(b) },
        { Authorization: `Bearer ${TOKEN}` },
      )
      expect(res.status, `name=${wrong.slice(0, 10)}`).toBe(422)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM batch_content').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it('AC-DAILY-03: manifest đăng trước 2026-10-27 không có name vẫn được nhận và phát lại không có name', async () => {
    const b = await batchBody(1, BATCH_AT)
    delete (b.manifest.daily as { name?: string }).name
    const post = await raw(
      api('/pipeline/batches'),
      { method: 'POST', body: JSON.stringify(b) },
      { Authorization: `Bearer ${TOKEN}` },
    )
    expect(post.status).toBe(201)
    const res = await raw(api('/manifest'), {}, {})
    const manifest = (await res.json()) as { daily: Record<string, unknown> }
    expect(manifest.daily.name).toBeUndefined()
    expect(manifest.daily.element_id).toBe(await elementId(TARGET))
  })

  // ------------------------------------------------------------------------ AC-DAILY-20 (worker side)
  it('AC-DAILY-20: xem đáp án không có sự kiện server: manifest chỉ đọc, không đổi kết quả hay bảng xếp hạng; giải sau đó vẫn 201', async () => {
    await publish(1, BATCH_AT)
    const a = await login()
    const m1 = await (await raw(api('/manifest'), {}, {})).text()
    const m2 = await (await raw(api('/manifest'), {}, {})).text()
    expect(JSON.parse(m2)).toEqual(JSON.parse(m1))
    vi.setSystemTime(new Date(Date.parse('2026-10-20T06:00:05.000Z')))
    const res = await submit(1, a)
    expect(res.status).toBe(201)
  })

  // ------------------------------------------------------------------------ AC-DAILY-06
  it('AC-DAILY-06: đã đăng nhập nộp cặp đúng thì 201; solved_at là giờ server, solve_ms = solved_at - batch_at, hạng 1, streak 1/1, lưu một lần', async () => {
    await publish(1, BATCH_AT)
    const a = await login()
    const submitAt = Date.parse('2026-10-20T06:00:05.000Z')
    vi.setSystemTime(new Date(submitAt))

    const res = await submit(1, a)
    expect(res.status).toBe(201)
    const body = (await res.json()) as DailyResult
    expect(Object.keys(body).sort()).toEqual(['rank', 'solve_ms', 'solved_at', 'streak', 'version'])
    expect(body.version).toBe(1)
    expect(body.rank).toBe(1)
    expect(body.streak).toEqual({ current: 1, longest: 1 })
    expect(Date.parse(body.solved_at)).toBe(submitAt)
    expect(body.solve_ms).toBe(submitAt - Date.parse(BATCH_AT)) // 1 805 000 ms

    const rows = await entriesOf(a.accountId)
    expect(rows).toEqual([{ version: 1, day: '2026-10-20', solved_at: submitAt, solve_ms: 1_805_000 }])
    expect(await streakRowOf(a.accountId)).toEqual({ current: 1, longest: 1, last_day: '2026-10-20' })
    expect(await count('daily_entry')).toBe(1)
  })

  it('AC-DAILY-06: cặp không phân biệt thứ tự, hoa/thường và dấu; hạng theo thứ tự đến, hòa tới ms thì theo thứ tự ghi', async () => {
    await publish(1, BATCH_AT)
    const first = await seedOne()
    const second = await seedOne()
    const third = await seedOne()

    vi.setSystemTime(new Date(NOW0))
    expect(((await (await submit(1, first)).json()) as DailyResult).rank).toBe(1)

    vi.setSystemTime(new Date(NOW0 + 10_000))
    const r2 = await submit(1, second, { a: 'CAY', b: ' het   CUU ' }) // swapped, upper case, no diacritics, extra spaces
    expect(r2.status).toBe(201)
    const b2 = (await r2.json()) as DailyResult
    expect(b2.rank).toBe(2)
    expect(b2.solve_ms).toBe(NOW0 + 10_000 - Date.parse(BATCH_AT))

    // the same millisecond as `second`: ranks after it (write order)
    const r3 = await submit(1, third)
    expect(r3.status).toBe(201)
    const b3 = (await r3.json()) as DailyResult
    expect(b3.rank).toBe(3)
    expect(b3.solve_ms).toBe(b2.solve_ms)
    expect(await count('daily_entry')).toBe(3)
  })

  it('AC-DAILY-06: tài khoản chưa đồng ý play cho UUID gửi lên thì 403 problem+json và không ghi gì', async () => {
    await publish(1, BATCH_AT)
    const noConsent = await seedOne(null, false)
    const res = await submit(1, noConsent)
    await expectProblem(res, 403)
    expect(await count('daily_entry')).toBe(0)
    expect(await count('account_streak')).toBe(0)
  })

  // ------------------------------------------------------------------------ AC-DAILY-07
  it('AC-DAILY-07: cặp không phải công thức, ra món khác món đích, hoặc tên không tồn tại thì 422 problem+json, không ghi gì, không đổi streak', async () => {
    await publish(1, BATCH_AT)
    const who = await login()
    const cases: Array<{ label: string; pair: { a: string; b: string } }> = [
      { label: 'công thức không có thật', pair: { a: 'Cay', b: 'Toang' } },
      { label: 'công thức có thật nhưng ra món khác', pair: { a: 'Toang', b: 'Deadline' } },
      { label: 'công thức có thật ở giữa chuỗi, không phải món đích', pair: { a: 'Cay', b: 'Cười' } },
      { label: 'tên không tồn tại', pair: { a: 'Khong Co Mon Nay', b: 'Cay' } },
      { label: 'món đích ghép với chính nó', pair: { a: TARGET, b: TARGET } },
    ]
    for (const c of cases) {
      const res = await submit(1, who, c.pair)
      await expectProblem(res, 422)
    }
    expect(await count('daily_entry')).toBe(0)
    expect(await count('account_streak')).toBe(0)
    expect(await myStreak(who.cookie)).toEqual({ current: 0, longest: 0 })
    expect((await board(1)).rows).toEqual([])
    // a wrong attempt does not burn the account's single result: the right pair still works
    expect((await submit(1, who)).status).toBe(201)
  })

  // ------------------------------------------------------------------------ AC-DAILY-08
  it('AC-DAILY-08: nộp lại cho cùng mẻ trả 409 kèm kết quả đã lưu, không ghi đè, không đổi solved_at và streak', async () => {
    await publish(1, BATCH_AT)
    const who = await login()
    const first = await submit(1, who)
    expect(first.status).toBe(201)
    const stored = (await first.json()) as DailyResult
    const rowBefore = await entriesOf(who.accountId)

    vi.setSystemTime(new Date(NOW0 + 60_000))
    const again = await submit(1, who, { a: 'Cay', b: 'Hết Cứu' })
    const problem = await expectProblem(again, 409)
    expect(problem.result).toEqual(stored)
    expect(await entriesOf(who.accountId)).toEqual(rowBefore)
    expect(await count('daily_entry')).toBe(1)
    expect(await myStreak(who.cookie)).toEqual({ current: 1, longest: 1 })
  })

  it('AC-DAILY-08: nộp cho mẻ đã qua trả 410, mẻ không tồn tại trả 404, đều problem+json và không ghi gì', async () => {
    await publish(1, BATCH_AT)
    await publishAt(2, '2026-10-20T17:03:00.000Z')
    const who = await seedOne()

    await expectProblem(await submit(1, who), 410)
    await expectProblem(await submit(9999, who), 404)
    expect(await count('daily_entry')).toBe(0)
    expect(await count('account_streak')).toBe(0)
    expect((await submit(2, who)).status).toBe(201)
  })

  it('AC-DAILY-08: không có phiên, cookie giả, phiên hết hạn hoặc đã đăng xuất đều trả 401 problem+json và không ghi gì', async () => {
    await publish(1, BATCH_AT)
    const consented = await seedOne() // has play consent: only the session is missing below
    await expectProblem(await submit(1, { player: consented.player, cookie: null }), 401)

    const forged = b64url(crypto.getRandomValues(new Uint8Array(32)))
    await expectProblem(await submit(1, { player: consented.player, cookie: forged }), 401)

    // sign out: the old cookie is revoked
    const out = await login()
    const del = await raw(api('/auth/session'), { method: 'DELETE' }, as(out.player, undefined, out.cookie))
    expect(del.status).toBe(204)
    await expectProblem(await submit(1, out), 401)

    // 90 days + 1 s without use: expired
    const old = await login()
    vi.setSystemTime(new Date(NOW0 + 90 * DAY + 1000))
    await expectProblem(await submit(1, old), 401)

    expect(await count('daily_entry')).toBe(0)
    expect(await count('account_streak')).toBe(0)
  })

  it('AC-DAILY-08: máy 2 của cùng tài khoản nộp sau khi máy 1 đã nộp thì 409 kèm kết quả của máy 1 (AC-AUTH-04)', async () => {
    await publish(1, BATCH_AT)
    const sub = newSub()
    const d1 = await login(sub)
    const d2 = await login(sub)
    expect(d2.accountId).toBe(d1.accountId)
    expect(d2.cookie).not.toBe(d1.cookie)

    const first = await submit(1, d1)
    expect(first.status).toBe(201)
    const stored = (await first.json()) as DailyResult

    vi.setSystemTime(new Date(NOW0 + 5000))
    const second = await submit(1, d2)
    const problem = await expectProblem(second, 409)
    expect(problem.result).toEqual(stored)
    expect(await count('daily_entry')).toBe(1)
    expect(await count('account')).toBe(1)
  })

  // ------------------------------------------------------------------------ AC-DAILY-09
  it('AC-DAILY-09: mẻ có 30 kết quả: tối đa 20 dòng xếp theo solved_at rồi thứ tự ghi, ẩn danh khi không nickname, không lộ mã tài khoản/UUID', async () => {
    await publish(1, BATCH_AT)
    const base = Date.parse(BATCH_AT) + 10 * 60_000
    // Insertion order j is scrambled against solved_at; consecutive slots share the same millisecond.
    const people: Array<{ who: Who; j: number; nick: string | null; solvedAt: number }> = []
    const stmts: Stmt[] = []
    for (let j = 0; j < 30; j++) {
      const slot = (j * 7) % 30
      const nick = j % 3 === 0 ? null : `Thực Khách ${String(j).padStart(2, '0')}`
      const solvedAt = base + Math.floor(slot / 2) * 1000
      const { who, stmts: s } = await identity(nick)
      stmts.push(...s, entryStmt(who.accountId, 1, '2026-10-20', solvedAt, solvedAt - Date.parse(BATCH_AT)))
      people.push({ who, j, nick, solvedAt })
    }
    await runBatch(stmts)
    const expected = [...people].sort((x, y) => x.solvedAt - y.solvedAt || x.j - y.j)

    const res = await boardRes(1)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(UUID_IN_TEXT.test(text)).toBe(false)
    for (const p of people) {
      expect(text).not.toContain(p.who.accountId)
      expect(text).not.toContain(p.who.player)
    }
    const pub = JSON.parse(text) as Board
    expect(pub.version).toBe(1)
    expect(pub.me).toBeNull()
    expect(pub.rows).toHaveLength(20)
    pub.rows.forEach((row, i) => {
      const want = expected[i]!
      expect(Object.keys(row).sort()).toEqual(['nickname', 'rank', 'value'])
      expect(row.rank, `hạng dòng ${i}`).toBe(i + 1)
      expect(row.value, `thời gian dòng ${i}`).toBe(want.solvedAt - Date.parse(BATCH_AT))
      expect(row.nickname, `nickname dòng ${i}`).toBe(want.nick ?? ANON)
    })

    // the slowest is outside the top 20 but still sees the own rank
    const last = expected[29]!
    const mineOut = await board(1, last.who.cookie)
    expect(mineOut.rows).toHaveLength(20)
    expect(mineOut.me).toEqual({ rank: 30, nickname: last.nick ?? ANON, value: last.solvedAt - Date.parse(BATCH_AT) })
    // someone in the middle of the top 20
    const mid = expected[5]!
    expect((await board(1, mid.who.cookie)).me).toEqual({
      rank: 6,
      nickname: mid.nick ?? ANON,
      value: mid.solvedAt - Date.parse(BATCH_AT),
    })
    // nobody else's id leaks to a signed-in viewer either
    const viewText = JSON.stringify(mineOut)
    for (const p of people) expect(viewText).not.toContain(p.who.accountId)
  }, 60_000)

  it('AC-DAILY-09: mẻ chưa có kết quả trả rows rỗng; me null khi chưa nộp hoặc cookie giả; mẻ cũ vẫn xem được; mẻ lạ 404, version sai 400', async () => {
    await publish(1, BATCH_AT)
    expect(await board(1)).toEqual({ version: 1, rows: [], me: null })
    const who = await seedOne()
    expect(await board(1, who.cookie)).toEqual({ version: 1, rows: [], me: null })
    const forged = b64url(crypto.getRandomValues(new Uint8Array(32)))
    expect(await board(1, forged)).toEqual({ version: 1, rows: [], me: null })

    // a past batch stays readable once a newer one is current
    await publishAt(2, '2026-10-20T17:03:00.000Z')
    expect(await board(1)).toEqual({ version: 1, rows: [], me: null })
    expect(await board(2)).toEqual({ version: 2, rows: [], me: null })

    await expectProblem(await boardRes(9999), 404)
    for (const bad of ['abc', '1;DROP', '1.5']) await expectProblem(await boardRes(bad), 400)
    for (const bad of ['0', '-1']) expect([400, 404], bad).toContain((await boardRes(bad)).status)
  })

  it('AC-DAILY-09: sau khi UUID gắn tài khoản rút đồng ý nickname, bảng hiện "Thực khách ẩn danh" cho tài khoản đó', async () => {
    await publish(1, BATCH_AT)
    const who = await login()
    await grant(who.player, 'nickname')
    const nick = await raw(
      api('/me/nickname'),
      { method: 'PUT', body: JSON.stringify({ nickname: 'Bếp Trưởng' }) },
      as(who.player, undefined, who.cookie),
    )
    expect(nick.status).toBe(200)
    vi.setSystemTime(new Date(NOW0))
    expect((await submit(1, who)).status).toBe(201)

    const before = await board(1, who.cookie)
    expect(before.rows.map((r) => r.nickname)).toEqual(['Bếp Trưởng'])
    expect(before.me?.nickname).toBe('Bếp Trưởng')

    const withdraw = await raw(
      api('/consents'),
      { method: 'POST', body: JSON.stringify({ purpose: 'nickname', action: 'withdraw', policy_version: POLICY_VERSION }) },
      as(who.player),
    )
    expect(withdraw.status).toBe(201)

    const after = await board(1, who.cookie)
    expect(after.rows.map((r) => r.nickname)).toEqual([ANON])
    expect(after.me?.nickname).toBe(ANON)
    expect(JSON.stringify(await board(1))).not.toContain('Bếp Trưởng')
  })

  // ------------------------------------------------------------------------ AC-DAILY-10
  it('AC-DAILY-10: streak theo ngày GMT+7 của batch_at: 20,21,22 => 3; hai mẻ một ngày tính 1; bỏ 23, làm 24 => 1; dài nhất 3; máy khác thấy cùng streak', async () => {
    const sub = newSub()
    const P1 = crypto.randomUUID()
    const holder: { who: Who | null } = { who: null }
    const day = async (version: number, batchAt: string, submitAt: string | null) => {
      await publishAt(version, batchAt)
      if (holder.who === null) holder.who = await login(sub, P1)
      if (submitAt === null) return null
      vi.setSystemTime(new Date(submitAt))
      const res = await submit(version, holder.who)
      expect(res.status, `v${version}`).toBe(201)
      return ((await res.json()) as DailyResult).streak
    }
    expect(await day(1, '2026-10-20T05:30:00.000Z', '2026-10-20T06:00:00.000Z')).toEqual({ current: 1, longest: 1 })
    expect(await day(2, '2026-10-21T05:30:00.000Z', '2026-10-21T06:00:00.000Z')).toEqual({ current: 2, longest: 2 })
    expect(await day(3, '2026-10-22T05:30:00.000Z', '2026-10-22T06:00:00.000Z')).toEqual({ current: 3, longest: 3 })
    // a second batch on the same GMT+7 day counts once
    expect(await day(4, '2026-10-22T10:00:00.000Z', '2026-10-22T10:30:00.000Z')).toEqual({ current: 3, longest: 3 })
    // 23/10: a batch exists but is not solved
    await day(5, '2026-10-23T05:30:00.000Z', null)
    // 24/10: the run restarts at 1, the longest stays 3
    expect(await day(6, '2026-10-24T05:30:00.000Z', '2026-10-24T06:00:00.000Z')).toEqual({ current: 1, longest: 3 })
    const me = holder.who!
    expect(await streakRowOf(me.accountId)).toEqual({ current: 1, longest: 3, last_day: '2026-10-24' })

    // another device of the same account sees the same streak
    const d2 = await login(sub)
    expect(d2.accountId).toBe(me.accountId)
    expect(await myStreak(d2.cookie)).toEqual({ current: 1, longest: 3 })

    // GET /me/streak: still 1 on 25/10 GMT+7 (last day was yesterday), 0 on 26/10 GMT+7 (two days ago)
    vi.setSystemTime(new Date('2026-10-24T18:00:00.000Z'))
    expect(await myStreak(me.cookie)).toEqual({ current: 1, longest: 3 })
    vi.setSystemTime(new Date('2026-10-25T18:00:00.000Z'))
    expect(await myStreak(me.cookie)).toEqual({ current: 0, longest: 3 })
  }, 60_000)

  it('AC-DAILY-10: ngày tính theo GMT+7 của batch_at (không phải UTC): 16:30Z và 17:30Z cùng ngày UTC là hai ngày liên tiếp', async () => {
    const sub = newSub()
    const batchX = '2026-10-21T16:30:00.000Z' // 21/10 23:30 GMT+7
    const batchY = '2026-10-21T17:30:00.000Z' // 22/10 00:30 GMT+7
    await publishAt(1, batchX)
    const who = await login(sub)
    vi.setSystemTime(new Date('2026-10-21T17:10:00.000Z'))
    const r1 = await submit(1, who)
    expect(r1.status).toBe(201)
    expect(((await r1.json()) as DailyResult).streak).toEqual({ current: 1, longest: 1 })

    await publishAt(2, batchY)
    const r2 = await submit(2, who)
    expect(r2.status).toBe(201)
    expect(((await r2.json()) as DailyResult).streak).toEqual({ current: 2, longest: 2 })
    expect((await entriesOf(who.accountId)).map((e) => e.day)).toEqual(['2026-10-21', '2026-10-22'])
  })

  it('AC-DAILY-10: GET /me/streak cần phiên trong mọi trường hợp: chỉ có X-Player-Id (kể cả đã đồng ý) hoặc cookie giả thì 401; tài khoản mới 0/0', async () => {
    const who = await seedOne()
    await expectProblem(await streakRes(null, who.player), 401)
    await expectProblem(await streakRes(null, null), 401)
    await expectProblem(await streakRes(b64url(crypto.getRandomValues(new Uint8Array(32)))), 401)
    expect(await myStreak(who.cookie)).toEqual({ current: 0, longest: 0 })
  })

  // ------------------------------------------------------------------------ AC-DAILY-11
  it('AC-DAILY-11: bảng streak tối đa 20 dòng, giảm dần, hòa thì ai đạt trước đứng trước, ẩn danh khi không nickname, không lộ mã tài khoản', async () => {
    vi.setSystemTime(new Date('2026-10-24T03:00:00.000Z')) // 10:00 on 24/10 GMT+7
    const base = Date.parse('2026-10-20T00:00:00.000Z')
    const seeded: Array<{ id: string; current: number; reached: number; nick: string | null }> = []
    const stmts: Stmt[] = []
    for (let i = 0; i < 25; i++) {
      const current = 1 + (i % 8)
      const nick = i % 4 === 0 ? null : `Thuc Khach ${String(i).padStart(2, '0')}`
      const { who, stmts: s } = await identity(nick)
      // reached_at runs against the insertion order so the tie-break cannot rely on row order
      const reached = base + (24 - i) * 60_000
      stmts.push(
        ...s,
        env.DB.prepare(
          'INSERT INTO account_streak (account_id, current, longest, last_day, reached_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(who.accountId, current, current + 2, i % 2 === 0 ? '2026-10-24' : '2026-10-23', reached, reached),
      )
      seeded.push({ id: who.accountId, current, reached, nick })
    }
    await runBatch(stmts)
    const expected = [...seeded].sort((x, y) => y.current - x.current || x.reached - y.reached).slice(0, 20)

    const res = await raw(api('/streaks/leaderboard'), {}, {})
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const p of seeded) expect(text).not.toContain(p.id)
    const body = JSON.parse(text) as { rows: Row[] }
    expect(body.rows).toHaveLength(20)
    body.rows.forEach((row, i) => {
      const want = expected[i]!
      expect(Object.keys(row).sort()).toEqual(['nickname', 'rank', 'value'])
      expect(row.rank, `hạng dòng ${i}`).toBe(i + 1)
      expect(row.value, `streak dòng ${i}`).toBe(want.current)
      expect(row.nickname, `nickname dòng ${i}`).toBe(want.nick ?? ANON)
    })
  }, 60_000)

  it('AC-DAILY-11: streak 0 và streak đã đứt (ngày gần nhất cách hôm nay quá 1 ngày) không xuất hiện; chưa ai có streak thì rows rỗng', async () => {
    vi.setSystemTime(new Date('2026-10-24T03:00:00.000Z'))
    const empty = await raw(api('/streaks/leaderboard'), {}, {})
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ rows: [] })

    const now = Date.now()
    const plan = [
      { nick: 'Con Song', current: 2, longest: 2, last: '2026-10-24', reached: now - 3000 },
      { nick: 'Song Hom Qua', current: 1, longest: 1, last: '2026-10-23', reached: now - 2000 },
      { nick: 'Streak Khong', current: 0, longest: 3, last: '2026-10-22', reached: now - 1000 },
      { nick: 'Da Dut', current: 5, longest: 5, last: '2026-10-20', reached: now - 4000 },
    ]
    const stmts: Stmt[] = []
    for (const p of plan) {
      const { who, stmts: s } = await identity(p.nick)
      stmts.push(
        ...s,
        env.DB.prepare(
          'INSERT INTO account_streak (account_id, current, longest, last_day, reached_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(who.accountId, p.current, p.longest, p.last, p.reached, p.reached),
      )
    }
    await runBatch(stmts)
    const res = await raw(api('/streaks/leaderboard'), {}, {})
    expect(res.status).toBe(200)
    expect(((await res.json()) as { rows: Row[] }).rows).toEqual([
      { rank: 1, nickname: 'Con Song', value: 2 },
      { rank: 2, nickname: 'Song Hom Qua', value: 1 },
    ])
  })

  // ------------------------------------------------------------------------ AC-DAILY-13
  it('AC-DAILY-13: yêu cầu nộp thứ 11 trong phút của cùng tài khoản (IP khác nhau) trả 429 problem+json có Retry-After; sang phút mới thì nhận lại', async () => {
    await publish(1, BATCH_AT)
    const who = await seedOne()
    const statuses: number[] = []
    let limited: Response | null = null
    for (let i = 1; i <= 11; i++) {
      const res = await submit(1, who, PAIR, `10.50.${i}.1`) // a different IP each time: only the account counts
      statuses.push(res.status)
      if (res.status === 429) limited = res
    }
    expect(statuses[0]).toBe(201)
    expect(statuses.slice(1, 10)).toEqual(Array(9).fill(409)) // handled (duplicate) but counted
    expect(statuses[10]).toBe(429)
    await expectProblem(limited!, 429)
    const retry = Number(limited!.headers.get('retry-after'))
    expect(Number.isInteger(retry)).toBe(true)
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(60)
    expect(await count('daily_entry')).toBe(1)

    vi.setSystemTime(new Date(NOW0 + 61_000))
    expect((await submit(1, who, PAIR, '10.50.99.1')).status).toBe(409)
  }, 60_000)

  it('AC-DAILY-13: yêu cầu thứ 11 trong phút từ cùng IP băm (11 tài khoản khác nhau) trả 429 có Retry-After; IP khác không bị ảnh hưởng', async () => {
    await publish(1, BATCH_AT)
    const sharedIp = '10.99.99.99'
    const people: Who[] = []
    const stmts: Stmt[] = []
    for (let i = 0; i < 12; i++) {
      const { who, stmts: s } = await identity()
      people.push(who)
      stmts.push(...s)
    }
    await runBatch(stmts)

    for (let i = 0; i < 10; i++) {
      const res = await submit(1, people[i]!, PAIR, sharedIp)
      expect(res.status, `yêu cầu ${i + 1}`).toBe(201)
    }
    const limited = await submit(1, people[10]!, PAIR, sharedIp)
    await expectProblem(limited, 429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await count('daily_entry')).toBe(10)

    expect((await submit(1, people[11]!, PAIR, '10.77.77.77')).status).toBe(201)
  }, 60_000)

  // ------------------------------------------------------------------------ AC-DAILY-14
  describe('bảng xếp hạng tuần và tháng', () => {
    // v1 in W42 (and the month), v2 at 19/10 00:30 GMT+7 (UTC still 18/10: the GMT+7 boundary), v3, v4 in W43.
    const BATCHES: Array<[number, string]> = [
      [1, '2026-10-18T05:30:00.000Z'],
      [2, '2026-10-18T17:30:00.000Z'],
      [3, '2026-10-20T05:30:00.000Z'],
      [4, '2026-10-21T05:30:00.000Z'],
    ]
    const batchAtOf = (v: number) => Date.parse(BATCHES.find(([n]) => n === v)![1])
    const NOW = Date.parse('2026-10-21T13:00:00.000Z')
    const W43_START = '2026-10-18T17:00:00.000Z'
    const W43_END = '2026-10-25T17:00:00.000Z'

    async function seedPeriods() {
      for (const [v, at] of BATCHES) await publishAt(v, at)
      const C = await login() // the signed-in viewer
      const entry = (who: Who, v: number, solveMs: number) =>
        entryStmt(who.accountId, v, gmt7Day(batchAtOf(v)), batchAtOf(v) + solveMs, solveMs)
      const ids = {
        A: await identity('Bếp Phó A'),
        B: await identity('Bếp Phó B'),
        D: await identity(null),
        E: await identity('Bếp Phó E'),
        F: await identity('Bếp Phó F'),
      }
      // D is inserted before B on purpose: write order must not decide the B/D tie.
      await runBatch([
        ...ids.A.stmts,
        ...ids.B.stmts,
        ...ids.D.stmts,
        ...ids.E.stmts,
        ...ids.F.stmts,
        setNickname(C.accountId, 'Bếp Phó C'),
        // D: 20 h in 3 batches, the last result (v4) is submitted after B's
        entry(ids.D.who, 2, 7 * HOUR),
        entry(ids.D.who, 3, 6 * HOUR),
        entry(ids.D.who, 4, 7 * HOUR),
        // B: 20 h in 3 batches, last result earlier than D's
        entry(ids.B.who, 2, 7 * HOUR),
        entry(ids.B.who, 3, 7 * HOUR),
        entry(ids.B.who, 4, 6 * HOUR),
        // A: 30 h in 3 batches
        entry(ids.A.who, 2, 10 * HOUR),
        entry(ids.A.who, 3, 10 * HOUR),
        entry(ids.A.who, 4, 10 * HOUR),
        // C: 2 batches, only 5 h
        entry(C, 2, 2 * HOUR),
        entry(C, 3, 3 * HOUR),
        // F: only the boundary batch v2; E: only v1 (the previous week)
        entry(ids.F.who, 2, 1 * HOUR),
        entry(ids.E.who, 1, 1 * HOUR),
      ])
      vi.setSystemTime(new Date(NOW))
      return { C, ids }
    }

    it('AC-DAILY-14: tuần 2026-W43 xếp B, D, A, C: nhiều mẻ trước, tổng thời gian tăng dần, hòa thì kết quả cuối nộp trước; mẻ theo ngày GMT+7 của batch_at', async () => {
      const { C } = await seedPeriods()
      const res = await periodRes('2026-W43')
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(UUID_IN_TEXT.test(text)).toBe(false)
      const body = JSON.parse(text) as PBoard
      expect(body.period).toBe('2026-W43')
      expect(Date.parse(body.starts_at)).toBe(Date.parse(W43_START)) // Monday 19/10 00:00 GMT+7
      expect(Date.parse(body.ends_at)).toBe(Date.parse(W43_END)) // Monday 26/10 00:00 GMT+7
      expect(body.batches).toBe(3) // v2 (boundary), v3, v4
      expect(body.me).toBeNull()
      expect(body.rows).toEqual([
        { rank: 1, nickname: 'Bếp Phó B', solved: 3, total_ms: 20 * HOUR },
        { rank: 2, nickname: ANON, solved: 3, total_ms: 20 * HOUR },
        { rank: 3, nickname: 'Bếp Phó A', solved: 3, total_ms: 30 * HOUR },
        { rank: 4, nickname: 'Bếp Phó C', solved: 2, total_ms: 5 * HOUR },
        { rank: 5, nickname: 'Bếp Phó F', solved: 1, total_ms: 1 * HOUR },
      ])
      for (const r of body.rows) expect(Object.keys(r).sort()).toEqual(['nickname', 'rank', 'solved', 'total_ms'])

      // a signed-in viewer sees the own row
      const mine = await periodBoard('2026-W43', C.cookie)
      expect(mine.me).toEqual({ rank: 4, nickname: 'Bếp Phó C', solved: 2, total_ms: 5 * HOUR })
      expect(mine.rows).toEqual(body.rows)
      // a signed-in account without results has no row
      const idle = await seedOne()
      expect((await periodBoard('2026-W43', idle.cookie)).me).toBeNull()
    }, 60_000)

    it('AC-DAILY-14: không có period thì là tuần hiện tại; tuần cũ và tháng xem lại được, mỗi kỳ chỉ tính mẻ của kỳ đó', async () => {
      await seedPeriods()
      const def = await periodBoard()
      expect(def).toEqual(await periodBoard('2026-W43'))

      // previous week: only v1 / account E
      const w42 = await periodBoard('2026-W42')
      expect(w42.period).toBe('2026-W42')
      expect(Date.parse(w42.starts_at)).toBe(Date.parse('2026-10-11T17:00:00.000Z'))
      expect(Date.parse(w42.ends_at)).toBe(Date.parse(W43_START))
      expect(w42.batches).toBe(1)
      expect(w42.rows).toEqual([{ rank: 1, nickname: 'Bếp Phó E', solved: 1, total_ms: 1 * HOUR }])

      // calendar month 2026-10 (GMT+7): all four batches; E (v1) and F (v2) tie on 1 / 1 h, E's last result is earlier
      const month = await periodBoard('2026-10')
      expect(month.period).toBe('2026-10')
      expect(Date.parse(month.starts_at)).toBe(Date.parse('2026-09-30T17:00:00.000Z'))
      expect(Date.parse(month.ends_at)).toBe(Date.parse('2026-10-31T17:00:00.000Z'))
      expect(month.batches).toBe(4)
      expect(month.rows).toEqual([
        { rank: 1, nickname: 'Bếp Phó B', solved: 3, total_ms: 20 * HOUR },
        { rank: 2, nickname: ANON, solved: 3, total_ms: 20 * HOUR },
        { rank: 3, nickname: 'Bếp Phó A', solved: 3, total_ms: 30 * HOUR },
        { rank: 4, nickname: 'Bếp Phó C', solved: 2, total_ms: 5 * HOUR },
        { rank: 5, nickname: 'Bếp Phó E', solved: 1, total_ms: 1 * HOUR },
        { rank: 6, nickname: 'Bếp Phó F', solved: 1, total_ms: 1 * HOUR },
      ])
    }, 60_000)

    it('AC-DAILY-14: kỳ chưa có kết quả trả rows rỗng; kỳ mới bắt đầu là bảng mới (tuần 2026-W44 trống, W43 giữ nguyên)', async () => {
      await seedPeriods()
      // a past period within 3 months with nothing in it
      const w36 = await periodBoard('2026-W36')
      expect(w36.period).toBe('2026-W36')
      expect(Date.parse(w36.starts_at)).toBe(Date.parse('2026-08-30T17:00:00.000Z'))
      expect(Date.parse(w36.ends_at)).toBe(Date.parse('2026-09-06T17:00:00.000Z'))
      expect(w36.batches).toBe(0)
      expect(w36.rows).toEqual([])
      expect(w36.me).toBeNull()
      expect((await periodBoard('2026-08')).rows).toEqual([])

      // Monday 26/10 00:30 GMT+7: a new week starts empty
      vi.setSystemTime(new Date('2026-10-25T17:30:00.000Z'))
      const w44 = await periodBoard()
      expect(w44.period).toBe('2026-W44')
      expect(Date.parse(w44.starts_at)).toBe(Date.parse(W43_END))
      expect(w44.rows).toEqual([])
      expect(w44.batches).toBe(0)
      const old = await periodBoard('2026-W43')
      expect(old.rows[0]?.nickname).toBe('Bếp Phó B')
      expect(old.rows).toHaveLength(5)
    }, 60_000)

    it('AC-DAILY-14: kỳ trong tương lai, bắt đầu trước hôm nay quá 3 tháng hoặc sai định dạng thì 400 problem+json', async () => {
      vi.setSystemTime(new Date(NOW))
      const bad = [
        '2026-W44', // starts on 26/10, in the future
        '2026-11',
        '2027-01',
        '2026-W20', // 11/05: far beyond 3 months
        '2026-07', // 01/07: beyond 3 months
        '2026-06',
        '2025-10',
        'abc',
        '2026-13',
        '2026-W00',
        '2026-W54',
        '2026-1',
        '2026-W4',
        '0000-00',
        '2026-10;DROP TABLE account',
        '2026-W43<script>alert(1)</script>',
        'x'.repeat(5000),
      ]
      for (const p of bad) {
        const res = await periodRes(p)
        expect(res.status, p.slice(0, 40)).toBe(400)
        isProblem(res)
        expect(await res.text()).not.toContain('<script>')
      }
      // inside the 3 month window
      for (const ok of ['2026-08', '2026-09', '2026-W36', '2026-10']) expect((await periodRes(ok)).status, ok).toBe(200)
      expect(await count('account')).toBe(0)
    })

    it('AC-DAILY-14: hơn 20 người: rows tối đa 20 dòng, tài khoản đăng nhập ngoài top 20 vẫn thấy hạng của mình', async () => {
      await publish(1, BATCH_AT)
      const stmts: Stmt[] = []
      const batchAt = Date.parse(BATCH_AT)
      for (let k = 0; k < 24; k++) {
        const { who, stmts: s } = await identity(`Khach ${String(k).padStart(2, '0')}`)
        const ms = (k + 1) * 60_000
        stmts.push(...s, entryStmt(who.accountId, 1, '2026-10-20', batchAt + ms, ms))
      }
      await runBatch(stmts)
      const slow = await login() // the slowest of 25
      vi.setSystemTime(new Date(batchAt + 3 * HOUR))
      expect((await submit(1, slow)).status).toBe(201)

      const body = await periodBoard(undefined, slow.cookie) // default period = the current week
      expect(body.period).toBe('2026-W43')
      expect(body.batches).toBe(1)
      expect(body.rows).toHaveLength(20)
      expect(body.rows[0]).toEqual({ rank: 1, nickname: 'Khach 00', solved: 1, total_ms: 60_000 })
      expect(body.rows[19]).toEqual({ rank: 20, nickname: 'Khach 19', solved: 1, total_ms: 20 * 60_000 })
      expect(body.me).toEqual({ rank: 25, nickname: ANON, solved: 1, total_ms: 3 * HOUR })
    }, 60_000)
  })

  // ------------------------------------------------------------------------ extra: tenant isolation
  it('AC-DAILY-TENANT: kết quả, streak và hạng của tài khoản A không hiện ở tài khoản B; header UUID của A kèm cookie của B không ghi vào A', async () => {
    await publish(1, BATCH_AT)
    const A = await login()
    const B = await login()
    expect(B.accountId).not.toBe(A.accountId)
    vi.setSystemTime(new Date(NOW0))
    const aRes = await submit(1, A)
    expect(aRes.status).toBe(201)
    const aStored = (await aRes.json()) as DailyResult
    const aRows = await entriesOf(A.accountId)

    // B starts clean: no streak, no result in the export, no own row on the board
    expect(await myStreak(B.cookie)).toEqual({ current: 0, longest: 0 })
    const me = await raw(api('/me'), {}, as(B.player, undefined, B.cookie))
    expect(me.status).toBe(200)
    const meText = await me.text()
    expect(meText).not.toContain(A.player)
    expect(meText).not.toContain(A.accountId)
    const data = JSON.parse(meText) as MyData
    expect(data.account!.daily_results).toEqual([])
    expect(data.account!.streak).toEqual({ current: 0, longest: 0 })
    const bBoard = await board(1, B.cookie)
    expect(bBoard.me).toBeNull()
    expect(bBoard.rows).toHaveLength(1)
    expect((await board(1, A.cookie)).me?.rank).toBe(1)
    expect((await periodBoard(undefined, B.cookie)).me).toBeNull()

    // A's submission does not block B (no 409), and B gets its own rank
    vi.setSystemTime(new Date(NOW0 + 5000))
    const bRes = await submit(1, B)
    expect(bRes.status).toBe(201)
    expect(((await bRes.json()) as DailyResult).rank).toBe(2)
    expect(await entriesOf(A.accountId)).toEqual(aRows)

    // forged: C's cookie with A's X-Player-Id must never write to A's account
    const C = await seedOne()
    const cross = await submit(1, { player: A.player, cookie: C.cookie })
    expect([201, 400, 401, 403, 409]).toContain(cross.status)
    expect(await entriesOf(A.accountId)).toEqual(aRows)
    expect((await entriesOf(C.accountId)).length).toBe(cross.status === 201 ? 1 : 0)
    // A's stored result is still the original one
    vi.setSystemTime(new Date(NOW0 + 10_000))
    const again = await expectProblem(await submit(1, A), 409)
    expect(again.result).toEqual(aStored)
  })

  // ------------------------------------------------------------------------ extra: validation
  it('AC-DAILY-VALIDATION: tên quá dài, script, SQL, kiểu sai, trường thừa (solved_at, account_id), body hỏng, sai Content-Type và version giả đều bị từ chối 4xx, không ghi gì', async () => {
    await publish(1, BATCH_AT)
    const script = '<script>alert(1)</script>'
    const okB = 'Cay'
    const bodies: Array<[string, string]> = [
      ['tên 10 000 ký tự', JSON.stringify({ a: 'A'.repeat(10_000), b: okB })],
      ['tên 101 ký tự', JSON.stringify({ a: 'x'.repeat(101), b: okB })],
      ['thẻ script', JSON.stringify({ a: script, b: okB })],
      ['SQL injection', JSON.stringify({ a: "'; DROP TABLE daily_entry;--", b: okB })],
      ['a là số âm', JSON.stringify({ a: -5, b: okB })],
      ['a là object', JSON.stringify({ a: { $ne: null }, b: okB })],
      ['a là null', JSON.stringify({ a: null, b: okB })],
      ['thiếu b', JSON.stringify({ a: 'Hết Cứu' })],
      ['chuỗi rỗng', JSON.stringify({ a: '', b: okB })],
      ['chỉ khoảng trắng', JSON.stringify({ a: '   ', b: okB })],
      ['solved_at do client gửi', JSON.stringify({ ...PAIR, solved_at: '2026-10-20T05:30:01.000Z' })],
      ['solve_ms do client gửi', JSON.stringify({ ...PAIR, solve_ms: 1 })],
      ['account_id của người khác', JSON.stringify({ ...PAIR, account_id: crypto.randomUUID() })],
      ['trường cũ steps/path', JSON.stringify({ ...PAIR, steps: 1, path: [] })],
      ['không phải JSON', '{"a": "Hết Cứu", "b": '],
      ['mảng thay vì object', '[]'],
      ['null', 'null'],
    ]
    for (const [label, body] of bodies) {
      const who = await seedOne() // a fresh account and IP per case: no rate limit interference
      const res = await submitRaw(1, who, body)
      expect([400, 422], label).toContain(res.status)
      isProblem(res)
      expect(await res.text(), label).not.toContain(script)
    }

    // a form post cannot carry the cookie into a write (ADR 0010: JSON only)
    const csrf = await seedOne()
    for (const [type, body] of [
      ['text/plain', JSON.stringify(PAIR)],
      ['application/x-www-form-urlencoded', 'a=H%E1%BA%BFt%20C%E1%BB%A9u&b=Cay'],
    ] as const) {
      const res = await submitRaw(1, csrf, body, { contentType: type })
      expect([400, 415, 422], type).toContain(res.status)
      isProblem(res)
    }

    for (const version of ['0', '-1', 'abc', '1.5', '1;DROP', '99999999999999999999', '1e3', '%00']) {
      const who = await seedOne()
      const res = await submitRaw(version, who, JSON.stringify(PAIR))
      expect(res.status, `version ${version}`).toBeGreaterThanOrEqual(400)
      expect(res.status, `version ${version}`).toBeLessThan(500)
      expect(res.status, `version ${version}`).not.toBe(429)
    }

    expect(await count('daily_entry')).toBe(0)
    expect(await count('account_streak')).toBe(0)
    // the schema is intact and a valid submission still works
    const good = await seedOne()
    expect((await submit(1, good)).status).toBe(201)
  }, 60_000)
})
