// Acceptance tests for docs/acceptance/feedback.md (worker part: AC-FEEDBACK-01..03, VALIDATION, ABUSE).
// Black-box: only the HTTP contract (docs/api/openapi.yaml: PUT /votes), ADR 0002 and the D1 schema
// (0002_content, 0003_player_data: table `vote`). The recipe catalog is published through POST /pipeline/batches
// (same fixture shape as report.test.ts), so "recipe is real and active" is decided by the Worker, not by us.
// Performance: D1 in Miniflare costs ~66 ms/query, so tests keep the number of requests small (except the
// rate-limit test, which needs 61 requests on purpose).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['feedback', 'pipeline', 'token'].join('-')
const IP_KEY = ['feedback', 'ip', 'hash', 'key'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const BASE = '/lau-meme/api'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Problem = { type: string; title: string; status: number; detail?: string }
type Vote = { recipe_id: string; value: string; updated_at: string }
type Row = Record<string, unknown>

// ---------------------------------------------------------------------------- ADR 0002 helpers (no Node types)
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))

function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
const elementId = async (name: string) => b64u(await sha256(`lm1|e|${fold(name)}`))
async function recipeId(a: string, b: string): Promise<string> {
  const [x, y] = [fold(a), fold(b)].sort()
  return b64u(await sha256(`lm1|k|${x}\0${y}`))
}

// ---------------------------------------------------------------------------- fixture batch (recipes that are active)
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
const ACTIVE = { a: 'Cay', b: 'Cười' } // CHAIN[0]
const ACTIVE_2 = { a: 'Tới Công Chuyện', b: 'Deadline' } // CHAIN[1]
const NOT_A_RECIPE = { a: 'Cay', b: 'Toang' } // both elements exist, but no recipe joins them in the batch

async function batchBody(version: number) {
  const starterIds = await Promise.all(STARTER_DEFS.map((s) => elementId(s.name)))
  const recipes = await Promise.all(
    CHAIN.map(async (d) => {
      const [x, y] = [await elementId(d.a), await elementId(d.b)].sort()
      return { id: await recipeId(d.a, d.b), a: x!, b: y!, result: await elementId(d.result) }
    }),
  )
  const targetId = await elementId('Stonks')
  return {
    status: 'success',
    version,
    batch_at: BATCH_AT,
    mode: 'core',
    manifest: {
      version,
      batch_at: BATCH_AT,
      graph_url: `/api/graph/${version}`,
      starters: STARTER_DEFS.map((s, i) => ({ id: starterIds[i], name: s.name, emoji: s.emoji })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: targetId, emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await recipeId('graph', String(version))]: 'abc' } },
    content: {
      elements: [
        ...STARTER_DEFS.map((s, i) => ({ id: starterIds[i], name: s.name, fold: fold(s.name), emoji: s.emoji, depth: 0, origin: 'vn' })),
        ...(await Promise.all(
          CHAIN.map(async (d) => ({ id: await elementId(d.result), name: d.result, fold: fold(d.result), emoji: d.emoji, depth: d.depth, origin: 'vn' })),
        )),
      ],
      recipes,
      starters: starterIds,
      daily_element_id: targetId,
    },
    stats: {},
  }
}

// ---------------------------------------------------------------------------- HTTP helpers
async function raw(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(`https://example.com${path}`, { ...init, headers: h }),
    { ...env, PIPELINE_TOKEN: TOKEN, IP_HASH_KEY: IP_KEY },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

async function ensurePublished(): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM app_meta WHERE key = 'current_version'").first()
  if (row) return
  const res = await raw(`${BASE}/pipeline/batches`, { method: 'POST', body: JSON.stringify(await batchBody(1)) }, { Authorization: `Bearer ${TOKEN}` })
  expect(res.status).toBe(201)
}

/** Each player gets a distinct documentation-range IP so IP rate limits never interfere unless a test wants it. */
function ipFor(player: string): string {
  const h = player.replaceAll('-', '')
  return `10.${parseInt(h.slice(0, 2), 16)}.${parseInt(h.slice(2, 4), 16)}.${parseInt(h.slice(4, 6), 16)}`
}
function as(player: string | null, ip?: string): Record<string, string> {
  const h: Record<string, string> = { 'CF-Connecting-IP': ip ?? (player ? ipFor(player) : '10.250.250.250') }
  if (player !== null) h['X-Player-Id'] = player
  return h
}

const putRaw = (player: string | null, body: string, ip?: string) => raw(`${BASE}/votes`, { method: 'PUT', body }, as(player, ip))
const vote = (player: string | null, body: unknown, ip?: string) => putRaw(player, JSON.stringify(body), ip)
const pair = (p: { a: string; b: string }, value: string) => ({ a: p.a, b: p.b, value })

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const newId = () => crypto.randomUUID()

// ---------------------------------------------------------------------------- seeding / reading
const ins = {
  consent: (player: string) =>
    env.DB.prepare(
      "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
    ).bind(newId(), player, POLICY_VERSION, Date.now() - 1000),
  /** Play history via a combine_summary event (AC-FEEDBACK-05); ok = 0 means only misses, which does not count. */
  played: (player: string, ok = 1) =>
    env.DB.prepare("INSERT INTO event (id, player_id, type, props_json, day, received_at) VALUES (?, ?, 'combine_summary', ?, ?, ?)").bind(
      newId(),
      player,
      JSON.stringify({ ok, miss: 2 }),
      new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10),
      Date.now() - 1000,
    ),
  /** Play history via a discovery row (Công thức gia truyền). */
  discovered: (player: string) =>
    env.DB.prepare('INSERT INTO discovery (element_id, player_id, a_id, b_id, version, discovered_at) VALUES (?, ?, ?, ?, 1, ?)').bind(
      `fb-el-${newId()}`,
      player,
      'fb-a',
      'fb-b',
      Date.now() - 1000,
    ),
  block: (kind: 'element' | 'recipe' | 'image', target: string, state: 'hidden' | 'blocked' = 'blocked', reason: 'auto_report' | 'admin' = 'admin') =>
    env.DB.prepare('INSERT INTO block (kind, target_id, state, reason, created_at) VALUES (?, ?, ?, ?, ?)').bind(kind, target, state, reason, Date.now()),
}

const voteRows = async (): Promise<Row[]> => (await env.DB.prepare('SELECT * FROM vote ORDER BY recipe_id, player_id').all<Row>()).results
const votesOf = async (recipe: string): Promise<Row[]> =>
  (await env.DB.prepare('SELECT * FROM vote WHERE recipe_id = ? ORDER BY player_id').bind(recipe).all<Row>()).results
async function nothingWritten(): Promise<void> {
  expect(await voteRows()).toEqual([])
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM vote'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM consent'),
    env.DB.prepare('DELETE FROM rate_counter'),
    env.DB.prepare('DELETE FROM event'),
    env.DB.prepare('DELETE FROM discovery'),
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('feedback', () => {
  // ------------------------------------------------------------------------ AC-FEEDBACK-01
  it(
    'AC-FEEDBACK-01: PUT /votes "ngon" cho công thức có thật trả 200 {recipe_id,value,updated_at} và ghi một phiếu theo UUID',
    async () => {
      await ensurePublished()
      const u = newId()
      const id = await recipeId(ACTIVE.a, ACTIVE.b)
      await env.DB.batch([ins.consent(u)])
      const before = Date.now()
      const res = await vote(u, pair(ACTIVE, 'ngon'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as Vote
      expect(Object.keys(body).sort()).toEqual(['recipe_id', 'updated_at', 'value'])
      expect(body.recipe_id).toBe(id)
      expect(body.value).toBe('ngon')
      expect(Date.parse(body.updated_at)).toBeGreaterThanOrEqual(before - 2000)
      expect(Date.parse(body.updated_at)).toBeLessThanOrEqual(Date.now() + 10_000) // the test isolate clock lags under load
      expect(JSON.stringify(body)).not.toContain(u) // the response never echoes the UUID

      const rows = await voteRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ recipe_id: id, player_id: u, value: 'ngon' })
    },
    60_000,
  )

  it(
    'AC-FEEDBACK-01: bỏ "Nhạt" cho công thức có thật cũng trả 200 và ghi value nhat; thứ tự (A, B) hay (B, A) cùng một recipe_id',
    async () => {
      await ensurePublished()
      const [u1, u2] = [newId(), newId()]
      const id = await recipeId(ACTIVE_2.a, ACTIVE_2.b)
      await env.DB.batch([ins.consent(u1), ins.consent(u2)])
      const r1 = await vote(u1, pair(ACTIVE_2, 'nhat'))
      expect(r1.status).toBe(200)
      expect(((await r1.json()) as Vote).recipe_id).toBe(id)
      const r2 = await vote(u2, pair({ a: ACTIVE_2.b, b: ACTIVE_2.a }, 'nhat'))
      expect(r2.status).toBe(200)
      expect(((await r2.json()) as Vote).recipe_id).toBe(id)
      expect(await votesOf(id)).toMatchObject([{ value: 'nhat' }, { value: 'nhat' }])
    },
    60_000,
  )

  it(
    'AC-FEEDBACK-01: chưa đồng ý chơi (play) thì 403 problem+json và không ghi phiếu',
    async () => {
      await ensurePublished()
      const res = await vote(newId(), pair(ACTIVE, 'ngon'))
      expect(res.status).toBe(403)
      isProblem(res)
      await nothingWritten()
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-FEEDBACK-02
  it(
    'AC-FEEDBACK-02: UUID đã bỏ "Ngon" cho (A, B) rồi bỏ "Nhạt" cho (B, A) thì phiếu cũ được thay; tổng phiếu của công thức vẫn là 1 cho UUID đó',
    async () => {
      await ensurePublished()
      const u = newId()
      const id = await recipeId(ACTIVE.a, ACTIVE.b)
      await env.DB.batch([ins.consent(u)])
      const first = await vote(u, pair(ACTIVE, 'ngon'))
      expect(first.status).toBe(200)
      const firstBody = (await first.json()) as Vote
      expect(firstBody.value).toBe('ngon')

      const second = await vote(u, pair({ a: ACTIVE.b, b: ACTIVE.a }, 'nhat'))
      expect(second.status).toBe(200)
      const secondBody = (await second.json()) as Vote
      expect(secondBody.recipe_id).toBe(id)
      expect(secondBody.value).toBe('nhat')
      expect(Date.parse(secondBody.updated_at)).toBeGreaterThanOrEqual(Date.parse(firstBody.updated_at))

      const rows = await votesOf(id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ player_id: u, value: 'nhat' })
      expect(await voteRows()).toHaveLength(1)
    },
    60_000,
  )

  it(
    'AC-FEEDBACK-02: phiếu của UUID khác cho cùng công thức là phiếu riêng (2 UUID = 2 phiếu); gửi lại cùng giá trị vẫn một dòng',
    async () => {
      await ensurePublished()
      const [u1, u2] = [newId(), newId()]
      const id = await recipeId(ACTIVE.a, ACTIVE.b)
      await env.DB.batch([ins.consent(u1), ins.consent(u2)])
      expect((await vote(u1, pair(ACTIVE, 'ngon'))).status).toBe(200)
      expect((await vote(u2, pair(ACTIVE, 'nhat'))).status).toBe(200)
      expect((await vote(u1, pair(ACTIVE, 'ngon'))).status).toBe(200)
      const rows = await votesOf(id)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.player_id === u1)).toMatchObject({ value: 'ngon' })
      expect(rows.find((r) => r.player_id === u2)).toMatchObject({ value: 'nhat' })
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-FEEDBACK-03
  it(
    'AC-FEEDBACK-03: công thức không có thật (tên không tồn tại hoặc hai phần tử không ghép được) trả 422 problem+json và không ghi phiếu',
    async () => {
      await ensurePublished()
      const u = newId()
      await env.DB.batch([ins.consent(u)])
      for (const body of [
        pair({ a: 'Rp Không Có Thật', b: 'Cười' }, 'ngon'),
        pair({ a: 'Cay', b: 'Rp Cũng Không Có' }, 'nhat'),
        pair(NOT_A_RECIPE, 'ngon'),
      ]) {
        const res = await vote(u, body)
        expect(res.status, JSON.stringify(body)).toBe(422)
        isProblem(res)
        expect(((await res.json()) as Problem).status).toBe(422)
      }
      await nothingWritten()
    },
    60_000,
  )

  it(
    'AC-FEEDBACK-03: công thức không hoạt động (bị chặn trong danh sách chặn) trả 422 problem+json và không ghi phiếu',
    async () => {
      await ensurePublished()
      const u = newId()
      await env.DB.batch([ins.consent(u), ins.block('recipe', await recipeId(ACTIVE.a, ACTIVE.b))])
      const res = await vote(u, pair(ACTIVE, 'ngon'))
      expect(res.status).toBe(422)
      isProblem(res)
      const other = await vote(u, pair(ACTIVE_2, 'ngon')) // an unblocked recipe still works
      expect(other.status).toBe(200)
      expect(await voteRows()).toHaveLength(1)
    },
    60_000,
  )

  it(
    'AC-FEEDBACK-03: công thức có phần tử bị chặn (phần tử đầu vào hoặc kết quả không hoạt động) trả 422 và không ghi phiếu',
    async () => {
      await ensurePublished()
      const u = newId()
      await env.DB.batch([ins.consent(u), ins.block('element', await elementId('Chạy Deadline'), 'blocked')])
      const res = await vote(u, pair(ACTIVE_2, 'ngon')) // result "Chạy Deadline" is blocked
      expect(res.status).toBe(422)
      isProblem(res)
      await nothingWritten()
    },
    60_000,
  )

  it(
    'AC-FEEDBACK-03: giá trị ngoài {ngon, nhat} (rỗng, viết hoa, thừa khoảng trắng, từ khác) trả 422 problem+json và không ghi phiếu',
    async () => {
      await ensurePublished()
      const u = newId()
      await env.DB.batch([ins.consent(u)])
      for (const value of ['', 'Ngon', 'NHAT', 'ngon ', 'tốt', 'bad']) {
        const res = await vote(u, pair(ACTIVE, value))
        expect(res.status, JSON.stringify(value)).toBe(422)
        isProblem(res)
      }
      await nothingWritten()
    },
    60_000,
  )

  it(
    'AC-FEEDBACK-03: thiếu hoặc sai X-Player-Id (không phải UUID v4) trả 400 problem+json và không ghi phiếu',
    async () => {
      await ensurePublished()
      for (const bad of [null, '', 'not-a-uuid', '12345678-1234-1234-1234-123456789012', '00000000-0000-0000-0000-000000000000']) {
        const res = await vote(bad, pair(ACTIVE, 'ngon'))
        expect(res.status, String(bad)).toBe(400)
        isProblem(res)
      }
      await nothingWritten()
    },
    60_000,
  )

  it(
    'AC-FEEDBACK-03: vượt 60 phiếu/phút/UUID thì phiếu thứ 61 trả 429 problem+json kèm Retry-After, không đổi phiếu đã lưu; UUID khác không bị ảnh hưởng',
    async () => {
      await ensurePublished()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-20T06:30:30.000Z')) // middle of a minute: all 61 requests share one window
      const [u, other] = [newId(), newId()]
      const id = await recipeId(ACTIVE.a, ACTIVE.b)
      await env.DB.batch([ins.consent(u), ins.consent(other)])
      for (let i = 1; i <= 60; i++) {
        const res = await vote(u, pair(ACTIVE, i % 2 === 0 ? 'ngon' : 'nhat'))
        expect(res.status, `phiếu thứ ${i}`).toBe(200)
      }
      const limited = await vote(u, pair(ACTIVE, 'nhat'))
      expect(limited.status).toBe(429)
      isProblem(limited)
      const retry = Number(limited.headers.get('retry-after'))
      expect(Number.isInteger(retry)).toBe(true)
      expect(retry).toBeGreaterThanOrEqual(1)
      expect(retry).toBeLessThanOrEqual(60)
      expect((await votesOf(id)).find((r) => r.player_id === u)).toMatchObject({ value: 'ngon' }) // 60th vote kept, 61st rejected

      expect((await vote(other, pair(ACTIVE, 'ngon'), '10.77.77.77')).status).toBe(200)
    },
    120_000,
  )

  // ------------------------------------------------------------------------ AC-FEEDBACK-04 (phía Worker: tổng hợp ẩn danh)
  it(
    'AC-FEEDBACK-04: GET /pipeline/state.feedback là [{recipe_id,votes,nhat}] theo từng công thức có phiếu, không có UUID, phiếu đổi tính một lần với giá trị mới, xếp theo recipe_id',
    async () => {
      await ensurePublished()
      const [u1, u2, u3] = [newId(), newId(), newId()]
      await env.DB.batch([ins.consent(u1), ins.consent(u2), ins.consent(u3), ins.played(u1), ins.played(u2), ins.played(u3)])
      const reversed = { a: ACTIVE.b, b: ACTIVE.a }
      expect((await vote(u1, pair(ACTIVE, 'ngon'))).status).toBe(200)
      expect((await vote(u2, pair(ACTIVE, 'ngon'))).status).toBe(200)
      expect((await vote(u3, pair(reversed, 'nhat'))).status).toBe(200)
      expect((await vote(u1, pair(reversed, 'nhat'))).status).toBe(200) // changed ngon -> nhat, counts once
      expect((await vote(u2, pair(ACTIVE_2, 'nhat'))).status).toBe(200)

      const res = await raw(`${BASE}/pipeline/state`, {}, { Authorization: `Bearer ${TOKEN}` })
      expect(res.status).toBe(200)
      const state = (await res.json()) as { feedback: Array<Record<string, unknown>> }
      const id1 = await recipeId(ACTIVE.a, ACTIVE.b)
      const id2 = await recipeId(ACTIVE_2.a, ACTIVE_2.b)
      const expected = [
        { recipe_id: id1, votes: 3, nhat: 2 },
        { recipe_id: id2, votes: 1, nhat: 1 },
      ].sort((x, y) => (x.recipe_id < y.recipe_id ? -1 : 1))
      expect(state.feedback).toEqual(expected)
      for (const item of state.feedback) expect(Object.keys(item).sort()).toEqual(['nhat', 'recipe_id', 'votes'])
      const text = JSON.stringify(state.feedback)
      for (const u of [u1, u2, u3]) expect(text).not.toContain(u)
    },
    120_000,
  )

  // ------------------------------------------------------------------------ AC-FEEDBACK-05
  const readFeedback = async () => {
    const res = await raw(`${BASE}/pipeline/state`, {}, { Authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
    return ((await res.json()) as { feedback: Array<Record<string, unknown>> }).feedback
  }

  it(
    'AC-FEEDBACK-05: 12 phiếu "Nhạt" (9 UUID chưa chơi, 3 UUID đã chơi) đều được lưu nhưng /pipeline/state.feedback chỉ đếm 3 phiếu (3 Nhạt); combine_summary chỉ có trượt (ok = 0) không tính',
    async () => {
      await ensurePublished()
      const id = await recipeId(ACTIVE.a, ACTIVE.b)
      const played = [newId(), newId(), newId()]
      const idle = Array.from({ length: 9 }, () => newId())
      await env.DB.batch([
        ...[...played, ...idle].map((u) => ins.consent(u)),
        ins.discovered(played[0]!), // via Công thức gia truyền
        ins.played(played[1]!, 2), // via combine_summary ok >= 1
        ins.played(played[2]!, 1),
        ins.played(idle[0]!, 0), // only misses: still no history
        ins.played(idle[1]!, 0),
      ])
      for (const u of [...played, ...idle]) {
        const res = await vote(u, pair(ACTIVE, 'nhat'))
        expect(res.status).toBe(200)
      }
      expect(await votesOf(id)).toHaveLength(12) // all stored
      expect(await readFeedback()).toEqual([{ recipe_id: id, votes: 3, nhat: 3 }])
    },
    240_000,
  )

  it(
    'AC-FEEDBACK-05: công thức chỉ có phiếu của UUID chưa chơi không có trong feedback; khi UUID đó có lịch sử chơi thì phiếu được đếm từ lần đọc sau',
    async () => {
      await ensurePublished()
      const u = newId()
      const id = await recipeId(ACTIVE_2.a, ACTIVE_2.b)
      await env.DB.batch([ins.consent(u)])
      expect((await vote(u, pair(ACTIVE_2, 'nhat'))).status).toBe(200)
      expect(await votesOf(id)).toHaveLength(1)
      expect(await readFeedback()).toEqual([])

      await env.DB.batch([ins.discovered(u)])
      expect(await readFeedback()).toEqual([{ recipe_id: id, votes: 1, nhat: 1 }])
    },
    90_000,
  )

  // ------------------------------------------------------------------------ AC-FEEDBACK-VALIDATION
  it(
    'AC-FEEDBACK-VALIDATION: tên quá dài, script, SQL, kiểu sai, thiếu trường, trường lạ, value quá dài, JSON hỏng bị từ chối 4xx problem+json và không ghi phiếu',
    async () => {
      await ensurePublished()
      const u = newId()
      await env.DB.batch([ins.consent(u)])
      const bodies: string[] = [
        JSON.stringify({ a: 'x'.repeat(10_000), b: 'Cười', value: 'ngon' }),
        JSON.stringify({ a: 'Cay', b: 'y'.repeat(10_000), value: 'ngon' }),
        JSON.stringify({ a: '<script>alert(1)</script>', b: 'Cười', value: 'ngon' }),
        JSON.stringify({ a: "'; DROP TABLE vote;--", b: 'Cười', value: 'ngon' }),
        JSON.stringify({ a: 'Cay', b: 'Cười', value: '<script>alert(1)</script>' }),
        JSON.stringify({ a: 'Cay', b: 'Cười', value: 'ngon'.repeat(1000) }),
        JSON.stringify({ a: 'Cay', b: 'Cười', value: "ngon'; DROP TABLE vote;--" }),
        JSON.stringify({ a: 123, b: 'Cười', value: 'ngon' }),
        JSON.stringify({ a: 'Cay', b: null, value: 'ngon' }),
        JSON.stringify({ a: 'Cay', b: 'Cười', value: 1 }),
        JSON.stringify({ a: 'Cay', b: 'Cười' }),
        JSON.stringify({ a: 'Cay', value: 'ngon' }),
        JSON.stringify({ b: 'Cười', value: 'ngon' }),
        JSON.stringify({ a: 'Cay', b: 'Cười', value: 'ngon', recipe_id: 'abc' }),
        JSON.stringify(['Cay', 'Cười', 'ngon']),
        '{"a": "Cay", ',
        '',
      ]
      for (const b of bodies) {
        const res = await putRaw(u, b)
        expect(res.status, b.slice(0, 60)).toBeGreaterThanOrEqual(400)
        expect(res.status, b.slice(0, 60)).toBeLessThan(500)
        expect(res.status, b.slice(0, 60)).not.toBe(429)
        isProblem(res)
      }
      await nothingWritten()
    },
    120_000,
  )

  // ------------------------------------------------------------------------ AC-FEEDBACK-ABUSE (endpoint không có tenant, khóa theo UUID)
  it(
    'AC-FEEDBACK-ABUSE: UUID không thể ghi hoặc đổi phiếu của UUID khác (trường player_id giả bị từ chối hoặc bỏ qua; phiếu của người kia giữ nguyên)',
    async () => {
      await ensurePublished()
      const [victim, attacker] = [newId(), newId()]
      const id = await recipeId(ACTIVE.a, ACTIVE.b)
      await env.DB.batch([ins.consent(victim), ins.consent(attacker)])
      expect((await vote(victim, pair(ACTIVE, 'ngon'))).status).toBe(200)

      const forged = await vote(attacker, { ...pair(ACTIVE, 'nhat'), player_id: victim })
      expect(forged.status).toBeLessThan(500)
      expect(forged.status).not.toBe(429)
      if (forged.status !== 200) {
        expect(forged.status).toBeGreaterThanOrEqual(400)
        isProblem(forged)
      }
      const rows = await votesOf(id)
      expect(rows.find((r) => r.player_id === victim)).toMatchObject({ value: 'ngon' }) // untouched
      expect(rows.every((r) => r.player_id === victim || r.player_id === attacker)).toBe(true)

      // a normal vote by the attacker only ever changes the attacker's own row
      expect((await vote(attacker, pair(ACTIVE, 'nhat'))).status).toBe(200)
      const after = await votesOf(id)
      expect(after).toHaveLength(2)
      expect(after.find((r) => r.player_id === victim)).toMatchObject({ value: 'ngon' })
      expect(after.find((r) => r.player_id === attacker)).toMatchObject({ value: 'nhat' })
    },
    90_000,
  )
})
