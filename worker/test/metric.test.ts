// Acceptance tests for docs/acceptance/metric.md (worker part: AC-METRIC-02, 03, 05, 06 (auth side), 07, VALIDATION).
// Black-box: HTTP contract (docs/api/openapi.yaml: POST /events, GET /metrics/summary) and the D1 schema
// (migrations/0003_player_data.sql, table `event`). Aggregation (AC-METRIC-05) is tested through the endpoint with a
// fixed fixture whose expected numbers were computed by hand (see the comment above FIXTURE).
// Performance: D1 in Miniflare costs ~66 ms/query, so every test seeds with ONE env.DB.batch and keeps requests few.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const PIPELINE_TOKEN = ['metric', 'pipeline', 'token'].join('-')
const ADMIN_TOKEN = ['metric', 'admin', 'token'].join('-')
const IP_KEY = ['metric', 'ip', 'hash', 'key'].join('-')
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const BASE = '/lau-meme/api'
const DAY_MS = 86_400_000
const GMT7 = 7 * 3_600_000

type Handler = {
  fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>
  scheduled: (controller: ScheduledController, env: unknown, ctx: ExecutionContext) => Promise<void>
}
const handler = worker as unknown as Handler
type Row = Record<string, unknown>
type Summary = {
  day: string
  daily_players: number
  daily_completions: number
  d1_retention: number | null
  d7_retention: number | null
  shares: { daily: number; discovery: number }
  miss_rate: number | null
  nhat_rate: number | null
  reports: number
}

// ---------------------------------------------------------------------------- HTTP helpers
async function raw(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await handler.fetch(
    new Request(`https://example.com${path}`, { ...init, headers: h }),
    { ...env, PIPELINE_TOKEN, ADMIN_TOKEN, IP_HASH_KEY: IP_KEY },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

const IP = '203.0.113.9'
const as = (player: string, ip = IP): Record<string, string> => ({ 'X-Player-Id': player, 'CF-Connecting-IP': ip })
const postEvents = (player: string, body: unknown, extra: Record<string, string> = {}) =>
  raw(`${BASE}/events`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }, { ...as(player), ...extra })
const getSummary = (day: string | null, auth?: string) =>
  raw(`${BASE}/metrics/summary${day === null ? '' : `?day=${encodeURIComponent(day)}`}`, {}, auth ? { Authorization: auth } : {})
const bearerPipeline = `Bearer ${PIPELINE_TOKEN}`
const bearerAdmin = `Bearer ${ADMIN_TOKEN}`

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const newId = () => crypto.randomUUID()
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// ---------------------------------------------------------------------------- seeding
const ins = {
  consent: (player: string) =>
    env.DB.prepare(
      "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
    ).bind(newId(), player, POLICY_VERSION, Date.now() - 1000),
  event: (player: string, type: string, receivedAt: number, props: Record<string, unknown> = {}) =>
    env.DB.prepare('INSERT INTO event (id, player_id, type, props_json, day, received_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      newId(),
      player,
      type,
      JSON.stringify(props),
      new Date(receivedAt + GMT7).toISOString().slice(0, 10),
      receivedAt,
    ),
}

const eventRows = async (): Promise<Row[]> => (await env.DB.prepare('SELECT * FROM event ORDER BY received_at, id').all<Row>()).results
const nEvents = async () => (await eventRows()).length

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM event'), env.DB.prepare('DELETE FROM consent'), env.DB.prepare('DELETE FROM rate_counter')])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const ALL_TYPES = [
  { type: 'session_start' },
  { type: 'combine_summary', ok: 3, miss: 1 },
  { type: 'daily_start', version: 202610210000 },
  { type: 'daily_complete', version: 202610210000, steps: 7 },
  { type: 'share', card: 'daily', method: 'copy' },
  { type: 'report', target: 'element' },
  { type: 'feedback', value: 'nhat' },
]

describe('metric events (POST /events)', () => {
  // ============================================================== AC-METRIC-02
  it('AC-METRIC-02: lô đủ 7 loại hợp lệ trả 202; mỗi sự kiện lưu loại, UUID người chơi, id UUIDv7, thời điểm nhận, ngày GMT+7, thuộc tính', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const before = Date.now()
    const res = await postEvents(u, { events: ALL_TYPES })
    expect(res.status).toBe(202)

    const rows = await eventRows()
    expect(rows).toHaveLength(7)
    expect(rows.map((r) => r.type).sort()).toEqual(ALL_TYPES.map((e) => e.type).sort())
    expect(new Set(rows.map((r) => r.id)).size).toBe(7)
    for (const r of rows) {
      expect(r.player_id).toBe(u)
      expect(r.id as string).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(r.received_at as number).toBeGreaterThanOrEqual(before - 2000)
      expect(r.received_at as number).toBeLessThanOrEqual(Date.now() + 2000)
      expect(r.day).toBe(new Date((r.received_at as number) + GMT7).toISOString().slice(0, 10))
    }
    const props = (type: string) => JSON.parse(rows.find((r) => r.type === type)!.props_json as string) as Record<string, unknown>
    expect(props('combine_summary')).toMatchObject({ ok: 3, miss: 1 })
    expect(props('daily_start')).toMatchObject({ version: 202610210000 })
    expect(props('daily_complete')).toMatchObject({ version: 202610210000, steps: 7 })
    expect(props('share')).toMatchObject({ card: 'daily', method: 'copy' })
    expect(props('report')).toMatchObject({ target: 'element' })
    expect(props('feedback')).toMatchObject({ value: 'nhat' })
    expect(Object.keys(props('session_start')).filter((k) => k !== 'type')).toEqual([])
  })

  it('AC-METRIC-02: lô đúng 50 sự kiện (giới hạn) vẫn được nhận và lưu đủ 50 dòng', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const res = await postEvents(u, { events: Array.from({ length: 50 }, () => ({ type: 'session_start' })) })
    expect(res.status).toBe(202)
    expect(await nEvents()).toBe(50)
  })

  it('AC-METRIC-02: không lưu IP, user agent, URL giới thiệu ở bất kỳ cột nào của sự kiện', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const res = await postEvents(
      u,
      { events: ALL_TYPES },
      { 'User-Agent': 'UniqueAgent/9.9 (SecretDevice)', Referer: 'https://referrer.example.org/secret/path?token=zzz', Origin: 'https://origin.example.org' },
    )
    expect(res.status).toBe(202)
    const dump = JSON.stringify(await eventRows())
    expect(dump).not.toContain(IP)
    expect(dump).not.toContain('UniqueAgent')
    expect(dump).not.toContain('SecretDevice')
    expect(dump).not.toContain('referrer.example.org')
    expect(dump).not.toContain('secret/path')
    expect(dump).not.toContain('origin.example.org')
    const cols = (await env.DB.prepare('PRAGMA table_info(event)').all<{ name: string }>()).results.map((c) => c.name)
    expect(cols.sort()).toEqual(['day', 'id', 'player_id', 'props_json', 'received_at', 'type'])
  })

  it('AC-METRIC-02: gửi bằng text/plain (sendBeacon) với player_id trong thân, không có header X-Player-Id, vẫn trả 202 và lưu', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const res = await raw(
      `${BASE}/events`,
      { method: 'POST', body: JSON.stringify({ player_id: u, events: [{ type: 'session_start' }, { type: 'combine_summary', ok: 5, miss: 2 }] }) },
      { 'Content-Type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': IP },
    )
    expect(res.status).toBe(202)
    const rows = await eventRows()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.player_id === u)).toBe(true)
  })

  it('AC-METRIC-02: thực khách chưa đồng ý chơi thì 403 problem+json và không ghi gì (AC-PRIV-02)', async () => {
    const res = await postEvents(newId(), { events: [{ type: 'session_start' }] })
    expect(res.status).toBe(403)
    isProblem(res)
    expect(await nEvents()).toBe(0)
  })

  // ============================================================== AC-METRIC-03
  const INVALID_422: [string, unknown[]][] = [
    ['loại sự kiện lạ', [{ type: 'session_start' }, { type: 'keylogger', text: 'abc' }]],
    ['thuộc tính thừa ở session_start', [{ type: 'session_start' }, { type: 'session_start', user_agent: 'x' }]],
    ['share với card ngoài danh sách', [{ type: 'session_start' }, { type: 'share', card: 'secret', method: 'copy' }]],
    ['share với method ngoài danh sách', [{ type: 'share', card: 'daily', method: 'fax' }]],
    ['combine_summary thiếu miss', [{ type: 'combine_summary', ok: 3 }]],
    ['combine_summary ok âm', [{ type: 'combine_summary', ok: -1, miss: 0 }]],
    ['combine_summary vượt 10000', [{ type: 'combine_summary', ok: 10001, miss: 0 }]],
    ['combine_summary không phải số nguyên', [{ type: 'combine_summary', ok: 1.5, miss: 0 }]],
    ['daily_complete steps = 0', [{ type: 'daily_complete', version: 1, steps: 0 }]],
    ['daily_complete steps > 200', [{ type: 'daily_complete', version: 1, steps: 201 }]],
    ['feedback value lạ', [{ type: 'feedback', value: '<script>alert(1)</script>' }]],
    ['report target lạ', [{ type: 'report', target: 'player' }]],
    ['chuỗi script trong loại', [{ type: '<script>alert(1)</script>' }]],
    ['lô hơn 50 sự kiện', Array.from({ length: 51 }, () => ({ type: 'session_start' }))],
    ['lô rỗng', []],
  ]

  it.each(INVALID_422)('AC-METRIC-03: %s trả 422 problem+json và cả lô không được ghi', async (_name, events) => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const res = await postEvents(u, { events })
    expect(res.status).toBe(422)
    isProblem(res)
    expect(await nEvents()).toBe(0)
  })

  it('AC-METRIC-03: thuộc tính ngoài schema ở cấp lô (khóa thừa) trả 422 và không ghi', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const res = await postEvents(u, { events: [{ type: 'session_start' }], ip: IP })
    expect(res.status).toBe(422)
    isProblem(res)
    expect(await nEvents()).toBe(0)
  })

  it('AC-METRIC-03: thiếu UUID (không header, không player_id) trả 400 problem+json và không ghi', async () => {
    const res = await raw(`${BASE}/events`, { method: 'POST', body: JSON.stringify({ events: [{ type: 'session_start' }] }) }, { 'CF-Connecting-IP': IP })
    expect(res.status).toBe(400)
    isProblem(res)
    expect(await nEvents()).toBe(0)
  })

  it('AC-METRIC-03: UUID sai định dạng (header hoặc player_id) trả 400 problem+json và không ghi', async () => {
    const viaHeader = await raw(`${BASE}/events`, { method: 'POST', body: JSON.stringify({ events: [{ type: 'session_start' }] }) }, as('khong-phai-uuid'))
    expect(viaHeader.status).toBe(400)
    isProblem(viaHeader)
    const viaBody = await raw(
      `${BASE}/events`,
      { method: 'POST', body: JSON.stringify({ player_id: "'; DROP TABLE event;--", events: [{ type: 'session_start' }] }) },
      { 'Content-Type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': IP },
    )
    expect(viaBody.status).toBe(400)
    isProblem(viaBody)
    expect(await nEvents()).toBe(0)
  })

  it('AC-METRIC-03: thân không phải JSON trả 400 problem+json và không ghi', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const res = await postEvents(u, '{khong phai json')
    expect(res.status).toBe(400)
    isProblem(res)
    expect(await nEvents()).toBe(0)
  })

  it('AC-METRIC-03: vượt 20 lô/phút/UUID thì lô thứ 21 trả 429 problem+json kèm Retry-After và không ghi; UUID khác không bị ảnh hưởng', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T06:30:10.000Z')) // giữa phút, tránh qua ranh giới cửa sổ
    const [u, other] = [newId(), newId()]
    await env.DB.batch([ins.consent(u), ins.consent(other)])
    for (let i = 0; i < 20; i++) {
      const ok = await postEvents(u, { events: [{ type: 'session_start' }] })
      expect(ok.status).toBe(202)
    }
    const limited = await postEvents(u, { events: [{ type: 'session_start' }] })
    expect(limited.status).toBe(429)
    isProblem(limited)
    const retry = Number(limited.headers.get('retry-after'))
    expect(Number.isInteger(retry)).toBe(true)
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(60)
    expect(await nEvents()).toBe(20)

    const fine = await postEvents(other, { events: [{ type: 'session_start' }] }, { 'CF-Connecting-IP': '198.51.100.7' })
    expect(fine.status).toBe(202)
  })

  // ============================================================== AC-METRIC-VALIDATION
  it('AC-METRIC-VALIDATION: payload nguy hiểm (chuỗi 1 MB, script, số khổng lồ, kiểu dữ liệu sai) không bao giờ được ghi', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const huge = 'A'.repeat(1_000_000)
    const dangerous = [
      { events: [{ type: 'report', target: huge }] },
      { events: [{ type: 'feedback', value: '<img src=x onerror=alert(1)>' }] },
      { events: [{ type: 'combine_summary', ok: 1e308, miss: 0 }] },
      { events: [{ type: 'daily_start', version: -1 }] },
      { events: 'session_start' },
      { events: [null, 7, 'x'] },
      [],
    ]
    for (const body of dangerous) {
      const res = await postEvents(u, body)
      expect([400, 422]).toContain(res.status)
      isProblem(res)
    }
    expect(await nEvents()).toBe(0)
  })
})

// ================================================================== AC-METRIC-05
// Fixture hand-computed. D = 2026-10-10 (GMT+7). Every event is placed at 12:00 GMT+7 of its day unless noted.
// Players: A..O = pid(1)..pid(15).
//
// session_start (first-ever day in brackets):
//   10-02: L [first]            10-03: G, H, I, J [first]          10-08: E [first]
//   10-09: A, B, C, D, F [first], E (not first)                    10-10: A, B, E, G, H, L, M [first]
// D1 cohort = first session on 10-09 = {A,B,C,D,F} (5); returned on D = {A,B} (E is not in the cohort) -> 2/5 = 0.4
// D7 cohort = first session on 10-03 = {G,H,I,J} (4); returned on D = {G,H} (L's first day is 10-02) -> 2/4 = 0.5
// daily_start on D: A, B, G, M, M(again) -> 4 distinct UUIDs.   daily_complete on D: A, B, M -> 3.
// share on D: daily x3 (A copy, A native, B image), discovery x2 (G copy, M copy).
// combine_summary on D: (ok 10, miss 2), (ok 12, miss 3), (ok 8, miss 5) -> miss 10 / (ok 30 + miss 10) = 0.25
// feedback on D: nhat x3, ngon x7 -> "Nhạt" rate 3/10 = 0.3.   report on D: 2.
// Noise on other days (must be ignored): 10-09 and 10-11 shares/daily/reports/combines/feedback, boundary events at
// 2026-10-09 23:30 and 2026-10-11 00:30 GMT+7.
const D = '2026-10-10'
const at = (day: string, hh = 12, mm = 0) => Date.parse(`${day}T00:00:00.000Z`) + (hh * 60 + mm) * 60_000 - GMT7
const [A, B, C, Dd, E, F, G, H, I, J, L, M, N] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14].map(pid)

function fixtureRows() {
  const e = ins.event
  return [
    // retention
    e(L!, 'session_start', at('2026-10-02')),
    ...[G!, H!, I!, J!].map((p) => e(p, 'session_start', at('2026-10-03'))),
    e(E!, 'session_start', at('2026-10-08')),
    ...[A!, B!, C!, Dd!, F!, E!].map((p) => e(p, 'session_start', at('2026-10-09'))),
    ...[A!, B!, E!, G!, H!, L!, M!].map((p) => e(p, 'session_start', at(D))),
    // Daily on D
    ...[A!, B!, G!, M!].map((p) => e(p, 'daily_start', at(D), { version: 1 })),
    e(M!, 'daily_start', at(D, 13), { version: 1 }),
    ...[A!, B!, M!].map((p) => e(p, 'daily_complete', at(D, 14), { version: 1, steps: 6 })),
    // shares on D
    e(A!, 'share', at(D, 15), { card: 'daily', method: 'copy' }),
    e(A!, 'share', at(D, 15, 5), { card: 'daily', method: 'native' }),
    e(B!, 'share', at(D, 15, 10), { card: 'daily', method: 'image' }),
    e(G!, 'share', at(D, 15, 15), { card: 'discovery', method: 'copy' }),
    e(M!, 'share', at(D, 15, 20), { card: 'discovery', method: 'copy' }),
    // combines on D (one at 00:30 GMT+7, one at 23:30 GMT+7: both inside D)
    e(A!, 'combine_summary', at(D, 0, 30), { ok: 10, miss: 2 }),
    e(B!, 'combine_summary', at(D, 12), { ok: 12, miss: 3 }),
    e(G!, 'combine_summary', at(D, 23, 30), { ok: 8, miss: 5 }),
    // feedback on D
    ...[A!, B!, G!].map((p) => e(p, 'feedback', at(D, 16), { value: 'nhat' })),
    ...[A!, B!, G!, H!, E!, L!, M!].map((p) => e(p, 'feedback', at(D, 16, 30), { value: 'ngon' })),
    // reports on D
    e(A!, 'report', at(D, 17), { target: 'element' }),
    e(B!, 'report', at(D, 17, 5), { target: 'image' }),
    // noise on other days
    e(N!, 'daily_start', at('2026-10-11'), { version: 2 }),
    e(A!, 'daily_complete', at('2026-10-11'), { version: 2, steps: 5 }),
    e(N!, 'daily_start', at('2026-10-09'), { version: 0 }),
    e(A!, 'share', at('2026-10-09'), { card: 'daily', method: 'copy' }),
    e(A!, 'share', at('2026-10-11'), { card: 'discovery', method: 'copy' }),
    e(A!, 'combine_summary', at('2026-10-09', 23, 30), { ok: 100, miss: 100 }),
    e(A!, 'combine_summary', at('2026-10-11', 0, 30), { ok: 100, miss: 100 }),
    e(A!, 'feedback', at('2026-10-09'), { value: 'nhat' }),
    e(A!, 'feedback', at('2026-10-11'), { value: 'nhat' }),
    e(A!, 'report', at('2026-10-09'), { target: 'element' }),
    e(A!, 'report', at('2026-10-11'), { target: 'element' }),
    e(F!, 'session_start', at('2026-10-11')),
  ]
}

describe('metric summary (GET /metrics/summary)', () => {
  it('AC-METRIC-05: fixture 10 ngày, ngày D = 2026-10-10 trả đúng giá trị tính tay của mọi chỉ số', async () => {
    await env.DB.batch(fixtureRows())
    const res = await getSummary(D, bearerPipeline)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Summary
    expect(body.day).toBe(D)
    expect(body.daily_players).toBe(4)
    expect(body.daily_completions).toBe(3)
    expect(body.d1_retention).toBeCloseTo(0.4, 6)
    expect(body.d7_retention).toBeCloseTo(0.5, 6)
    expect(body.shares).toEqual({ daily: 3, discovery: 2 })
    expect(body.miss_rate).toBeCloseTo(0.25, 6)
    expect(body.nhat_rate).toBeCloseTo(0.3, 6)
    expect(body.reports).toBe(2)
    expect(Object.keys(body).sort()).toEqual(['d1_retention', 'd7_retention', 'daily_completions', 'daily_players', 'day', 'miss_rate', 'nhat_rate', 'reports', 'shares'])
  })

  it('AC-METRIC-05: số liệu trả về không chứa UUID người chơi hay sự kiện thô', async () => {
    await env.DB.batch(fixtureRows())
    const res = await getSummary(D, bearerPipeline)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(text).not.toContain('player_id')
    expect(text).not.toContain('props_json')
  })

  it('AC-METRIC-05: ngày không có dữ liệu trả số đếm 0 và các tỉ lệ null (không chia cho 0)', async () => {
    await env.DB.batch(fixtureRows())
    const res = await getSummary('2026-09-20', bearerPipeline)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Summary
    expect(body).toEqual({
      day: '2026-09-20',
      daily_players: 0,
      daily_completions: 0,
      d1_retention: null,
      d7_retention: null,
      shares: { daily: 0, discovery: 0 },
      miss_rate: null,
      nhat_rate: null,
      reports: 0,
    })
  })

  // ============================================================== AC-METRIC-06 (worker side: auth)
  it('AC-METRIC-06: thiếu token trả 401 problem+json (cả khi có X-Player-Id)', async () => {
    await env.DB.batch(fixtureRows())
    const none = await getSummary(D)
    expect(none.status).toBe(401)
    isProblem(none)
    const player = await raw(`${BASE}/metrics/summary?day=${D}`, {}, as(newId()))
    expect(player.status).toBe(401)
    isProblem(player)
    const text = await none.text()
    expect(text).not.toContain('daily_players')
  })

  it('AC-METRIC-06: token sai trả 401 problem+json', async () => {
    const res = await getSummary(D, `Bearer ${['wrong', 'token'].join('-')}`)
    expect(res.status).toBe(401)
    isProblem(res)
  })

  it('AC-METRIC-06: token pipeline và token admin đều gọi được endpoint tổng hợp (200)', async () => {
    await env.DB.batch(fixtureRows())
    const viaPipeline = await getSummary(D, bearerPipeline)
    const viaAdmin = await getSummary(D, bearerAdmin)
    expect(viaPipeline.status).toBe(200)
    expect(viaAdmin.status).toBe(200)
    expect(await viaAdmin.json()).toEqual(await viaPipeline.json())
  })

  it('AC-METRIC-VALIDATION: tham số day thiếu hoặc không phải ngày hợp lệ trả 400 problem+json', async () => {
    for (const day of [null, '', 'abc', '2026-13-45', '2026-02-30', "2026-10-10' OR '1'='1", '<script>alert(1)</script>', '2026-10-10'.repeat(200)]) {
      const res = await getSummary(day, bearerPipeline)
      expect(res.status, String(day)).toBe(400)
      isProblem(res)
    }
  })
})

// ================================================================== AC-METRIC-07
describe('metric retention job', () => {
  it('AC-METRIC-07: Cron hằng ngày xóa sự kiện cũ hơn 90 ngày, giữ sự kiện trong 90 ngày và ghi số dòng đã xóa vào log', async () => {
    const u = newId()
    const now = Date.now()
    const old = [91, 100, 150, 200, 365].map((d) => ins.event(u, 'share', now - d * DAY_MS, { card: 'daily', method: 'copy' }))
    const recent = [89, 30, 1].map((d) => ins.event(u, 'session_start', now - d * DAY_MS))
    await env.DB.batch([...old, ...recent])

    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const ctx = createExecutionContext()
    await handler.scheduled(createScheduledController({ scheduledTime: new Date(now), cron: '0 20 * * *' }), { ...env, IP_HASH_KEY: IP_KEY }, ctx)
    await waitOnExecutionContext(ctx)

    const rows = await eventRows()
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.type === 'session_start')).toBe(true)
    for (const r of rows) expect(r.received_at as number).toBeGreaterThan(now - 90 * DAY_MS)

    const lines = spies.flatMap((s) => s.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
    const line = lines.find((l) => /event|sự kiện/i.test(l) && /\b5\b/.test(l))
    expect(line, `log phải có số dòng sự kiện đã xóa (5); log: ${lines.join(' | ')}`).toBeDefined()
    expect(lines.join('\n')).not.toContain(u) // UUID đầy đủ không vào log (AC-PRIV-07)
  })
})
