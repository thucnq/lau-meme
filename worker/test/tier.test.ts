// Phủ (cập nhật 2026-10-24, ADR 0016, migration 0008 `element.auto_tier`):
//   AC-ADMIN-12  PUT /admin/elements/{id}/tier: {tier 1..5 | "auto"}, phản hồi {element_id, before, after, before_source,
//                after_source}, audit set_tier {tier, source}, 409 "Món Vàng/Đỏ cần có ảnh trước", 400, 404, 401, lọc theo tier
//   AC-TIER-01   /pipeline/state.tiers chỉ gồm tier admin đã gán
//   AC-TIER-04   (phía Worker) đăng mẻ có content.elements[].auto_tier thì lưu vào element.auto_tier; GET /admin/elements
//                trả tier hiệu lực, tier_source, auto_tier; lọc ?tier=N theo tier hiệu lực
//   AC-TIER-05   admin gán thắng tier tự động qua các mẻ sau; "auto" trả về tier tự động; audit kể cả đổi về "auto"
//   AC-TIER-VALIDATION, AC-TIER-ABUSE
// Black-box: docs/api/openapi.yaml (PUT /admin/elements/{id}/tier, GET /admin/elements?tier=, GET /admin/audit,
// GET /pipeline/state `tiers`, POST /pipeline/batches), ADR 0002 ids và migrations 0002_content, 0004_ops, 0007_contrib_tier,
// 0008_account_plate_auto_tier.
// Performance: D1 in Miniflare costs ~66 ms/query, so every test seeds with ONE env.DB.batch and keeps requests few.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['tier', 'test', 'token', 'ok'].join('-')
const WRONG = ['tier', 'test', 'token', 'no'].join('-')
const PIPELINE_TOKEN = ['tier', 'pipeline', 'token'].join('-')
const IP_KEY = ['tier', 'ip', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_ORIGIN = 'https://dinoduct.fun'
const GAME_API = `${GAME_ORIGIN}/lau-meme/api`

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Row = Record<string, unknown>
type Page<T> = { page: number; size: number; total: number; items: T[] }
type ElementItem = { id: string; name: string; emoji: string; depth: number; state: string; image_key: string | null; image_state: string; last_version: number; tier: number; tier_source: 'admin' | 'auto'; auto_tier: number | null }
type TierResult = { element_id: string; before: number; after: number; before_source: 'admin' | 'auto'; after_source: 'admin' | 'auto' }
type AuditItem = { action: string; target_kind: string; target_id: string; before: unknown; after: unknown; reason: string | null; token_fp: string; created_at: string }
type TierState = { tiers: Array<{ element_id: string; tier: number }> }

// ---------------------------------------------------------------------------- ADR 0002 helpers
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

// ---------------------------------------------------------------------------- seeded catalog
const P = 'Tr Món Một'
const Q = 'Tr Món Hai'
const R = 'Tr Món Ba'
const S = 'Tr Món Bốn' // không có ảnh (image_key NULL)
const T = 'Tr Món Năm' // có ảnh nhưng ảnh bị chặn
const NAMES = [P, Q, R]
const IMG = '0123456789ab.webp'

// P, Q, R, T có ảnh (được lên Vàng/Đỏ); S không có ảnh.
const elementRow = (name: string, imageKey: string | null = IMG) =>
  elementId(name).then((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO element (id, name, name_fold, emoji, depth, origin, image_key, first_version, last_version, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, ?)',
    ).bind(id, name, fold(name), '🍲', 'vn', imageKey, Date.now()),
  )

// Đăng một mẻ `core` tối thiểu mang auto_tier cho từng phần tử (xem pipeline.test.ts cho dạng thân).
async function publishWith(version: number, autos: Record<string, number | undefined>, extra: Record<string, unknown> = {}): Promise<Response> {
  const starterNames = ['Cay', 'Cười', 'Toang', 'Deadline']
  const starters = await Promise.all(starterNames.map(elementId))
  const batchAt = '2026-10-20T05:30:00.000Z'
  const [x, y] = [starters[0]!, starters[1]!].sort()
  const target = await elementId(P)
  const elems = await Promise.all(
    Object.entries(autos).map(async ([name, auto]) => ({
      id: await elementId(name),
      name,
      fold: fold(name),
      emoji: '🍲',
      depth: 4, // = manifest.daily.depth (Worker kiểm hai số bằng nhau)
      ...(auto === undefined ? {} : { auto_tier: auto }),
      ...extra,
    })),
  )
  const body = {
    status: 'success',
    version,
    batch_at: batchAt,
    mode: 'core',
    manifest: {
      version,
      batch_at: batchAt,
      graph_url: `/api/graph/${version}`,
      starters: starters.map((id, i) => ({ id, name: starterNames[i], emoji: '🔥' })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: target, emoji: '🍲', hint: 'Món cay cay', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await elementId(`g|${version}`)]: 'abc' } },
    content: {
      elements: [
        ...starters.map((id, i) => ({ id, name: starterNames[i]!, fold: fold(starterNames[i]!), emoji: '🔥', depth: 0 })),
        ...elems,
      ],
      recipes: [{ id: await recipeId('Cay', 'Cười'), a: x, b: y, result: target }],
      starters,
      daily_element_id: target,
    },
    stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
  }
  const res = await raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) }, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
  if (res.status === 201) {
    // mẻ không mang ảnh; trả lại ảnh cho P, Q, R để các test gán Vàng/Đỏ không gặp 409 vì thiếu ảnh
    await env.DB.prepare('UPDATE element SET image_key = ? WHERE id IN (?, ?, ?)').bind(IMG, ...(await Promise.all(NAMES.map(elementId)))).run()
  }
  return res
}

// ---------------------------------------------------------------------------- HTTP helpers
async function raw(url: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(url, { ...init, headers: h }),
    { ...env, ADMIN_TOKEN: TOKEN, PIPELINE_TOKEN, IP_HASH_KEY: IP_KEY },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

let ipCounter = 0
const nextIp = () => {
  ipCounter++
  return `10.30.${ipCounter >> 8}.${ipCounter & 255}`
}

type AOpts = { method?: string; body?: unknown; auth?: string | null; ip?: string; headers?: Record<string, string> }
function A(path: string, o: AOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': o.ip ?? nextIp(), ...(o.headers ?? {}) }
  const auth = o.auth === undefined ? `Bearer ${TOKEN}` : o.auth
  if (auth !== null) headers.Authorization = auth
  const hasBody = o.body !== undefined
  const init: RequestInit = { method: o.method ?? (hasBody ? 'POST' : 'GET') }
  if (hasBody) init.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
  return raw(`${ADMIN_ORIGIN}/api/admin${path}`, init, headers)
}
const putTier = (id: string, body: unknown, extra: AOpts = {}) => A(`/elements/${id}/tier`, { method: 'PUT', body, ...extra })
const getPipelineState = () => raw(`${GAME_API}/pipeline/state`, {}, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const json = async <T>(res: Response) => (await res.json()) as T

// ---------------------------------------------------------------------------- DB probes
const changeRows = async (): Promise<Row[]> => (await env.DB.prepare('SELECT * FROM admin_change ORDER BY created_at, id').all<Row>()).results
const tierRows = async (): Promise<Row[]> => (await env.DB.prepare('SELECT element_id, tier FROM element_tier ORDER BY element_id').all<Row>()).results
const countAudit = async (): Promise<number> => (await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit').first<{ n: number }>())!.n
const stateTiers = async () => (await json<TierState>(await getPipelineState())).tiers

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_change'),
    env.DB.prepare('DELETE FROM element_tier'),
    env.DB.prepare('DELETE FROM admin_audit'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM rate_counter'),
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
    ...(await Promise.all(NAMES.map((n) => elementRow(n)))),
    await elementRow(S, null),
    await elementRow(T),
  ])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('tier (worker)', () => {
  // ------------------------------------------------------------------------ AC-ADMIN-12
  it(
    'AC-ADMIN-12: đặt tier P = 4 trả 200 {element_id, before 1 (auto), after 4 (admin)}, ghi đúng 1 dòng audit set_tier (trước {1, auto}, sau {4, admin}) có dấu vân token, hiện trong /audit, trong /pipeline/state.tiers và trong danh mục',
    async () => {
      const p = await elementId(P)
      const fp = hex(await sha256(TOKEN)).slice(0, 8)
      expect(await stateTiers()).toEqual([]) // chưa gán thì không có dòng nào (mặc định 1)

      const res = await putTier(p, { tier: 4 })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ element_id: p, before: 1, after: 4, before_source: 'auto', after_source: 'admin' })

      expect(await tierRows()).toEqual([{ element_id: p, tier: 4 }])
      const rows = await changeRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ action: 'set_tier', target_kind: 'element', target_id: p, token_fp: fp })
      expect(JSON.parse(rows[0]!.before_json as string)).toEqual({ tier: 1, source: 'auto' })
      expect(JSON.parse(rows[0]!.after_json as string)).toEqual({ tier: 4, source: 'admin' })
      expect(await countAudit()).toBe(0) // set_tier nằm ở admin_change, không phải admin_audit

      const audit = await json<Page<AuditItem>>(await A('/audit'))
      expect(audit.total).toBe(1)
      expect(audit.items[0]).toMatchObject({ action: 'set_tier', target_kind: 'element', target_id: p, before: { tier: 1, source: 'auto' }, after: { tier: 4, source: 'admin' }, token_fp: fp })
      expect(Math.abs(Date.parse(audit.items[0]!.created_at) - Date.now())).toBeLessThan(5 * 60_000)

      expect(await stateTiers()).toEqual([{ element_id: p, tier: 4 }])

      const list = await json<Page<ElementItem>>(await A(`/elements?q=${encodeURIComponent(fold(P))}`))
      expect(list.items.find((i) => i.id === p)).toMatchObject({ tier: 4, tier_source: 'admin', auto_tier: null })
    },
    60_000,
  )

  it(
    'AC-ADMIN-12: đổi tiếp 4 -> 2 ghi thêm 1 dòng audit (trước 4, sau 2); đặt đúng tier hiện tại vẫn 200 và vẫn ghi 1 dòng audit; audit gộp với kiểm duyệt, mới nhất trước',
    async () => {
      const [p, q] = [await elementId(P), await elementId(Q)]
      expect((await putTier(p, { tier: 4 })).status).toBe(200)
      const again = await putTier(p, { tier: 2 })
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual({ element_id: p, before: 4, after: 2, before_source: 'admin', after_source: 'admin' })
      const same = await putTier(p, { tier: 2 })
      expect(same.status).toBe(200)
      expect(await same.json()).toEqual({ element_id: p, before: 2, after: 2, before_source: 'admin', after_source: 'admin' })
      expect((await A('/moderation', { body: { target_kind: 'element', target_id: q, action: 'hide' } })).status).toBe(200)

      expect(await changeRows()).toHaveLength(3)
      expect(await tierRows()).toEqual([{ element_id: p, tier: 2 }])
      const audit = await json<Page<AuditItem>>(await A('/audit'))
      expect(audit.total).toBe(4)
      expect(audit.items.map((i) => i.action)).toEqual(['hide', 'set_tier', 'set_tier', 'set_tier'])
      const times = audit.items.map((i) => Date.parse(i.created_at))
      expect(times).toEqual([...times].sort((x, y) => y - x))
      expect(audit.items.slice(1).map((i) => [i.before, i.after])).toEqual([
        [{ tier: 2, source: 'admin' }, { tier: 2, source: 'admin' }],
        [{ tier: 4, source: 'admin' }, { tier: 2, source: 'admin' }],
        [{ tier: 1, source: 'auto' }, { tier: 4, source: 'admin' }],
      ])
    },
    60_000,
  )

  it(
    'AC-ADMIN-12: tier 0, 6, âm, số lẻ, chuỗi, null, thiếu trường, trường lạ, JSON hỏng trả 400 problem+json, không ghi audit, không đổi tier',
    async () => {
      const p = await elementId(P)
      expect((await putTier(p, { tier: 3 })).status).toBe(200)
      const before = (await changeRows()).length
      const bad: unknown[] = [
        { tier: 0 },
        { tier: 6 },
        { tier: -1 },
        { tier: 2.5 },
        { tier: 1_000_000_000_000 },
        { tier: '4' },
        { tier: 'vàng' },
        { tier: '<script>alert(1)</script>' },
        { tier: null },
        { tier: true },
        { tier: [4] },
        { tier: 'Auto' },
        { tier: 'AUTO' },
        { tier: ' auto' },
        { tier: 'auto ' },
        { tier: { value: 'auto' } },
        {},
        { tier: 4, extra: 1 },
        [],
        null,
        '{"tier": ',
        '',
      ]
      for (const b of bad) {
        const res = await putTier(p, b)
        const label = (typeof b === 'string' ? b : JSON.stringify(b)).slice(0, 60)
        expect(res.status, label).toBe(400)
        isProblem(res)
      }
      expect(await changeRows()).toHaveLength(before)
      expect(await tierRows()).toEqual([{ element_id: p, tier: 3 }])
      expect(await countAudit()).toBe(0)
    },
    120_000,
  )

  it('AC-ADMIN-12: phần tử không tồn tại trả 404 problem+json, không ghi audit, không tạo dòng tier', async () => {
    const ghost = await elementId('Tr Không Có Thật')
    const res = await putTier(ghost, { tier: 4 })
    expect(res.status).toBe(404)
    isProblem(res)
    expect(await changeRows()).toEqual([])
    expect(await tierRows()).toEqual([])
    expect(await stateTiers()).toEqual([])
  })

  it(
    'AC-ADMIN-12: mục "Nội dung" hiện tier hiện tại của từng phần tử (chưa gán = 1) và lọc được theo tier; tier lạ trong bộ lọc trả 400',
    async () => {
      const [p, q, r] = (await Promise.all(NAMES.map(elementId))) as [string, string, string]
      expect((await putTier(p, { tier: 4 })).status).toBe(200)
      expect((await putTier(q, { tier: 5 })).status).toBe(200)

      const all = await json<Page<ElementItem>>(await A('/elements?size=100'))
      const byId = new Map(all.items.map((i) => [i.id, i]))
      expect([byId.get(p)?.tier, byId.get(q)?.tier, byId.get(r)?.tier]).toEqual([4, 5, 1])
      expect(all.items.every((i) => Number.isInteger(i.tier) && i.tier >= 1 && i.tier <= 5)).toBe(true)

      const four = await json<Page<ElementItem>>(await A('/elements?tier=4&size=100'))
      expect(four.items.map((i) => i.id)).toEqual([p])
      expect(four.total).toBe(1)
      const five = await json<Page<ElementItem>>(await A('/elements?tier=5&size=100'))
      expect(five.items.map((i) => i.id)).toEqual([q])
      const one = await json<Page<ElementItem>>(await A('/elements?tier=1&size=100'))
      const oneIds = one.items.map((i) => i.id)
      expect(oneIds).toContain(r)
      expect(oneIds).not.toContain(p)
      expect(oneIds).not.toContain(q)
      expect(one.items.every((i) => i.tier === 1)).toBe(true)
      const three = await json<Page<ElementItem>>(await A('/elements?tier=3&size=100'))
      expect(three).toMatchObject({ total: 0, items: [] })

      for (const t of ['0', '6', 'abc', '-1', '2.5']) {
        const res = await A(`/elements?tier=${t}`)
        expect(res.status, t).toBe(400)
        isProblem(res)
      }
    },
    60_000,
  )

  it('AC-ADMIN-12: thiếu token, token sai, sai sơ đồ trả 401; trên host game /lau-meme/api/admin/... trả 404; không đổi gì', async () => {
    const p = await elementId(P)
    for (const auth of [null, `Bearer ${WRONG}`, `Basic ${btoa(`admin:${TOKEN}`)}`]) {
      const res = await putTier(p, { tier: 5 }, { auth })
      expect(res.status, String(auth)).toBe(401)
      isProblem(res)
    }
    const onGameHost = await raw(
      `${GAME_API}/admin/elements/${p}/tier`,
      { method: 'PUT', body: JSON.stringify({ tier: 5 }) },
      { Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': nextIp() },
    )
    expect(onGameHost.status).toBe(404)
    expect(await tierRows()).toEqual([])
    expect(await changeRows()).toEqual([])
  })

  // ------------------------------------------------------------------------ AC-TIER-01 (worker side: pipeline reads tiers)
  it(
    'AC-TIER-01: /pipeline/state.tiers chỉ gồm phần tử admin đã gán, tier giữ nguyên qua các lần đọc; cần PIPELINE_TOKEN',
    async () => {
      const [p, q] = await Promise.all([elementId(P), elementId(Q)])
      expect((await putTier(p, { tier: 4 })).status).toBe(200)
      expect((await putTier(q, { tier: 2 })).status).toBe(200)
      const first = [...(await stateTiers())].sort((a, b) => a.element_id.localeCompare(b.element_id))
      const want = [
        { element_id: p, tier: 4 },
        { element_id: q, tier: 2 },
      ].sort((a, b) => a.element_id.localeCompare(b.element_id))
      expect(first).toEqual(want)
      expect([...(await stateTiers())].sort((a, b) => a.element_id.localeCompare(b.element_id))).toEqual(want)

      const noAuth = await raw(`${GAME_API}/pipeline/state`, {}, { 'CF-Connecting-IP': nextIp() })
      expect(noAuth.status).toBe(401)
      const wrong = await raw(`${GAME_API}/pipeline/state`, {}, { Authorization: `Bearer ${WRONG}`, 'CF-Connecting-IP': nextIp() })
      expect(wrong.status).toBe(401)
      expect(await wrong.text()).not.toContain(p)
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-TIER-VALIDATION
  it(
    'AC-TIER-VALIDATION: id đường dẫn sai định dạng (ngắn, dài 10000, script, SQL, id công thức) không đổi gì và không bao giờ trả 200; tier tràn số không lưu',
    async () => {
      const p = await elementId(P)
      const ids = ['abc', 'A'.repeat(10_000), encodeURIComponent('<script>alert(1)</script>'.padEnd(43, 'a')), encodeURIComponent("'; DROP TABLE element_tier;--".padEnd(43, 'a')), p + 'A', p.slice(1)]
      for (const id of ids) {
        const res = await putTier(id, { tier: 4 })
        expect([400, 404], id.slice(0, 40)).toContain(res.status)
        isProblem(res)
      }
      const huge = await putTier(p, { tier: Number.MAX_SAFE_INTEGER })
      expect(huge.status).toBe(400)
      isProblem(huge)
      expect(await tierRows()).toEqual([])
      expect(await changeRows()).toEqual([])
      expect(await countAudit()).toBe(0)
    },
    120_000,
  )

  // ------------------------------------------------------------------------ AC-TIER-ABUSE (endpoint quản trị không có tenant)
  it('AC-TIER-ABUSE: id công thức dùng như phần tử trả 404; giả header (X-Admin, X-Forwarded-For, X-Player-Id) không né xác thực; không đổi gì', async () => {
    const rid = await recipeId(P, Q)
    expect((await putTier(rid, { tier: 5 })).status).toBe(404)
    const spoof = { 'X-Admin': 'true', 'X-Forwarded-For': '1.2.3.4', 'X-Player-Id': crypto.randomUUID(), 'X-Real-IP': '9.9.9.9' }
    expect((await putTier(await elementId(P), { tier: 5 }, { auth: null, headers: spoof })).status).toBe(401)
    for (const near of [`${TOKEN}x`, TOKEN.slice(0, -1), TOKEN.toUpperCase()]) {
      expect((await putTier(await elementId(P), { tier: 5 }, { auth: `Bearer ${near}` })).status).toBe(401)
    }
    expect(await tierRows()).toEqual([])
    expect(await changeRows()).toEqual([])
  })

  // ------------------------------------------------------------------------ AC-ADMIN-12: 409 Vàng/Đỏ cần ảnh
  it(
    'AC-ADMIN-12: tier 4 hoặc 5 cho phần tử chưa có ảnh trả 409 problem+json "Món Vàng/Đỏ cần có ảnh trước", không audit, không dòng tier; tier 1-3 và "auto" vẫn được',
    async () => {
      const s = await elementId(S)
      for (const t of [4, 5]) {
        const res = await putTier(s, { tier: t })
        expect(res.status, String(t)).toBe(409)
        isProblem(res)
        expect(((await res.json()) as { title: string }).title).toBe('Món Vàng/Đỏ cần có ảnh trước')
      }
      expect(await tierRows()).toEqual([])
      expect(await changeRows()).toEqual([])
      const ok = await putTier(s, { tier: 3 })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ element_id: s, before: 1, after: 3, before_source: 'auto', after_source: 'admin' })
      const back = await putTier(s, { tier: 'auto' })
      expect(back.status).toBe(200)
      expect(await tierRows()).toEqual([])
      expect(await changeRows()).toHaveLength(2)
    },
    60_000,
  )

  it(
    'AC-ADMIN-12: phần tử có ảnh nhưng ảnh bị chặn (block kind image) cũng 409 cho tier 4/5; sai thứ tự kiểm: id lạ vẫn 404 trước',
    async () => {
      const t = await elementId(T)
      await env.DB.prepare("INSERT INTO block (kind, target_id, state, reason, created_at) VALUES ('image', ?, 'blocked', 'admin', ?)").bind(t, Date.now()).run()
      for (const v of [4, 5]) {
        const res = await putTier(t, { tier: v })
        expect(res.status, String(v)).toBe(409)
        isProblem(res)
      }
      expect(await tierRows()).toEqual([])
      expect(await changeRows()).toEqual([])
      expect((await putTier(await elementId('Tr Không Có Thật'), { tier: 5 })).status).toBe(404)
      expect((await putTier(t, { tier: 2 })).status).toBe(200)
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-ADMIN-12 / AC-TIER-05: "auto"
  it(
    'AC-ADMIN-12: {tier: "auto"} xóa dòng element_tier, trả after = auto_tier (null -> 1) với after_source auto, ghi audit {tier, source}; chọn "auto" khi đã là auto vẫn 200 và vẫn ghi audit',
    async () => {
      const p = await elementId(P)
      const q = await elementId(Q)
      expect((await publishWith(1, { [P]: 2, [Q]: undefined })).status).toBe(201)
      expect((await putTier(p, { tier: 5 })).status).toBe(200)
      expect(await tierRows()).toEqual([{ element_id: p, tier: 5 }])

      const res = await putTier(p, { tier: 'auto' })
      expect(res.status).toBe(200)
      expect(await json<TierResult>(res)).toEqual({ element_id: p, before: 5, after: 2, before_source: 'admin', after_source: 'auto' })
      expect(await tierRows()).toEqual([])
      expect(await stateTiers()).toEqual([])

      const noAuto = await putTier(q, { tier: 'auto' }) // auto_tier null -> 1, đã là auto
      expect(noAuto.status).toBe(200)
      expect(await json<TierResult>(noAuto)).toEqual({ element_id: q, before: 1, after: 1, before_source: 'auto', after_source: 'auto' })

      const rows = await changeRows()
      expect(rows).toHaveLength(3)
      expect(rows.every((r) => r.action === 'set_tier')).toBe(true)
      const last = rows[2]!
      expect(JSON.parse(last.before_json as string)).toEqual({ tier: 1, source: 'auto' })
      expect(JSON.parse(last.after_json as string)).toEqual({ tier: 1, source: 'auto' })
      const audit = await json<Page<AuditItem>>(await A('/audit'))
      expect(audit.items[1]).toMatchObject({ action: 'set_tier', target_id: p, before: { tier: 5, source: 'admin' }, after: { tier: 2, source: 'auto' } })
    },
    120_000,
  )

  // ------------------------------------------------------------------------ AC-TIER-04 (phía Worker)
  it(
    'AC-TIER-04: mẻ đăng content.elements[].auto_tier thì GET /admin/elements trả auto_tier, tier hiệu lực = auto_tier, tier_source "auto"; phần tử không gửi auto_tier thì auto_tier null và tier 1; ?tier=N lọc theo tier hiệu lực',
    async () => {
      const [p, q, r] = (await Promise.all(NAMES.map(elementId))) as [string, string, string]
      expect((await publishWith(1, { [P]: 2, [Q]: 4, [R]: undefined })).status).toBe(201)
      const all = await json<Page<ElementItem>>(await A('/elements?size=100'))
      const by = new Map(all.items.map((i) => [i.id, i]))
      expect(by.get(p)).toMatchObject({ tier: 2, tier_source: 'auto', auto_tier: 2 })
      expect(by.get(q)).toMatchObject({ tier: 4, tier_source: 'auto', auto_tier: 4 })
      expect(by.get(r)).toMatchObject({ tier: 1, tier_source: 'auto', auto_tier: null })
      const two = await json<Page<ElementItem>>(await A('/elements?tier=2&size=100'))
      expect(two.items.map((i) => i.id)).toEqual([p])
      const four = await json<Page<ElementItem>>(await A('/elements?tier=4&size=100'))
      expect(four.items.map((i) => i.id)).toEqual([q])
      expect(await tierRows()).toEqual([]) // pipeline không bao giờ tạo tier admin
      expect(await stateTiers()).toEqual([])
    },
    120_000,
  )

  it(
    'AC-TIER-04: auto_tier ngoài 1-5 hoặc không phải số nguyên trong mẻ đăng bị từ chối (400 hoặc 422), không đổi gì',
    async () => {
      const p = await elementId(P)
      for (const bad of [0, 6, -1, 2.5, 10 ** 12]) {
        const res = await publishWith(1, { [P]: bad })
        expect([400, 422], String(bad)).toContain(res.status)
        isProblem(res)
      }
      const list = await json<Page<ElementItem>>(await A(`/elements?q=${encodeURIComponent(fold(P))}`))
      expect(list.items.find((i) => i.id === p)).toMatchObject({ tier: 1, auto_tier: null })
    },
    120_000,
  )

  // ------------------------------------------------------------------------ AC-TIER-05
  it(
    'AC-TIER-05: P admin gán 4 giữ tier 4 / "Admin gán" qua mẻ sau dù auto_tier đổi (auto_tier cập nhật); Q admin 5 chọn "auto" thì tier_source auto và tier = auto_tier của mẻ sau; mỗi lần đổi có audit',
    async () => {
      const [p, q] = [await elementId(P), await elementId(Q)]
      expect((await publishWith(1, { [P]: 2, [Q]: 3, [R]: 1 })).status).toBe(201)
      const first = await putTier(p, { tier: 4 })
      expect(await json<TierResult>(first)).toEqual({ element_id: p, before: 2, after: 4, before_source: 'auto', after_source: 'admin' })
      expect((await putTier(q, { tier: 5 })).status).toBe(200)

      expect((await publishWith(2, { [P]: 5, [Q]: 1, [R]: 1 })).status).toBe(201) // độ sâu của P đổi
      let all = await json<Page<ElementItem>>(await A('/elements?size=100'))
      let by = new Map(all.items.map((i) => [i.id, i]))
      expect(by.get(p)).toMatchObject({ tier: 4, tier_source: 'admin', auto_tier: 5 })
      expect(by.get(q)).toMatchObject({ tier: 5, tier_source: 'admin', auto_tier: 1 })

      const back = await putTier(q, { tier: 'auto' })
      expect(await json<TierResult>(back)).toEqual({ element_id: q, before: 5, after: 1, before_source: 'admin', after_source: 'auto' })
      expect((await publishWith(3, { [P]: 3, [Q]: 3, [R]: 1 })).status).toBe(201)
      all = await json<Page<ElementItem>>(await A('/elements?size=100'))
      by = new Map(all.items.map((i) => [i.id, i]))
      expect(by.get(p)).toMatchObject({ tier: 4, tier_source: 'admin', auto_tier: 3 })
      expect(by.get(q)).toMatchObject({ tier: 3, tier_source: 'auto', auto_tier: 3 })
      expect(await stateTiers()).toEqual([{ element_id: p, tier: 4 }])

      const audit = await json<Page<AuditItem>>(await A('/audit'))
      expect(audit.items.filter((i) => i.action === 'set_tier')).toHaveLength(3)
    },
    180_000,
  )
})
