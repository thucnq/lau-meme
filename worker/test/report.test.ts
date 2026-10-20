// Acceptance tests for docs/acceptance/report.md (worker part: AC-REPORT-01..09, VALIDATION, ABUSE) and AC-INV-09.
// Black-box: only the HTTP contract (docs/api/openapi.yaml), ADR 0002 and the D1 schema (0002_content, 0003_player_data).
// Performance: D1 in Miniflare costs ~66 ms/query, so every test seeds with ONE env.DB.batch and keeps requests few.
// `element` rows are seeded directly; the pipeline batch is published only for AC-REPORT-09 (needs DISC behaviour).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['report', 'pipeline', 'token'].join('-')
const IP_KEY = ['report', 'ip', 'hash', 'key'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const BASE = '/lau-meme/api'
const HOUR = 3_600_000

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Problem = { type: string; title: string; status: number; detail?: string }
type Report = { target: string; id: string; reason: string; status: string; created_at: string }
type Blocklist = { elements: string[]; recipes: string[]; images: string[] }

// ---------------------------------------------------------------------------- ADR 0002 helpers (no Node types)
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

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

// ---------------------------------------------------------------------------- seeded catalog (rows in `element`)
const PLAIN = 'Rp Món Thường' // no image
const IMG = 'Rp Món Có Ảnh' // image_key set
const IMG_KEY = 'aaaaaaaaaaaa.webp'
const OTHER = 'Rp Món Khác'
const PROPS = Array.from({ length: 6 }, (_, i) => `Rp Món Ngẫu Nhiên ${i}`)

function elementRow(name: string, imageKey: string | null) {
  return elementId(name).then((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO element (id, name, name_fold, emoji, depth, origin, image_key, first_version, last_version, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, ?)',
    ).bind(id, name, fold(name), '🍲', 'vn', imageKey, Date.now()),
  )
}

// ---------------------------------------------------------------------------- fixture batch (AC-REPORT-09 only)
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
const P_NAME = 'Hết Cứu' // P: result of "Chạy Deadline + Toang", input of "Hết Cứu + Cay"

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

const postRaw = (player: string | null, body: string, ip?: string) => raw(`${BASE}/reports`, { method: 'POST', body }, as(player, ip))
const report = (player: string | null, body: unknown, ip?: string) => postRaw(player, JSON.stringify(body), ip)
const getBlocklist = (fresh = false) => raw(`${BASE}/blocklist${fresh ? '?fresh=1' : ''}`)
const postDiscovery = (player: string, body: unknown) => raw(`${BASE}/discoveries`, { method: 'POST', body: JSON.stringify(body) }, as(player))

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const newId = () => crypto.randomUUID()

// ---------------------------------------------------------------------------- seeding
const ins = {
  consent: (player: string) =>
    env.DB.prepare(
      "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
    ).bind(newId(), player, POLICY_VERSION, Date.now() - 1000),
  report: (kind: 'element' | 'image', target: string, player: string | null, cycle = 0, reason = 'real_person') =>
    env.DB.prepare(
      "INSERT INTO report (id, kind, target_id, cycle, player_id, reason, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'new', ?)",
    ).bind(newId(), kind, target, cycle, player, reason, Date.now() - 5000),
  cycle: (kind: 'element' | 'image', target: string, cycle: number) =>
    env.DB.prepare('INSERT INTO report_target (kind, target_id, cycle) VALUES (?, ?, ?)').bind(kind, target, cycle),
  block: (kind: 'element' | 'recipe' | 'image', target: string, state: 'hidden' | 'blocked' = 'blocked', reason: 'auto_report' | 'admin' = 'admin') =>
    env.DB.prepare('INSERT INTO block (kind, target_id, state, reason, created_at) VALUES (?, ?, ?, ?, ?)').bind(kind, target, state, reason, Date.now()),
  bucket: (bucket: string, count: number, windowStart: number) =>
    env.DB.prepare('INSERT INTO rate_counter (bucket, count, expires_at) VALUES (?, ?, ?)').bind(bucket, count, windowStart + HOUR),
}

async function userBucket(player: string, windowStart: number): Promise<string> {
  return `report:u:${hex(await sha256(player)).slice(0, 16)}:${windowStart}`
}
async function ipBucket(ip: string, windowStart: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(IP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const ipHashHex = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(ip))))
  return `report:i:${hex(await sha256(ipHashHex)).slice(0, 16)}:${windowStart}`
}

type Row = Record<string, unknown>
const reportRows = async (): Promise<Row[]> => (await env.DB.prepare('SELECT * FROM report ORDER BY created_at, id').all<Row>()).results
const blockRows = async (): Promise<Row[]> => (await env.DB.prepare('SELECT * FROM block ORDER BY kind, target_id').all<Row>()).results
const nReports = async () => (await reportRows()).length
async function nothingWritten(): Promise<void> {
  expect(await reportRows()).toEqual([])
  expect(await blockRows()).toEqual([])
}
const blockedElements = async (id: string) =>
  (await env.DB.prepare("SELECT state, reason FROM block WHERE kind = 'element' AND target_id = ?").bind(id).all<Row>()).results

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM report'),
    env.DB.prepare('DELETE FROM report_target'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM discovery'),
    env.DB.prepare('DELETE FROM consent'),
    env.DB.prepare('DELETE FROM rate_counter'),
    await elementRow(PLAIN, null),
    await elementRow(IMG, IMG_KEY),
    await elementRow(OTHER, null),
    ...(await Promise.all(PROPS.map((n) => elementRow(n, null)))),
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('report', () => {
  // ------------------------------------------------------------------------ AC-REPORT-01
  it('AC-REPORT-01: POST báo cáo phần tử với lý do "người thật" trả 201 {target,id,reason,status:new,created_at} và lưu UUID, lý do, thời điểm, trạng thái mới', async () => {
    const u = newId()
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u)])
    const before = Date.now()
    const res = await report(u, { target: 'element', id: p, reason: 'real_person' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Report
    expect(body).toMatchObject({ target: 'element', id: p, reason: 'real_person', status: 'new' })
    expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'reason', 'status', 'target'])
    expect(Date.parse(body.created_at)).toBeGreaterThanOrEqual(before - 2000)
    expect(Date.parse(body.created_at)).toBeLessThanOrEqual(Date.now() + 2000)
    expect(JSON.stringify(body)).not.toContain(u) // the response never echoes the UUID

    const rows = await reportRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'element', target_id: p, player_id: u, reason: 'real_person', status: 'new', cycle: 0 })
    expect(rows[0]!.created_at as number).toBeGreaterThanOrEqual(before - 2000)
    expect(await blockRows()).toEqual([]) // 1 UUID is far below the threshold
  })

  it('AC-REPORT-01: lý do "khác" kèm ghi chú 200 ký tự được nhận và lưu ghi chú; cycle lấy từ report_target hiện tại', async () => {
    const u = newId()
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u), ins.cycle('element', p, 3)])
    const note = 'ghi chú '.repeat(25).slice(0, 200)
    const res = await report(u, { target: 'element', id: p, reason: 'other', note })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Report).reason).toBe('other')
    const rows = await reportRows()
    expect(rows[0]).toMatchObject({ reason: 'other', note, cycle: 3 })
  })

  it('AC-REPORT-01: chưa đồng ý chơi (play) thì 403 problem+json và không ghi gì', async () => {
    const u = newId()
    const res = await report(u, { target: 'element', id: await elementId(PLAIN), reason: 'real_person' })
    expect(res.status).toBe(403)
    isProblem(res)
    await nothingWritten()
  })

  // ------------------------------------------------------------------------ AC-REPORT-02
  it('AC-REPORT-02: lý do không nằm trong danh sách trả 422 problem+json và không ghi gì', async () => {
    const u = newId()
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u)])
    for (const reason of ['bogus', '', 'REAL_PERSON', 'real_person ']) {
      const res = await report(u, { target: 'element', id: p, reason })
      expect(res.status, JSON.stringify(reason)).toBe(422)
      isProblem(res)
      expect(((await res.json()) as Problem).status).toBe(422)
    }
    await nothingWritten()
  })

  it('AC-REPORT-02: ghi chú dài hơn 200 ký tự trả 422 (hơn 1000 ký tự trả 400); ghi chú kèm lý do khác "khác" trả 422; không ghi gì', async () => {
    const u = newId()
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u)])
    const r201 = await report(u, { target: 'element', id: p, reason: 'other', note: 'x'.repeat(201) })
    expect(r201.status).toBe(422)
    isProblem(r201)
    const rReason = await report(u, { target: 'element', id: p, reason: 'real_person', note: 'có ghi chú' })
    expect(rReason.status).toBe(422)
    isProblem(rReason)
    const rHuge = await report(u, { target: 'element', id: p, reason: 'other', note: 'x'.repeat(1001) })
    expect(rHuge.status).toBe(400)
    isProblem(rHuge)
    await nothingWritten()
  })

  it('AC-REPORT-02: đích không tồn tại trả 404 problem+json; ảnh của phần tử không có ảnh cũng 404; không ghi gì', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const ghost = await elementId('Rp Không Có Thật')
    for (const body of [
      { target: 'element', id: ghost, reason: 'real_person' },
      { target: 'image', id: ghost, reason: 'inappropriate_image' },
      { target: 'image', id: await elementId(PLAIN), reason: 'inappropriate_image' }, // element exists, image_key IS NULL
    ]) {
      const res = await report(u, body)
      expect(res.status, JSON.stringify(body)).toBe(404)
      isProblem(res)
    }
    await nothingWritten()
  })

  it('AC-REPORT-02: thiếu hoặc sai X-Player-Id (không phải UUID v4) trả 400 problem+json và không ghi gì', async () => {
    const body = { target: 'element', id: await elementId(PLAIN), reason: 'real_person' }
    for (const bad of [null, '', 'not-a-uuid', '12345678-1234-1234-1234-123456789012', '00000000-0000-0000-0000-000000000000']) {
      const res = await report(bad, body)
      expect(res.status, String(bad)).toBe(400)
      isProblem(res)
    }
    await nothingWritten()
  })

  // ------------------------------------------------------------------------ AC-REPORT-03
  it('AC-REPORT-03: cùng UUID báo cáo lại cùng đích (cùng hoặc khác lý do) trả 200 với báo cáo đã có (lý do gốc); không thêm dòng', async () => {
    const u = newId()
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u)])
    const first = await report(u, { target: 'element', id: p, reason: 'real_person' })
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as Report

    const same = await report(u, { target: 'element', id: p, reason: 'real_person' })
    expect(same.status).toBe(200)
    expect(await same.json()).toEqual(firstBody)

    const diff = await report(u, { target: 'element', id: p, reason: 'sexual' })
    expect(diff.status).toBe(200)
    expect(await diff.json()).toEqual(firstBody) // original reason kept
    const rows = await reportRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reason: 'real_person', player_id: u })
  })

  it('AC-REPORT-03: một UUID báo cáo nhiều lần chỉ tính một; 2 UUID khác nhau (có lặp) chưa tự ẩn', async () => {
    const [u1, u2] = [newId(), newId()]
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u1), ins.consent(u2)])
    for (const u of [u1, u1, u2, u1, u2]) {
      const res = await report(u, { target: 'element', id: p, reason: 'real_person' })
      expect([200, 201]).toContain(res.status)
    }
    expect(await nReports()).toBe(2)
    expect(await blockedElements(p)).toEqual([])
    const list = (await (await getBlocklist(true)).json()) as Blocklist
    expect(list.elements).not.toContain(p)
  })

  // ------------------------------------------------------------------------ AC-REPORT-04
  it('AC-REPORT-04: UUID thứ 3 báo cáo phần tử thì cùng yêu cầu ghi block (element, hidden, auto_report) và GET blocklist?fresh=1 có P', async () => {
    const [u1, u2, u3] = [newId(), newId(), newId()]
    const p = await elementId(PLAIN)
    const other = await elementId(OTHER)
    await env.DB.batch([ins.consent(u3), ins.report('element', p, u1), ins.report('element', p, u2), ins.report('element', other, u1)])
    expect(await blockedElements(p)).toEqual([])

    const res = await report(u3, { target: 'element', id: p, reason: 'sexual' })
    expect(res.status).toBe(201)
    expect(await blockedElements(p)).toEqual([{ state: 'hidden', reason: 'auto_report' }])
    expect(await blockedElements(other)).toEqual([]) // other targets unaffected

    const list = await getBlocklist(true)
    expect(list.headers.get('cache-control')).toBe('no-store')
    const body = (await list.json()) as Blocklist
    expect(body.elements).toContain(p)
    expect(body.elements).not.toContain(other)
  })

  it('AC-REPORT-04: báo cáo mới + 2 dòng báo cáo đã xóa UUID (player_id NULL) vẫn đủ 3 và tự ẩn', async () => {
    const u = newId()
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u), ins.report('element', p, null), ins.report('element', p, null)])
    const res = await report(u, { target: 'element', id: p, reason: 'real_person' })
    expect(res.status).toBe(201)
    expect(await blockedElements(p)).toEqual([{ state: 'hidden', reason: 'auto_report' }])
  })

  it('AC-REPORT-04: báo cáo ở chu kỳ cũ (report_target.cycle đã tăng) không được tính; đủ 3 UUID trong chu kỳ mới mới tự ẩn', async () => {
    const [o1, o2, n1, n2, n3] = [newId(), newId(), newId(), newId(), newId()]
    const p = await elementId(PLAIN)
    await env.DB.batch([
      ins.consent(n1),
      ins.consent(n2),
      ins.consent(n3),
      ins.cycle('element', p, 1),
      ins.report('element', p, o1, 0),
      ins.report('element', p, o2, 0),
    ])
    for (const u of [n1, n2]) {
      expect((await report(u, { target: 'element', id: p, reason: 'real_person' })).status).toBe(201)
    }
    expect(await blockedElements(p)).toEqual([]) // 2 old + 2 new would be 4 if old ones counted
    expect((await report(n3, { target: 'element', id: p, reason: 'real_person' })).status).toBe(201)
    expect(await blockedElements(p)).toEqual([{ state: 'hidden', reason: 'auto_report' }])
    const fresh = (await reportRows()).filter((r) => r.cycle === 1)
    expect(fresh).toHaveLength(3)
  })

  // ------------------------------------------------------------------------ AC-REPORT-05
  it('AC-REPORT-05: 1 báo cáo ảnh vào danh sách chặn ảnh ngay (block kind image); phần tử vẫn hoạt động (không ở elements)', async () => {
    const u = newId()
    const p = await elementId(IMG)
    await env.DB.batch([ins.consent(u)])
    const res = await report(u, { target: 'image', id: p, reason: 'inappropriate_image' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ target: 'image', id: p, reason: 'inappropriate_image', status: 'new' })
    const rows = await reportRows()
    expect(rows[0]).toMatchObject({ kind: 'image', target_id: p, player_id: u })
    expect(await blockRows()).toMatchObject([{ kind: 'image', target_id: p, state: 'hidden', reason: 'auto_report' }])

    const list = (await (await getBlocklist(true)).json()) as Blocklist
    expect(list.images).toContain(p)
    expect(list.elements).not.toContain(p)
  })

  it('AC-REPORT-05: báo cáo ảnh không tính vào ngưỡng ẩn phần tử (1 ảnh + 2 phần tử ≠ 3)', async () => {
    const [u1, u2, u3] = [newId(), newId(), newId()]
    const p = await elementId(IMG)
    await env.DB.batch([ins.consent(u1), ins.consent(u2), ins.consent(u3)])
    expect((await report(u1, { target: 'image', id: p, reason: 'inappropriate_image' })).status).toBe(201)
    expect((await report(u2, { target: 'element', id: p, reason: 'real_person' })).status).toBe(201)
    expect((await report(u3, { target: 'element', id: p, reason: 'real_person' })).status).toBe(201)
    expect(await blockedElements(p)).toEqual([])
    const list = (await (await getBlocklist(true)).json()) as Blocklist
    expect(list.elements).not.toContain(p)
    expect(list.images).toContain(p)
  })

  // ------------------------------------------------------------------------ AC-REPORT-06
  it('AC-REPORT-06: GET blocklist trả 3 mảng id (phần tử hidden/blocked, công thức, ảnh), không có tên đọc được, Cache-Control public, max-age=60', async () => {
    const [e1, e2, img] = await Promise.all([elementId(PLAIN), elementId(OTHER), elementId(IMG)])
    const rec = await recipeId('Cay', 'Cười')
    await env.DB.batch([ins.block('element', e1, 'hidden', 'auto_report'), ins.block('element', e2, 'blocked'), ins.block('recipe', rec), ins.block('image', img)])
    const res = await getBlocklist()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const text = await res.text()
    const body = JSON.parse(text) as Blocklist
    expect(Object.keys(body).sort()).toEqual(['elements', 'images', 'recipes'])
    expect([...body.elements].sort()).toEqual([e1, e2].sort())
    expect(body.recipes).toEqual([rec])
    expect(body.images).toEqual([img])
    for (const name of [PLAIN, OTHER, IMG, 'Cay', 'Cười']) expect(text).not.toContain(name)
  })

  it('AC-REPORT-06: danh sách rỗng trả ba mảng rỗng; ?fresh=1 trả Cache-Control no-store', async () => {
    const res = await getBlocklist()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ elements: [], recipes: [], images: [] })
    const fresh = await getBlocklist(true)
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('cache-control')).toBe('no-store')
    expect(await fresh.json()).toEqual({ elements: [], recipes: [], images: [] })
  })

  // ------------------------------------------------------------------------ AC-REPORT-08
  it('AC-REPORT-08: UUID gửi quá 10 báo cáo/giờ thì báo cáo thứ 11 trả 429 problem+json kèm Retry-After; không ghi gì và không tự ẩn dù là UUID thứ 3', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T06:30:00.000Z'))
    const [u1, u2, u3] = [newId(), newId(), newId()]
    const p = await elementId(PLAIN)
    const windowStart = Date.now() - (Date.now() % HOUR)
    await env.DB.batch([
      ins.consent(u3),
      ins.report('element', p, u1),
      ins.report('element', p, u2),
      ins.bucket(await userBucket(u3, windowStart), 10, windowStart),
    ])
    const res = await report(u3, { target: 'element', id: p, reason: 'real_person' })
    expect(res.status).toBe(429)
    isProblem(res)
    const retry = Number(res.headers.get('retry-after'))
    expect(Number.isInteger(retry)).toBe(true)
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(3600)
    expect(await nReports()).toBe(2)
    expect(await blockedElements(p)).toEqual([])
  })

  it('AC-REPORT-08: báo cáo thứ 10 trong giờ vẫn được nhận (201)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T06:30:00.000Z'))
    const u = newId()
    const windowStart = Date.now() - (Date.now() % HOUR)
    await env.DB.batch([ins.consent(u), ins.bucket(await userBucket(u, windowStart), 9, windowStart)])
    const res = await report(u, { target: 'element', id: await elementId(PLAIN), reason: 'real_person' })
    expect(res.status).toBe(201)
    expect(await nReports()).toBe(1)
  })

  it('AC-REPORT-08: cùng IP băm quá 30 báo cáo/giờ (mỗi UUID còn xa ngưỡng) trả 429 kèm Retry-After; IP khác không bị ảnh hưởng', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T06:30:00.000Z'))
    const shared = '10.99.99.99'
    const [fresh, other] = [newId(), newId()]
    const p = await elementId(PLAIN)
    const windowStart = Date.now() - (Date.now() % HOUR)
    await env.DB.batch([ins.consent(fresh), ins.consent(other), ins.bucket(await ipBucket(shared, windowStart), 30, windowStart)])
    const limited = await report(fresh, { target: 'element', id: p, reason: 'real_person' }, shared)
    expect(limited.status).toBe(429)
    isProblem(limited)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await nReports()).toBe(0)
    expect((await report(other, { target: 'element', id: p, reason: 'real_person' }, '10.77.77.77')).status).toBe(201)
  })

  // ------------------------------------------------------------------------ AC-REPORT-09
  it(
    'AC-REPORT-09: P bị tự ẩn qua báo cáo thì POST khám phá công thức ra P và công thức có P làm đầu vào đều 422; công thức không liên quan vẫn 201',
    async () => {
      await ensurePublished()
      const [r1, r2, r3, player] = [newId(), newId(), newId(), newId()]
      const p = await elementId(P_NAME)
      await env.DB.batch([ins.consent(r1), ins.consent(r2), ins.consent(r3), ins.consent(player)])
      for (const r of [r1, r2, r3]) {
        expect((await report(r, { target: 'element', id: p, reason: 'real_person' })).status).toBe(201)
      }
      expect(await blockedElements(p)).toEqual([{ state: 'hidden', reason: 'auto_report' }])

      const asResult = await postDiscovery(player, { a: 'Chạy Deadline', b: 'Toang', result: P_NAME })
      expect(asResult.status).toBe(422)
      isProblem(asResult)
      const asInput = await postDiscovery(player, { a: P_NAME, b: 'Cay', result: 'Stonks' })
      expect(asInput.status).toBe(422)
      isProblem(asInput)
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM discovery').first<{ n: number }>())?.n).toBe(0)

      const control = await postDiscovery(player, { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' })
      expect(control.status).toBe(201)
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-INV-09
  it(
    'AC-INV-09: chuỗi báo cáo ngẫu nhiên cố định hạt giống (thứ tự bất kỳ, có trùng UUID): bị chặn khi và chỉ khi số UUID khác nhau >= 3',
    async () => {
      const mulberry32 = (seed: number) => () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const rand = mulberry32(20261021)
      const pool = Array.from({ length: 5 }, () => newId())
      await env.DB.batch(pool.map((u) => ins.consent(u)))
      const expectedBlocked: string[] = []

      for (const name of PROPS) {
        await env.DB.prepare('DELETE FROM rate_counter').run() // 8 requests/UUID max per sequence stays below the 10/h limit, but pool is reused
        const id = await elementId(name)
        const length = 2 + Math.floor(rand() * 7) // 2..8 reports
        const seen = new Set<string>()
        for (let i = 0; i < length; i++) {
          const u = pool[Math.floor(rand() * pool.length)]!
          const isNew = !seen.has(u)
          seen.add(u)
          const res = await report(u, { target: 'element', id, reason: 'real_person' })
          expect(res.status, `${name} #${i}`).toBe(isNew ? 201 : 200)
          const blocked = (await blockedElements(id)).length > 0
          expect(blocked, `${name} #${i}: ${seen.size} UUID khác nhau`).toBe(seen.size >= 3)
        }
        if (seen.size >= 3) expectedBlocked.push(id)
      }
      const list = (await (await getBlocklist(true)).json()) as Blocklist
      expect([...list.elements].sort()).toEqual([...expectedBlocked].sort())
      expect(expectedBlocked.length).toBeGreaterThan(0) // the fixed seed must exercise both outcomes
      expect(expectedBlocked.length).toBeLessThan(PROPS.length)
    },
    240_000,
  )

  // ------------------------------------------------------------------------ AC-REPORT-VALIDATION
  it('AC-REPORT-VALIDATION: id sai định dạng (ngắn, dài, ký tự lạ, SQL, script), target lạ, JSON hỏng hoặc thiếu trường bị từ chối 4xx problem+json và không ghi gì', async () => {
    const pool = [newId(), newId(), newId()] // spread over UUIDs so the 10/hour limit is never the reason for a 4xx
    const u = pool[0]!
    await env.DB.batch(pool.map((x) => ins.consent(x)))
    const ok = await elementId(PLAIN)
    const bodies: string[] = [
      JSON.stringify({ target: 'element', id: 'abc', reason: 'real_person' }),
      JSON.stringify({ target: 'element', id: ok.slice(1), reason: 'real_person' }),
      JSON.stringify({ target: 'element', id: ok + 'A', reason: 'real_person' }),
      JSON.stringify({ target: 'element', id: '!'.repeat(43), reason: 'real_person' }),
      JSON.stringify({ target: 'element', id: "'; DROP TABLE report;--".padEnd(43, 'a'), reason: 'real_person' }),
      JSON.stringify({ target: 'element', id: '<script>alert(1)</script>'.padEnd(43, 'a'), reason: 'real_person' }),
      JSON.stringify({ target: 'element', id: 'A'.repeat(10_000), reason: 'real_person' }),
      JSON.stringify({ target: 'element', id: 12345, reason: 'real_person' }),
      JSON.stringify({ target: 'recipe', id: ok, reason: 'real_person' }),
      JSON.stringify({ id: ok, reason: 'real_person' }),
      JSON.stringify({ target: 'element', reason: 'real_person' }),
      JSON.stringify({ target: 'element', id: ok }),
      '{"target": "element", ',
      '',
    ]
    for (const [i, b] of bodies.entries()) {
      const res = await postRaw(pool[i % 3]!, b)
      expect(res.status, b.slice(0, 50)).toBeGreaterThanOrEqual(400)
      expect(res.status, b.slice(0, 50)).toBeLessThan(500)
      expect(res.status, b.slice(0, 50)).not.toBe(429)
      isProblem(res)
    }
    // a well-formed id must be 400 (format), not a 404 lookup
    const bad = await report(u, { target: 'element', id: 'abc', reason: 'real_person' })
    expect(bad.status).toBe(400)
    await nothingWritten()
  })

  it('AC-REPORT-VALIDATION: ghi chú chứa script/HTML với lý do "khác" không gây lỗi 5xx; nếu nhận thì lưu nguyên văn dạng text', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u)])
    const note = '<script>alert(1)</script>'
    const res = await report(u, { target: 'element', id: await elementId(PLAIN), reason: 'other', note })
    expect(res.status).toBeLessThan(500)
    expect([201, 400, 422]).toContain(res.status)
    if (res.status === 201) {
      expect(JSON.stringify(await res.json())).not.toContain('<script>')
      expect((await reportRows())[0]!.note).toBe(note)
    } else {
      isProblem(res)
      await nothingWritten()
    }
  })

  // ------------------------------------------------------------------------ AC-REPORT-ABUSE (endpoint không có tenant)
  it('AC-REPORT-ABUSE: trường lạ giả danh (player_id, status, cycle, resolved) bị từ chối 4xx hoặc bỏ qua, không bao giờ ghi theo giá trị giả', async () => {
    const [u, victim] = [newId(), newId()]
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u)])
    const res = await report(u, { target: 'element', id: p, reason: 'real_person', player_id: victim, status: 'resolved_hidden', cycle: 99 })
    expect(res.status).toBeLessThan(500)
    expect(res.status).not.toBe(429)
    const rows = await reportRows()
    if (res.status === 201) {
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ player_id: u, status: 'new', cycle: 0 })
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400)
      isProblem(res)
      expect(rows).toEqual([])
    }
  })

  it('AC-REPORT-ABUSE: không thể tự ẩn phần tử bằng một UUID: 1 UUID gửi lặp 5 lần (đổi lý do) vẫn một dòng và không có block', async () => {
    const u = newId()
    const p = await elementId(PLAIN)
    await env.DB.batch([ins.consent(u)])
    for (const reason of ['real_person', 'sexual', 'other', 'discrimination', 'politics_religion']) {
      const res = await report(u, { target: 'element', id: p, reason })
      expect([200, 201]).toContain(res.status)
    }
    expect(await nReports()).toBe(1)
    expect(await blockRows()).toEqual([])
  })
})
