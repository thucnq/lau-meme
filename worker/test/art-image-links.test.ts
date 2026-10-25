// Phủ (thêm 2026-10-25, contract 0.6.0, ADR 0018, migration 0009 `contribution.use_image_url` + `element.image_source`):
//   AC-ART-14  (phía Worker) POST /admin/contributions/{id}/approve nhận `use_image_url` (boolean, mặc định false):
//              true cho đề xuất có link -> 200 + lưu + audit `approve_contribution.after.use_image_url`; true cho đề xuất
//              không có link, hoặc không phải boolean -> 400 problem+json, không đổi gì, không audit;
//              GET /admin/contributions hiện `use_image_url`; GET /pipeline/state `image_links: [{element_id, url}]` (đề xuất
//              đã duyệt + chọn dùng link, xếp theo element_id); đăng mẻ mang `image_key` cho phần tử đó -> `image_source`
//              'admin', rời `image_links`, vào `admin_images`, mẻ sau không đè; phần tử khác vẫn 'ai'; mẻ với image_key null
//              thì phần tử vẫn ở `image_links`.
//   AC-ART-ABUSE (cho endpoint duyệt): host game -> 404, thiếu/sai token -> 401, không đổi gì.
// Black-box: docs/api/openapi.yaml 0.6.0, ADR 0002 (id), ADR 0018, migrations 0002-0008.
// Hiệu năng: D1 trong Miniflare ~66 ms/truy vấn; mỗi test gieo bằng MỘT env.DB.batch và gộp nhiều khẳng định.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['link', 'admin', 'token', 'ok'].join('-')
const WRONG = ['link', 'admin', 'token', 'no'].join('-')
const PIPELINE_TOKEN = ['link', 'pipeline', 'token'].join('-')
const IP_KEY = ['link', 'ip', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_API = 'https://dinoduct.fun/lau-meme/api'
const BATCH_AT = '2026-10-20T05:30:00.000Z'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Row = Record<string, unknown>
type Page<T> = { page: number; size: number; total: number; items: T[] }
type AdminContribution = {
  id: string
  name: string
  image_url: string | null
  image_hint: string | null
  use_image_url: boolean
  status: 'pending' | 'approved' | 'rejected'
  element_id: string | null
}
type AuditItem = { action: string; target_kind: string; target_id: string; before: unknown; after: unknown }
type ElementItem = { id: string; name: string; image_key: string | null; image_source: 'ai' | 'admin' | null }
type Link = { element_id: string; url: string }
type State = { contributions: Array<Row>; admin_images: Array<{ element_id: string; image_key: string }>; image_links: Link[] }
type Bucket = { put(key: string, value: Uint8Array): Promise<unknown>; delete(key: string): Promise<void> }
const R2 = (env as unknown as { IMG: Bucket }).IMG

// ---------------------------------------------------------------------------- ADR 0002 helpers
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

// ---------------------------------------------------------------------------- fixture content
const STARTERS = [
  { name: 'Cay', emoji: '🌶️' },
  { name: 'Cười', emoji: '😂' },
  { name: 'Toang', emoji: '💀' },
  { name: 'Deadline', emoji: '⏰' },
]
type Def = { a: string; b: string; result: string; emoji: string; depth: number }
const DEFS: Def[] = [
  { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
  { a: 'Tới Công Chuyện', b: 'Deadline', result: 'Chạy Deadline', emoji: '🏃', depth: 2 },
  { a: 'Chạy Deadline', b: 'Toang', result: 'Hết Cứu', emoji: '🧯', depth: 3 },
  { a: 'Hết Cứu', b: 'Cay', result: 'Stonks', emoji: '📈', depth: 4 },
  { a: 'Toang', b: 'Deadline', result: 'Khét Lẹt', emoji: '🫠', depth: 1 },
  { a: 'Cười', b: 'Toang', result: 'Cười Ra Nước Mắt', emoji: '🤣', depth: 1 },
  { a: 'Cay', b: 'Toang', result: 'Cà Phê', emoji: '🫖', depth: 1 },
]
const HINT = 'một ly cà phê đen đang chạy deadline'

// Đề xuất dùng trong test (cặp chưa có công thức)
const X = { name: 'Cà Phê Chạy Deadline', a: 'Deadline', b: 'Cà Phê', url: 'https://example.com/a.png' }
const X2 = { name: 'Meme Hai Link', a: 'Cay', b: 'Cà Phê', url: 'https://example.org/b.webp' }
const W = { name: 'Meme Có Link Không Chọn', a: 'Toang', b: 'Cà Phê', url: 'https://example.net/w.png' }
const PEND = { name: 'Meme Đang Chờ', a: 'Cười', b: 'Cà Phê', url: 'https://example.net/p.png' }
const REJ = { name: 'Meme Bị Loại', a: 'Hết Cứu', b: 'Toang', url: 'https://example.net/r.png' }
const NOLINK = { name: 'Meme Không Link', a: 'Cười', b: 'Hết Cứu' }
const EXTRA_X: Def = { a: X.a, b: X.b, result: X.name, emoji: '☕', depth: 2 }
const EXTRA_X2: Def = { a: X2.a, b: X2.b, result: X2.name, emoji: '🍲', depth: 2 }

const K1 = '0a1b2c3d4e5f.webp'
const K2 = 'f0e1d2c3b4a5.webp'
const K3 = '112233445566.webp'
const K4 = 'aabbccddeeff.webp'
const IMG_KEYS = [K1, K2, K3, K4]

async function batchBody(version: number, extra: Def[], images: Record<string, string | null>) {
  const starterIds = await Promise.all(STARTERS.map((s) => elementId(s.name)))
  const defs = [...DEFS, ...extra]
  const recipes = await Promise.all(
    defs.map(async (d) => {
      const [x, y] = [await elementId(d.a), await elementId(d.b)].sort()
      return { id: await recipeId(d.a, d.b), a: x!, b: y!, result: await elementId(d.result) }
    }),
  )
  const target = await elementId('Stonks')
  const withImage = (name: string) => (name in images ? { image_key: images[name] } : {})
  return {
    status: 'success',
    version,
    batch_at: BATCH_AT,
    mode: 'core',
    manifest: {
      version,
      batch_at: BATCH_AT,
      graph_url: `/api/graph/${version}`,
      starters: STARTERS.map((s, i) => ({ id: starterIds[i], name: s.name, emoji: s.emoji })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: target, emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await recipeId('graph', String(version))]: 'abc' } },
    content: {
      elements: [
        ...STARTERS.map((s, i) => ({ id: starterIds[i], name: s.name, fold: fold(s.name), emoji: s.emoji, depth: 0, origin: 'vn' })),
        ...(await Promise.all(
          defs.map(async (d) => ({
            id: await elementId(d.result),
            name: d.result,
            fold: fold(d.result),
            emoji: d.emoji,
            depth: d.depth,
            origin: 'vn',
            ...withImage(d.result),
          })),
        )),
      ],
      recipes,
      starters: starterIds,
      daily_element_id: target,
    },
    stats: {},
  }
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
  return `10.40.${ipCounter >> 8}.${ipCounter & 255}`
}
const json = async <T>(res: Response) => (await res.json()) as T
const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const str = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body))

type AOpts = { method?: string; body?: unknown; auth?: string | null; headers?: Record<string, string>; origin?: string }
function AD(path: string, o: AOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': nextIp(), ...(o.headers ?? {}) }
  const auth = o.auth === undefined ? `Bearer ${TOKEN}` : o.auth
  if (auth !== null) headers.Authorization = auth
  const hasBody = o.body !== undefined
  const init: RequestInit = { method: o.method ?? (hasBody ? 'POST' : 'GET') }
  if (hasBody) init.body = str(o.body)
  return raw(`${o.origin ?? `${ADMIN_ORIGIN}/api/admin`}${path}`, init, headers)
}
const adminApprove = (id: string, body: unknown, o: AOpts = {}) => AD(`/contributions/${id}/approve`, { body, ...o })
const adminList = async (status: string) => (await json<Page<AdminContribution>>(await AD(`/contributions?status=${status}&size=100`))).items
const listElements = async () => new Map((await json<Page<ElementItem>>(await AD('/elements?size=100'))).items.map((i) => [i.id, i]))
const auditItems = async () => (await json<Page<AuditItem>>(await AD('/audit?size=100'))).items
const getState = async () =>
  json<State>(await raw(`${GAME_API}/pipeline/state`, {}, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() }))

async function publish(version: number, extra: Def[], images: Record<string, string | null> = {}): Promise<void> {
  const body = await batchBody(version, extra, images)
  const res = await raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) }, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
  expect(res.status, await res.clone().text()).toBe(201)
}

// ---------------------------------------------------------------------------- D1 seeding and probes
type Seed = { name: string; a: string; b: string; url?: string; status?: 'pending' | 'approved' | 'rejected'; at: number }
async function seedStmt(s: Seed): Promise<{ id: string; stmt: D1PreparedStatement }> {
  const id = crypto.randomUUID()
  const ids = (await Promise.all([elementId(s.a), elementId(s.b)])).sort()
  const status = s.status ?? 'pending'
  const stmt = env.DB.prepare(
    'INSERT INTO contribution (id, account_id, a_id, b_id, name, name_fold, emoji, description, image_url, status, reject_reason, image_hint, element_id, created_at, updated_at, decided_at) VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id,
    ids[0],
    ids[1],
    s.name,
    fold(s.name),
    s.url ?? null,
    status,
    status === 'rejected' ? 'Không phù hợp' : null,
    status === 'approved' ? HINT : null,
    status === 'approved' ? await elementId(s.name) : null,
    s.at,
    s.at,
    status === 'pending' ? null : s.at + 1000,
  )
  return { id, stmt }
}
async function seed(rows: Seed[]): Promise<Record<string, string>> {
  const made = await Promise.all(rows.map(seedStmt))
  await env.DB.batch(made.map((m) => m.stmt))
  return Object.fromEntries(rows.map((r, i) => [r.name, made[i]!.id]))
}
async function q<T = Row>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results
}
const changeRows = () => q('SELECT * FROM admin_change ORDER BY created_at, id')
const statusOf = async (id: string) => (await q<{ status: string }>('SELECT status FROM contribution WHERE id = ?', id))[0]!.status
const byElement = (links: Link[]) => [...links].sort((p, r) => (p.element_id < r.element_id ? -1 : 1))

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM contribution'),
    env.DB.prepare('DELETE FROM admin_image_change'),
    env.DB.prepare('DELETE FROM admin_change'),
    env.DB.prepare('DELETE FROM element_tier'),
    env.DB.prepare('DELETE FROM banned_term'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM rate_counter'),
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
  for (const key of IMG_KEYS) await R2.put(`img/${key}`, Uint8Array.of(1, 2, 3, 4))
  await publish(1, [])
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const key of IMG_KEYS) await R2.delete(`img/${key}`)
})

describe('art image links (worker)', () => {
  it(
    'AC-ART-14: duyệt X (có link) kèm use_image_url true -> 200 use_image_url true, danh sách admin hiện đúng cờ, audit approve_contribution mang use_image_url true; duyệt không kèm cờ hoặc cờ false -> false',
    async () => {
      const t = Date.now()
      const ids = await seed([
        { ...X, at: t - 5000 },
        { ...X2, at: t - 4000 },
        { ...W, at: t - 3000 },
        { ...PEND, at: t - 2000 },
      ])

      const res = await adminApprove(ids[X.name]!, { image_hint: HINT, use_image_url: true })
      expect(res.status).toBe(200)
      expect(await json<AdminContribution>(res)).toMatchObject({ id: ids[X.name], status: 'approved', use_image_url: true, image_url: X.url, element_id: await elementId(X.name) })

      const noFlag = await adminApprove(ids[W.name]!, { image_hint: HINT })
      expect(noFlag.status).toBe(200)
      expect(await json<AdminContribution>(noFlag)).toMatchObject({ status: 'approved', use_image_url: false })
      const falseFlag = await adminApprove(ids[X2.name]!, { image_hint: HINT, use_image_url: false })
      expect(falseFlag.status).toBe(200)
      expect(await json<AdminContribution>(falseFlag)).toMatchObject({ status: 'approved', use_image_url: false })

      const approved = new Map((await adminList('approved')).map((c) => [c.id, c]))
      expect(approved.get(ids[X.name]!)).toMatchObject({ use_image_url: true })
      expect(approved.get(ids[W.name]!)).toMatchObject({ use_image_url: false })
      expect(approved.get(ids[X2.name]!)).toMatchObject({ use_image_url: false })
      const pending = await adminList('pending')
      expect(pending.map((c) => [c.name, c.use_image_url])).toEqual([[PEND.name, false]])

      const audit = (await auditItems()).filter((a) => a.action === 'approve_contribution')
      expect(audit).toHaveLength(3)
      const forX = audit.find((a) => a.target_id === ids[X.name])!
      expect(forX.after).toMatchObject({ use_image_url: true })
      for (const other of [W.name, X2.name]) {
        expect(JSON.stringify(audit.find((a) => a.target_id === ids[other])!.after)).not.toContain('"use_image_url":true')
      }
    },
    120_000,
  )

  it(
    'AC-ART-14: use_image_url true cho đề xuất không có link ảnh -> 400 problem+json, vẫn chờ duyệt, không audit, không element_id; sau đó duyệt không kèm cờ vẫn được',
    async () => {
      const ids = await seed([{ ...NOLINK, at: Date.now() - 1000 }])
      const id = ids[NOLINK.name]!

      const res = await adminApprove(id, { image_hint: HINT, use_image_url: true })
      expect(res.status).toBe(400)
      isProblem(res)
      expect(await statusOf(id)).toBe('pending')
      expect(await q('SELECT element_id FROM contribution WHERE id = ? AND element_id IS NOT NULL', id)).toEqual([])
      expect(await changeRows()).toEqual([])
      expect((await getState()).image_links).toEqual([])

      const ok = await adminApprove(id, { image_hint: HINT })
      expect(ok.status).toBe(200)
      expect(await json<AdminContribution>(ok)).toMatchObject({ status: 'approved', use_image_url: false })
    },
    120_000,
  )

  it(
    'AC-ART-VALIDATION: use_image_url không phải boolean ("yes", "true", 1, 0, null, mảng, object, script) hoặc trường lạ -> 400 problem+json, đề xuất vẫn chờ duyệt, không audit, không image_links',
    async () => {
      const ids = await seed([{ ...X, at: Date.now() - 1000 }])
      const id = ids[X.name]!
      const bad: unknown[] = ['yes', 'true', '<script>alert(1)</script>', 1, 0, null, [true], { v: true }]
      for (const value of bad) {
        const res = await adminApprove(id, { image_hint: HINT, use_image_url: value })
        expect(res.status, str(value)).toBe(400)
        isProblem(res)
      }
      const extra = await adminApprove(id, { image_hint: HINT, use_image_url: true, image_url: 'https://evil.example.net/x.png' })
      expect(extra.status).toBe(400)
      isProblem(extra)

      expect(await statusOf(id)).toBe('pending')
      expect(await changeRows()).toEqual([])
      expect((await getState()).image_links).toEqual([])
      expect((await q<{ image_url: string }>('SELECT image_url FROM contribution WHERE id = ?', id))[0]!.image_url).toBe(X.url)
    },
    120_000,
  )

  it(
    'AC-ART-14: /pipeline/state.image_links = [{element_id, url}] cho đề xuất đã duyệt có chọn dùng link, xếp theo element_id; không có đề xuất duyệt không chọn, đang chờ, bị loại; link không lọt vào state.contributions',
    async () => {
      const t = Date.now()
      const seeded = await seed([
        { ...X, at: t - 9000 },
        { ...X2, at: t - 8000 },
        { ...PEND, at: t - 7000 },
        { ...W, status: 'approved', at: t - 6000 },
        { ...REJ, status: 'rejected', at: t - 5000 },
      ])
      expect((await getState()).image_links).toEqual([])
      expect((await adminApprove(seeded[X.name]!, { image_hint: HINT, use_image_url: true })).status).toBe(200)
      expect((await adminApprove(seeded[X2.name]!, { image_hint: HINT, use_image_url: true })).status).toBe(200)

      const state = await getState()
      expect(state.image_links).toEqual(
        byElement([
          { element_id: await elementId(X.name), url: X.url },
          { element_id: await elementId(X2.name), url: X2.url },
        ]),
      )
      for (const link of state.image_links) expect(Object.keys(link).sort()).toEqual(['element_id', 'url'])
      expect(state.contributions.map((c) => c.name).sort()).toEqual([W.name, X.name, X2.name].sort())
      const contributionsText = JSON.stringify(state.contributions)
      for (const url of [X.url, X2.url, W.url, PEND.url, REJ.url]) expect(contributionsText).not.toContain(url)
      const text = JSON.stringify(state.image_links)
      for (const url of [W.url, PEND.url, REJ.url]) expect(text).not.toContain(url)
    },
    120_000,
  )

  it(
    'AC-ART-14: đăng mẻ mang image_key cho phần tử đã chọn dùng link -> image_source admin, rời image_links, vào admin_images; phần tử khác vẫn ai; mẻ sau gửi khóa khác không đè; mẻ gửi image_key null thì phần tử vẫn ở image_links',
    async () => {
      const t = Date.now()
      const seeded = await seed([
        { ...X, at: t - 5000 },
        { ...X2, at: t - 4000 },
      ])
      expect((await adminApprove(seeded[X.name]!, { image_hint: HINT, use_image_url: true })).status).toBe(200)
      expect((await adminApprove(seeded[X2.name]!, { image_hint: HINT, use_image_url: true })).status).toBe(200)
      const [x, x2, other] = await Promise.all([elementId(X.name), elementId(X2.name), elementId('Khét Lẹt')])

      // mẻ 2: X có ảnh K1, phần tử thường Khét Lẹt có ảnh K3, X2 gửi null
      await publish(2, [EXTRA_X, EXTRA_X2], { [X.name]: K1, 'Khét Lẹt': K3, [X2.name]: null })
      let items = await listElements()
      expect(items.get(x)).toMatchObject({ image_key: K1, image_source: 'admin' })
      expect(items.get(other)).toMatchObject({ image_key: K3, image_source: 'ai' })
      expect(items.get(x2)!.image_key).toBeNull()
      expect(items.get(x2)!.image_source).not.toBe('admin')
      let state = await getState()
      expect(state.admin_images).toEqual([{ element_id: x, image_key: K1 }])
      expect(state.image_links).toEqual([{ element_id: x2, url: X2.url }])

      // mẻ 3: X gửi khóa khác -> giữ K1; X2 có ảnh K4 -> thành ảnh admin và rời image_links
      await publish(3, [EXTRA_X, EXTRA_X2], { [X.name]: K2, [X2.name]: K4 })
      items = await listElements()
      expect(items.get(x)).toMatchObject({ image_key: K1, image_source: 'admin' })
      expect(items.get(x2)).toMatchObject({ image_key: K4, image_source: 'admin' })
      state = await getState()
      expect(state.image_links).toEqual([])
      expect([...state.admin_images].sort((p, r) => (p.element_id < r.element_id ? -1 : 1))).toEqual(
        [
          { element_id: x, image_key: K1 },
          { element_id: x2, image_key: K4 },
        ].sort((p, r) => (p.element_id < r.element_id ? -1 : 1)),
      )
    },
    180_000,
  )

  it(
    'AC-ART-14: phần tử đóng góp đã duyệt nhưng KHÔNG chọn dùng link, đăng mẻ có image_key (ảnh vẽ) -> image_source ai, không vào admin_images',
    async () => {
      const seeded = await seed([{ ...X, at: Date.now() - 5000 }])
      expect((await adminApprove(seeded[X.name]!, { image_hint: HINT })).status).toBe(200)
      const x = await elementId(X.name)

      await publish(2, [EXTRA_X], { [X.name]: K1 })
      expect((await listElements()).get(x)).toMatchObject({ image_key: K1, image_source: 'ai' })
      const state = await getState()
      expect(state.admin_images).toEqual([])
      expect(state.image_links).toEqual([])
    },
    120_000,
  )

  it(
    'AC-ART-ABUSE: duyệt trên host game -> 404; thiếu token, token sai, token pipeline, sai sơ đồ -> 401; không đổi gì, không audit, không image_links',
    async () => {
      const ids = await seed([{ ...X, at: Date.now() - 1000 }])
      const id = ids[X.name]!
      const body = { image_hint: HINT, use_image_url: true }

      const onGame = await adminApprove(id, body, { origin: `${GAME_API}/admin` })
      expect(onGame.status).toBe(404)
      for (const auth of [null, `Bearer ${WRONG}`, `Bearer ${PIPELINE_TOKEN}`, `Basic ${btoa(`admin:${TOKEN}`)}`, `Bearer ${TOKEN}x`]) {
        const res = await adminApprove(id, body, { auth })
        expect(res.status, String(auth)).toBe(401)
        isProblem(res)
      }
      const spoof = await adminApprove(id, body, { auth: null, headers: { 'X-Admin': 'true', 'X-Forwarded-For': '1.2.3.4' } })
      expect(spoof.status).toBe(401)

      expect(await statusOf(id)).toBe('pending')
      expect(await changeRows()).toEqual([])
      expect((await getState()).image_links).toEqual([])
    },
    120_000,
  )
})
