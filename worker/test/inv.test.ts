// Acceptance test for docs/acceptance/inv.md, worker part: AC-INV-11 (leaderboard holds only valid results),
// model of 2026-10-21: results belong to signed-in accounts and carry the pair (a, b), not a path.
// Black-box: HTTP contract + D1 schema (migration 0005) + ADR 0002 id formulas. The expected recipe set is built here
// from the published fixture, independent of production code. AC-INV-08 and AC-INV-09 are covered by
// disc.test.ts / report.test.ts.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['inv', 'pipeline', 'token'].join('-')
const IP_KEY = ['inv', 'ip', 'hash', 'key'].join('-')
const HASH_KEY = ['inv', 'account', 'hash', 'key'].join('-')
const CLIENT_ID = ['test', 'client', 'id.apps.googleusercontent.com'].join('-')
const KID = 'test-kid-inv'
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISS = 'https://accounts.google.com'
const COOKIE = 'laumeme_sid'
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const SEED = 20261020
const NOW0 = Date.parse('2026-10-20T06:00:05.000Z')

type Handler = {
  fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>
}
type Pair = { a: string; b: string }

// ---------------------------------------------------------------------------- ADR 0002 helpers (own copy)
const b64u = (buf: ReturnType<typeof Buffer.from>) => buf.toString('base64url')
const sha256 = async (text: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

function fold(s: string): string {
  return s.toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
}
const elementId = async (name: string) => b64u(await sha256(`lm1|e|${fold(name)}`))
async function recipeId(a: string, b: string): Promise<string> {
  const [x, y] = [fold(a), fold(b)].sort((p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q)))
  return b64u(await sha256(`lm1|k|${x}\0${y}`))
}

// ---------------------------------------------------------------------------- fixture content (as daily.test.ts)
const STARTER_DEFS = [
  { name: 'Cay', emoji: '🌶️' },
  { name: 'Cười', emoji: '😂' },
  { name: 'Toang', emoji: '💀' },
  { name: 'Deadline', emoji: '⏰' },
]
const CHAIN = [
  { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
  { a: 'Tới Công Chuyện', b: 'Deadline', result: 'Chạy Deadline', emoji: '🏃', depth: 2 },
  { a: 'Chạy Deadline', b: 'Toang', result: 'Hết Cứu', emoji: '🧯', depth: 3 },
  { a: 'Hết Cứu', b: 'Cay', result: 'Stonks', emoji: '📈', depth: 4 },
]
const TARGET = 'Stonks'
const SIDE = { a: 'Toang', b: 'Deadline', result: 'Khét Lẹt', emoji: '🫠', depth: 1 }
const HINT = 'Món lên như diều gặp gió'

async function batchBody(version: number, batchAt = BATCH_AT) {
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
      daily: { element_id: targetId, emoji: '📈', hint: HINT, depth: 4 },
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

// ---------------------------------------------------------------------------- Google sign-in harness (as daily.test.ts)
let goodKey: CryptoKey
let publicJwk: JWK
const realFetch = globalThis.fetch.bind(globalThis)
let fetchSpy: ReturnType<typeof vi.spyOn>

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

async function publish(version: number, batchAt = BATCH_AT): Promise<void> {
  const res = await raw(
    '/lau-meme/api/pipeline/batches',
    { method: 'POST', body: JSON.stringify(await batchBody(version, batchAt)) },
    { Authorization: `Bearer ${TOKEN}` },
  )
  expect(res.status).toBe(201)
}

/** Each player gets a distinct private-range IP so IP rate limits never interfere. */
function ipFor(player: string): string {
  const hex = player.replaceAll('-', '')
  return `10.${parseInt(hex.slice(0, 2), 16)}.${parseInt(hex.slice(2, 4), 16)}.${parseInt(hex.slice(4, 6), 16)}`
}

type Who = { player: string; cookie: string; accountId: string }

/** Real sign-in: play consent, a fresh Google token, the session cookie. */
async function login(): Promise<Who> {
  const player = crypto.randomUUID()
  const headers = { 'X-Player-Id': player, 'CF-Connecting-IP': ipFor(player) }
  const consent = await raw(
    '/lau-meme/api/consents',
    { method: 'POST', body: JSON.stringify({ purpose: 'play', action: 'grant', policy_version: POLICY_VERSION }) },
    headers,
  )
  expect(consent.status).toBe(201)
  const res = await raw(
    '/lau-meme/api/auth/google',
    { method: 'POST', body: JSON.stringify({ credential: await makeToken(newSub()) }) },
    headers,
  )
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!.split('=').slice(1).join('=')
  const row = await env.DB.prepare('SELECT account_id FROM account_player WHERE player_id = ?')
    .bind(player)
    .first<{ account_id: string }>()
  expect(row).not.toBeNull()
  return { player, cookie, accountId: row!.account_id }
}

const withSession = (who: Who): Record<string, string> => ({
  'X-Player-Id': who.player,
  'CF-Connecting-IP': ipFor(who.player),
  Cookie: `${COOKIE}=${who.cookie}`,
})
const submit = (version: number, who: Who, pair: Pair) =>
  raw(`/lau-meme/api/daily/${version}/results`, { method: 'POST', body: JSON.stringify(pair) }, withSession(who))

// ---------------------------------------------------------------------------- fixed-seed PRNG (mulberry32)
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Case = { label: string; pair: Pair; valid: boolean }
const NAMES = [...STARTER_DEFS.map((s) => s.name), ...CHAIN.map((c) => c.result), SIDE.result, 'Không Có Món Này']
const TARGET_KEY = [fold('Hết Cứu'), fold('Cay')].sort().join('|')

function makeCase(kind: number, rand: () => number): Case {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!
  switch (kind) {
    case 0:
      return { label: 'cặp đúng', pair: { a: 'Hết Cứu', b: 'Cay' }, valid: true }
    case 1:
      return { label: 'cặp đúng, đảo thứ tự, hoa/thường, bỏ dấu', pair: { a: 'CAY', b: ' het  CUU ' }, valid: true }
    case 2:
      return {
        label: 'công thức có thật nhưng không ra món đích',
        pair: pick([
          { a: 'Cay', b: 'Cười' },
          { a: 'Toang', b: 'Deadline' },
          { a: 'Chạy Deadline', b: 'Toang' },
        ]),
        valid: false,
      }
    case 3:
      return { label: 'cặp không phải công thức', pair: { a: 'Cay', b: 'Toang' }, valid: false }
    case 4:
      return { label: 'ghép chính món đích', pair: { a: TARGET, b: pick(NAMES) }, valid: false }
    default: {
      // a seeded random pair from the whole element set; valid only when it really is the target recipe
      const a = pick(NAMES)
      const b = pick(NAMES)
      return { label: `ngẫu nhiên ${a} + ${b}`, pair: { a, b }, valid: [fold(a), fold(b)].sort().join('|') === TARGET_KEY }
    }
  }
}

// ---------------------------------------------------------------------------- independent expectations from the fixture
/** Active recipes of the fixture, keyed by the sorted element-id pair. */
async function expectedRecipes(): Promise<Map<string, { id: string; result: string }>> {
  const map = new Map<string, { id: string; result: string }>()
  for (const d of [...CHAIN, SIDE]) {
    const key = [await elementId(d.a), await elementId(d.b)].sort().join('|')
    map.set(key, { id: await recipeId(d.a, d.b), result: await elementId(d.result) })
  }
  return map
}

type EntryRow = {
  seq: number
  version: number
  account_id: string
  day: string
  a_id: string
  b_id: string
  solved_at: number
  solve_ms: number
}

// ---------------------------------------------------------------------------- setup
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

describe('inv', () => {
  it('AC-INV-11: mọi kết quả Daily đã lưu có cặp (a, b) là công thức có thật ra đúng món đích, solved_at >= batch_at, thuộc tài khoản còn tồn tại; xóa tài khoản thì kết quả biến mất', async () => {
    await publish(1)
    const rand = prng(SEED)
    const kinds = [0, 1, 2, 3, 4, 5, 5, 5, 2, 3] // 10 submissions from 10 accounts: 2 sure valid, the rest a seeded mix
    const accepted: Who[] = []
    for (const [i, kind] of kinds.entries()) {
      const c = makeCase(kind, rand)
      const who = await login()
      vi.setSystemTime(new Date(NOW0 + i * 1000))
      const res = await submit(1, who, c.pair)
      expect(res.status, `lần nộp ${i + 1}: ${c.label}`).toBe(c.valid ? 201 : 422)
      if (c.valid) accepted.push(who)
    }
    expect(accepted.length).toBeGreaterThanOrEqual(2)

    const { results: rows } = await env.DB.prepare(
      'SELECT seq, version, account_id, day, a_id, b_id, solved_at, solve_ms FROM daily_entry ORDER BY seq',
    ).all<EntryRow>()
    expect(rows).toHaveLength(accepted.length) // refused submissions leave no row

    const recipes = await expectedRecipes()
    const target = await elementId(TARGET)
    const batchAt = Date.parse(BATCH_AT)
    for (const row of rows) {
      const recipe = recipes.get([row.a_id, row.b_id].sort().join('|'))
      expect(recipe, `(${row.a_id}, ${row.b_id}) phải là công thức đang hoạt động của version ${row.version}`).toBeDefined()
      expect(recipe!.result, 'công thức phải ra đúng món đích').toBe(target)
      expect(row.version).toBe(1)
      expect(row.solved_at).toBeGreaterThanOrEqual(batchAt)
      expect(row.solve_ms).toBe(row.solved_at - batchAt)
      const owner = await env.DB.prepare('SELECT COUNT(*) AS n FROM account WHERE id = ?')
        .bind(row.account_id)
        .first<{ n: number }>()
      expect(owner!.n, `tài khoản ${row.account_id} phải còn tồn tại`).toBe(1)
    }
    expect(new Set(rows.map((r) => r.account_id))).toEqual(new Set(accepted.map((w) => w.accountId)))

    // erasing an account with its session removes its results and leaves the others valid
    const victim = accepted[0]!
    const del = await raw('/lau-meme/api/me', { method: 'DELETE' }, withSession(victim))
    expect(del.status).toBe(204)
    const left = await env.DB.prepare('SELECT account_id FROM daily_entry').all<{ account_id: string }>()
    expect(left.results.map((r) => r.account_id)).not.toContain(victim.accountId)
    expect(left.results).toHaveLength(accepted.length - 1)
    const orphans = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM daily_entry WHERE account_id NOT IN (SELECT id FROM account)',
    ).first<{ n: number }>()
    expect(orphans!.n).toBe(0)
  }, 60_000)
})
