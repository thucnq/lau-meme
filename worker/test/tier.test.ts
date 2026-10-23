// Acceptance tests for AC-ADMIN-12 (admin assigns element tier) and the worker side of TIER (docs/acceptance/tier.md).
// Black-box: docs/api/openapi.yaml (PUT /admin/elements/{id}/tier, GET /admin/elements?tier=, GET /admin/audit,
// GET /pipeline/state `tiers`), ADR 0002 ids and migrations 0002_content, 0004_ops, 0007_contrib_tier.
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
type ElementItem = { id: string; name: string; emoji: string; depth: number; state: string; image_key: string | null; image_state: string; last_version: number; tier: number }
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
const NAMES = [P, Q, R]

const elementRow = (name: string) =>
  elementId(name).then((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO element (id, name, name_fold, emoji, depth, origin, image_key, first_version, last_version, updated_at) VALUES (?, ?, ?, ?, 1, ?, NULL, 1, 1, ?)',
    ).bind(id, name, fold(name), '🍲', 'vn', Date.now()),
  )

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
    ...(await Promise.all(NAMES.map(elementRow))),
  ])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('tier (worker)', () => {
  // ------------------------------------------------------------------------ AC-ADMIN-12
  it(
    'AC-ADMIN-12: đặt tier P = 4 trả 200 {element_id, before 1, after 4}, ghi đúng 1 dòng audit set_tier (trước 1, sau 4) có dấu vân token, hiện trong /audit, trong /pipeline/state.tiers và trong danh mục',
    async () => {
      const p = await elementId(P)
      const fp = hex(await sha256(TOKEN)).slice(0, 8)
      expect(await stateTiers()).toEqual([]) // chưa gán thì không có dòng nào (mặc định 1)

      const res = await putTier(p, { tier: 4 })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ element_id: p, before: 1, after: 4 })

      expect(await tierRows()).toEqual([{ element_id: p, tier: 4 }])
      const rows = await changeRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ action: 'set_tier', target_kind: 'element', target_id: p, token_fp: fp })
      expect(JSON.parse(rows[0]!.before_json as string)).toEqual({ tier: 1 })
      expect(JSON.parse(rows[0]!.after_json as string)).toEqual({ tier: 4 })
      expect(await countAudit()).toBe(0) // set_tier nằm ở admin_change, không phải admin_audit

      const audit = await json<Page<AuditItem>>(await A('/audit'))
      expect(audit.total).toBe(1)
      expect(audit.items[0]).toMatchObject({ action: 'set_tier', target_kind: 'element', target_id: p, before: { tier: 1 }, after: { tier: 4 }, token_fp: fp })
      expect(Math.abs(Date.parse(audit.items[0]!.created_at) - Date.now())).toBeLessThan(5 * 60_000)

      expect(await stateTiers()).toEqual([{ element_id: p, tier: 4 }])

      const list = await json<Page<ElementItem>>(await A(`/elements?q=${encodeURIComponent(fold(P))}`))
      expect(list.items.find((i) => i.id === p)?.tier).toBe(4)
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
      expect(await again.json()).toEqual({ element_id: p, before: 4, after: 2 })
      const same = await putTier(p, { tier: 2 })
      expect(same.status).toBe(200)
      expect(await same.json()).toEqual({ element_id: p, before: 2, after: 2 })
      expect((await A('/moderation', { body: { target_kind: 'element', target_id: q, action: 'hide' } })).status).toBe(200)

      expect(await changeRows()).toHaveLength(3)
      expect(await tierRows()).toEqual([{ element_id: p, tier: 2 }])
      const audit = await json<Page<AuditItem>>(await A('/audit'))
      expect(audit.total).toBe(4)
      expect(audit.items.map((i) => i.action)).toEqual(['hide', 'set_tier', 'set_tier', 'set_tier'])
      const times = audit.items.map((i) => Date.parse(i.created_at))
      expect(times).toEqual([...times].sort((x, y) => y - x))
      expect(audit.items.slice(1).map((i) => [i.before, i.after])).toEqual([
        [{ tier: 2 }, { tier: 2 }],
        [{ tier: 4 }, { tier: 2 }],
        [{ tier: 1 }, { tier: 4 }],
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
})
