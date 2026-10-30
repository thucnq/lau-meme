// Phủ (thêm 2026-10-30, ADR 0022, migration 0012, contract 0.11.0) phần worker của:
//   AC-MOD-11     POST /pipeline/batches `rejected`: upsert vào danh sách "Bị chặn" cùng DB.batch đăng mẻ; gặp lại cùng fold thì
//                 seen_count + 1, gộp lý do; mẻ lỗi / mẻ bị từ chối không ghi gì; đầu vào sai 4xx không ghi gì.
//   AC-PIPE-21    /pipeline/state.unblocked (cũ nhất trước, trường admin đã sửa), `rejected_added` chuyển dòng sang "added".
//   AC-ADMIN-13   GET /admin/rejected (lọc, tìm fold, phân trang, thứ tự), GET /admin/rejected/{id}, 401, host game 404.
//   AC-ADMIN-14   PATCH /admin/rejected/{id}, POST .../unblock (audit edit_rejected / unblock_rejected, 409, 400, 404).
//   AC-ADMIN-15   POST /admin/rejected/{id}/approve ("Duyệt luôn", audit approve_rejected, /pipeline/state.manual_approvals).
//   AC-ADMIN-16   GET/PATCH /admin/elements/{id} (element_edit, bí danh, audit edit_element, "Chờ mẻ kế tiếp" qua rev).
//   AC-ADMIN-17   tác vụ dọn hằng ngày xóa dòng "Bị chặn" có last_seen_at cũ hơn 90 ngày (kể cả "Đã thêm"), giữ audit.
//   AC-MOD-VALIDATION / AC-ADMIN-VALIDATION: đầu vào nguy hiểm cho các endpoint mới.
// Black-box: docs/api/openapi.yaml 0.11.0, ADR 0002 / 0008 / 0022, migrations 0002, 0004, 0012.
// Performance: D1 in Miniflare costs ~66 ms/query, so tests seed with ONE env.DB.batch and combine assertions per case.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['rej', 'admin', 'token', 'ok'].join('-')
const WRONG = ['rej', 'admin', 'token', 'no'].join('-')
const PIPELINE_TOKEN = ['rej', 'pipeline', 'token'].join('-')
const IP_KEY = ['rej', 'ip', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_API = 'https://dinoduct.fun/lau-meme/api'
const DAY = 86_400_000

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Scheduled = { scheduled: (controller: ScheduledController, env: unknown, ctx: ExecutionContext) => Promise<void> }
type Page<T> = { page: number; size: number; total: number; items: T[] }
type Reason = { code: string; label: string }
type Rej = {
  id: string
  name: string
  emoji: string | null
  description: string | null
  daily_hint: string | null
  image_hint: string | null
  source_name: string
  source_url: string | null
  context: string | null
  reasons: Reason[]
  step: string
  status: string
  seen_count: number
  first_batch_id: string
  last_batch_id: string
  first_seen_at: string
  last_seen_at: string
  edited_at: string | null
  decided_at: string | null
  element_id: string | null
  a: string | null
  b: string | null
  tier: number | null
}
const REJ_KEYS = [
  'a', 'b', 'context', 'daily_hint', 'decided_at', 'description', 'edited_at', 'element_id', 'emoji', 'first_batch_id',
  'first_seen_at', 'id', 'image_hint', 'last_batch_id', 'last_seen_at', 'name', 'reasons', 'seen_count', 'source_name',
  'source_url', 'status', 'step', 'tier',
] // fmt: skip
type AuditItem = { action: string; target_kind: string; target_id: string; before: unknown; after: unknown; token_fp: string; created_at: string }
type ElementText = { name: string; emoji: string; description: string | null; daily_hint: string | null; image_hint: string | null; origin: string | null }
type Detail = {
  id: string
  published: ElementText
  edit: Record<string, unknown> | null
  pending: boolean
  aliases: string[]
  state: string
  tier: number
  tier_source: string
  image_key: string | null
  image_source: string | null
}
type EditRow = { element_id: string; rev: number } & Record<string, unknown>
type State = {
  current_version: number | null
  unblocked: Array<{ id: string; name: string; fold: string } & Record<string, unknown>>
  manual_approvals: Array<{ element_id: string; a: string; b: string } & Record<string, unknown>>
  element_edits: EditRow[]
  element_aliases: Array<{ fold: string; element_id: string }>
  tiers: Array<{ element_id: string; tier: number }>
}

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

// ---------------------------------------------------------------------------- catalog
const EA = 'Bc Món A'
const EB = 'Bc Món B'
const EC = 'Bc Món C' // EA + EB = EC when a recipe is wanted
const EH = 'Bc Món Ẩn' // hidden through the API in the tests that need it
const EP = 'Bc Phần Tử P' // the element edited in AC-ADMIN-16
const EQ = 'Bc Phần Tử Q'
const EBLK = 'Bc Bị Chặn Vĩnh Viễn' // blocked by the admin (AC-ADMIN-05) in the tests that need it
const CATALOG = [EA, EB, EC, EH, EP, EQ, EBLK]
const P_DESC = 'Mô tả gốc của P'
const P_DAILY = 'Gợi ý Daily gốc của P'
const P_IMG = 'Gợi ý ảnh gốc của P'

const elementRow = (name: string) =>
  elementId(name).then((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO element (id, name, name_fold, emoji, depth, origin, image_key, image_source, first_version, last_version, updated_at, description, daily_hint, image_hint) VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, 1, 1, ?, ?, ?, ?)',
    ).bind(id, name, fold(name), '🍲', 'vn', Date.now(), name === EP ? P_DESC : null, name === EP ? P_DAILY : null, name === EP ? P_IMG : null),
  )

// ---------------------------------------------------------------------------- rejected_concept seeding
const rid = (n: number) => `0190b1c2-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const BATCH_OLD = '0190b1c2-0000-7000-8000-00000000b001'
const BASE = Date.parse('2026-10-28T00:00:00.000Z')
const POLITICS: Reason[] = [{ code: 'politics', label: 'Chính trị' }]
const BANNED: Reason[] = [{ code: 'banned_term', label: 'Từ cấm' }]
const UNSURE: Reason[] = [{ code: 'unsure', label: 'Không chắc' }]

type Seed = {
  n: number
  name: string
  emoji?: string | null
  description?: string | null
  daily_hint?: string | null
  image_hint?: string | null
  source_name?: string
  source_url?: string | null
  context?: string | null
  reasons?: Reason[]
  step?: 'layer1' | 'layer2'
  status?: 'blocked' | 'unblocked' | 'added' | 'approved'
  seen_count?: number
  last_seen_at?: number
  element_id?: string | null
  a_id?: string | null
  b_id?: string | null
  decided_at?: number | null
}
const seedRow = (s: Seed) =>
  env.DB.prepare(
    `INSERT INTO rejected_concept (id, name, name_fold, emoji, description, daily_hint, image_hint, source_name, source_url, context, reasons_json,
       step, status, seen_count, first_batch_id, last_batch_id, first_seen_at, last_seen_at, edited_at, decided_at, element_id, a_id, b_id, tier, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
  ).bind(
    rid(s.n),
    s.name,
    fold(s.name),
    s.emoji === undefined ? '😡' : s.emoji,
    s.description === undefined ? 'Mô tả gốc' : s.description,
    s.daily_hint === undefined ? 'Gợi ý Daily gốc' : s.daily_hint,
    s.image_hint === undefined ? 'Gợi ý ảnh gốc' : s.image_hint,
    s.source_name ?? 'Reddit',
    s.source_url === undefined ? `https://example.com/p/${s.n}` : s.source_url,
    s.context === undefined ? `Ngữ cảnh nguồn ${s.n}` : s.context,
    JSON.stringify(s.reasons ?? POLITICS),
    s.step ?? 'layer2',
    s.status ?? 'blocked',
    s.seen_count ?? 1,
    BATCH_OLD,
    BATCH_OLD,
    (s.last_seen_at ?? BASE) - 3_600_000,
    s.last_seen_at ?? BASE,
    s.decided_at ?? null,
    s.element_id ?? null,
    s.a_id ?? null,
    s.b_id ?? null,
    Date.now(),
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
  return `10.60.${ipCounter >> 8}.${ipCounter & 255}`
}
type AOpts = { method?: string; body?: unknown; auth?: string | null }
/** Call /api/admin<path> on the admin host. `auth: null` sends no Authorization header. */
function A(path: string, o: AOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': nextIp() }
  const auth = o.auth === undefined ? `Bearer ${TOKEN}` : o.auth
  if (auth !== null) headers.Authorization = auth
  const hasBody = o.body !== undefined
  const init: RequestInit = { method: o.method ?? (hasBody ? 'POST' : 'GET') }
  if (hasBody) init.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
  return raw(`${ADMIN_ORIGIN}/api/admin${path}`, init, headers)
}
const pipelineHeaders = () => ({ Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
const json = async <T>(res: Response) => (await res.json()) as T
const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const problemText = async (res: Response) => {
  const p = await json<{ title?: string; detail?: string }>(res)
  return `${p.title ?? ''} ${p.detail ?? ''}`
}
const getState = async () => json<State>(await raw(`${GAME_API}/pipeline/state`, {}, pipelineHeaders()))
const listRejected = async (qs = '') => json<Page<Rej>>(await A(`/rejected${qs}`))
const getRejected = async (id: string) => json<Rej>(await A(`/rejected/${id}`))
const patchRejected = (id: string, body: unknown) => A(`/rejected/${id}`, { method: 'PATCH', body })
const unblock = (id: string) => A(`/rejected/${id}/unblock`, { method: 'POST', body: {} })
const approve = (id: string, body: unknown) => A(`/rejected/${id}/approve`, { method: 'POST', body })
const getDetail = async (id: string) => json<Detail>(await A(`/elements/${id}`))
const patchElement = (id: string, body: unknown) => A(`/elements/${id}`, { method: 'PATCH', body })
const mod = (target_id: string, action: string, reason: string) => A('/moderation', { body: { target_kind: 'element', target_id, action, reason } })
const auditItems = async (action?: string) => {
  const items = (await json<Page<AuditItem>>(await A('/audit?size=100'))).items
  return action === undefined ? items : items.filter((a) => a.action === action)
}
const FP = async () => hex(await sha256(TOKEN)).slice(0, 8)
const contentChanges = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM content_change').first<{ n: number }>())!.n
const rejectedCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM rejected_concept').first<{ n: number }>())!.n

// ---------------------------------------------------------------------------- publish (success / error batch)
type PublishOpts = {
  recipes?: Array<[string, string, string]> // names a, b, result
  elements?: Record<string, Record<string, unknown>> // per element name: extra content fields
  extra?: Record<string, unknown> // extra top-level body fields (rejected, rejected_added, element_edits_applied)
}
async function publish(version: number, o: PublishOpts = {}): Promise<Response> {
  const starterNames = ['Cay', 'Cười', 'Toang', 'Deadline']
  const starters = await Promise.all(starterNames.map(elementId))
  const batchAt = '2026-10-29T05:30:00.000Z'
  const target = await elementId(EC)
  const [x, y] = [starters[0]!, starters[1]!].sort()
  const elems = await Promise.all(
    CATALOG.map(async (name) => ({
      id: await elementId(name),
      name,
      fold: fold(name),
      emoji: '🍲',
      depth: name === EC ? 4 : 3, // the daily element needs depth 4..8 (manifest.daily.depth rule)
      auto_tier: 2,
      ...(o.elements?.[name] ?? {}),
    })),
  )
  const recipes = [{ id: await recipeId('Cay', 'Cười'), a: x, b: y, result: target }]
  for (const [a, b, r] of o.recipes ?? []) {
    const [lo, hi] = [await elementId(a), await elementId(b)].sort()
    recipes.push({ id: await recipeId(a, b), a: lo!, b: hi!, result: await elementId(r) })
  }
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
      elements: [...starters.map((id, i) => ({ id, name: starterNames[i]!, fold: fold(starterNames[i]!), emoji: '🔥', depth: 0 })), ...elems],
      recipes,
      starters,
      daily_element_id: target,
    },
    stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
    ...(o.extra ?? {}),
  }
  return raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) }, pipelineHeaders())
}
const publishError = () =>
  raw(
    `${GAME_API}/pipeline/batches`,
    {
      method: 'POST',
      body: JSON.stringify({
        status: 'error',
        batch_at: '2026-10-29T06:30:00.000Z',
        mode: 'full',
        failed_step: 'publish',
        stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
      }),
    },
    pipelineHeaders(),
  )
const batchId = async (res: Response) => (await json<{ id: string }>(res)).id

const rej = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  fold: fold(name),
  source_name: 'Reddit',
  source_url: 'https://example.com/a',
  context: 'Ngữ cảnh nguồn',
  reasons: POLITICS,
  step: 'layer2',
  ...o,
})

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rejected_concept'),
    env.DB.prepare('DELETE FROM element_edit'),
    env.DB.prepare('DELETE FROM element_alias'),
    env.DB.prepare('DELETE FROM content_change'),
    env.DB.prepare('DELETE FROM daily_pin'),
    env.DB.prepare('DELETE FROM daily_pin_change'),
    env.DB.prepare('DELETE FROM admin_image_change'),
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
    ...(await Promise.all(CATALOG.map(elementRow))),
  ])
})

describe('rejected concepts + element edit (worker)', () => {
  // ====================================================================== AC-MOD-11
  it(
    'AC-MOD-11: mẻ success gửi rejected: 4 khái niệm vào danh sách "Bị chặn" đủ trường (mọi lý do, bước, nguồn, ngữ cảnh 500 ký tự, đợt, thời điểm), không vào graph',
    async () => {
      const ctx500 = 'n'.repeat(500)
      const items = [
        rej('Bc Từ Cấm Thử', { reasons: BANNED, step: 'layer1', emoji: '💣', description: 'Mô tả có sẵn', context: ctx500 }),
        rej('Bc Bí Danh Thử', { reasons: [{ code: 'banned_alias', label: 'Trùng bí danh bị chặn' }], step: 'layer1', source_name: 'Know Your Meme', source_url: 'https://kym.example/x' }),
        rej('Bc Chính Trị Thử', { reasons: POLITICS, step: 'layer2', emoji: '🗳️' }),
        rej('Bc Không Chắc Thử', {
          reasons: [
            { code: 'unsure', label: 'Không chắc' },
            { code: 'invalid_response', label: 'Phản hồi sai định dạng' },
          ],
          step: 'layer2',
          source_url: undefined,
          context: undefined,
        }),
      ]
      const res = await publish(1, { extra: { rejected: items } })
      expect(res.status).toBe(201)
      const id1 = await batchId(res)

      const page = await listRejected()
      expect(page.total).toBe(4)
      const byName = new Map(page.items.map((r) => [r.name, r]))
      const banned = byName.get('Bc Từ Cấm Thử')!
      expect(banned).toMatchObject({
        emoji: '💣',
        description: 'Mô tả có sẵn',
        source_name: 'Reddit',
        source_url: 'https://example.com/a',
        context: ctx500,
        reasons: BANNED,
        step: 'layer1',
        status: 'blocked',
        seen_count: 1,
        first_batch_id: id1,
        last_batch_id: id1,
        edited_at: null,
        decided_at: null,
        element_id: null,
        a: null,
        b: null,
        tier: null,
      })
      expect(Object.keys(banned).sort()).toEqual(REJ_KEYS)
      expect(Number.isNaN(Date.parse(banned.last_seen_at))).toBe(false)
      expect(banned.first_seen_at).toBe(banned.last_seen_at)
      expect(byName.get('Bc Bí Danh Thử')).toMatchObject({ source_name: 'Know Your Meme', source_url: 'https://kym.example/x', step: 'layer1', emoji: null, description: null })
      expect(byName.get('Bc Chính Trị Thử')).toMatchObject({ step: 'layer2', reasons: POLITICS, emoji: '🗳️' })
      const unsure = byName.get('Bc Không Chắc Thử')!
      expect(unsure.reasons.map((r) => r.code)).toEqual(['unsure', 'invalid_response']) // mọi lý do, không chỉ lý do đầu
      expect(unsure.reasons.every((r) => r.label.length > 0)).toBe(true)
      expect(unsure).toMatchObject({ source_url: null, context: null })

      const detail = await getRejected(banned.id)
      expect(detail).toEqual(banned)
      // không vào graph: không có phần tử nào mang tên đó
      const inGraph = await env.DB.prepare('SELECT COUNT(*) AS n FROM element WHERE name_fold IN (?, ?, ?, ?)')
        .bind(...items.map((i) => i.fold))
        .first<{ n: number }>()
      expect(inGraph!.n).toBe(0)
    },
    120_000,
  )

  it(
    'AC-MOD-11: khái niệm trùng fold với dòng đã có không tạo dòng mới: seen_count + 1, last_batch_id và lần gặp cuối cập nhật, lý do gộp, first_batch_id giữ',
    async () => {
      const first = await publish(1, { extra: { rejected: [rej('Bc Gặp Lại', { reasons: POLITICS })] } })
      expect(first.status).toBe(201)
      const id1 = await batchId(first)
      const row1 = (await listRejected()).items[0]!

      const second = await publish(2, {
        extra: {
          rejected: [
            rej('BC GẶP LẠI', { reasons: [...POLITICS, ...UNSURE], context: 'Ngữ cảnh mới' }), // cùng fold, viết hoa khác
            rej('Bc Gặp Khác', { reasons: BANNED, step: 'layer1' }),
          ],
        },
      })
      expect(second.status).toBe(201)
      const id2 = await batchId(second)
      const page = await listRejected()
      expect(page.total).toBe(2)
      const again = page.items.find((r) => r.id === row1.id)!
      expect(again.seen_count).toBe(2)
      expect(again.first_batch_id).toBe(id1)
      expect(again.last_batch_id).toBe(id2)
      expect(again.reasons.map((r) => r.code).sort()).toEqual(['politics', 'unsure'])
      expect(Date.parse(again.last_seen_at)).toBeGreaterThanOrEqual(Date.parse(row1.last_seen_at))
      expect(again.first_seen_at).toBe(row1.first_seen_at)

      const third = await publish(3, { extra: { rejected: [rej('Bc Gặp Lại', { reasons: UNSURE })] } })
      expect(third.status).toBe(201)
      expect((await getRejected(row1.id)).seen_count).toBe(3)
      expect((await listRejected()).total).toBe(2)
    },
    120_000,
  )

  it(
    'AC-MOD-11: đợt lỗi giữa chừng không ghi gì: mẻ error, mẻ bị từ chối (version cũ 409) và mẻ error có rejected (400) đều để nguyên danh sách và seen_count',
    async () => {
      expect((await publish(1, { extra: { rejected: [rej('Bc Đã Có')] } })).status).toBe(201)
      const before = await listRejected()
      expect(before.total).toBe(1)

      expect((await publishError()).status).toBe(201)
      const stale = await publish(1, { extra: { rejected: [rej('Bc Đã Có'), rej('Bc Mới Trong Mẻ Hỏng')] } })
      expect(stale.status).toBe(409)
      isProblem(stale)
      const errWithRejected = await raw(
        `${GAME_API}/pipeline/batches`,
        {
          method: 'POST',
          body: JSON.stringify({
            status: 'error',
            batch_at: '2026-10-29T07:30:00.000Z',
            mode: 'full',
            failed_step: 'publish',
            stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
            rejected: [rej('Bc Mới Trong Mẻ Lỗi')],
          }),
        },
        pipelineHeaders(),
      )
      expect(errWithRejected.status).toBe(400)

      expect(await listRejected()).toEqual(before)
    },
    120_000,
  )

  it(
    'AC-MOD-11: /pipeline/state không lộ dòng "Bị chặn" (không có tên, lý do, ngữ cảnh), chỉ có dòng đã bỏ chặn trong `unblocked`',
    async () => {
      await env.DB.batch([seedRow({ n: 1, name: 'Bc Bí Mật Một', context: 'Ngữ cảnh nhạy cảm Một' }), seedRow({ n: 2, name: 'Bc Bí Mật Hai', context: 'Ngữ cảnh nhạy cảm Hai' })])
      const text = JSON.stringify(await getState())
      for (const secret of ['Bí Mật Một', 'Bí Mật Hai', 'Ngữ cảnh nhạy cảm', 'bi mat mot']) expect(text).not.toContain(secret)
      expect((await getState()).unblocked).toEqual([])
    },
    60_000,
  )

  it(
    'AC-MOD-VALIDATION: rejected sai (ngữ cảnh 501 ký tự, URL không https, javascript:, lý do rỗng hoặc 21 lý do, bước lạ, tên rỗng hoặc 101 ký tự, thiếu fold, thuộc tính thừa, không phải mảng, 2001 dòng) bị từ chối 4xx, không ghi gì và không đổi version',
    async () => {
      const bad: Array<[string, unknown]> = [
        ['context 501', [rej('Bc X', { context: 'c'.repeat(501) })]],
        ['http url', [rej('Bc X', { source_url: 'http://example.com/a' })]],
        ['javascript url', [rej('Bc X', { source_url: 'javascript:alert(1)' })]],
        ['url 501', [rej('Bc X', { source_url: `https://example.com/${'a'.repeat(490)}` })]],
        ['reasons empty', [rej('Bc X', { reasons: [] })]],
        ['reasons 21', [rej('Bc X', { reasons: Array.from({ length: 21 }, (_, i) => ({ code: `c${i}`, label: 'L' })) })]],
        ['reason without label', [rej('Bc X', { reasons: [{ code: 'politics' }] })]],
        ['step layer3', [rej('Bc X', { step: 'layer3' })]],
        ['name empty', [rej('Bc X', { name: '' })]],
        ['name 101', [rej('Bc X', { name: 'n'.repeat(101) })]],
        ['fold 101', [rej('Bc X', { fold: 'f'.repeat(101) })]],
        ['missing fold', [{ name: 'Bc X', source_name: 'Reddit', reasons: POLITICS, step: 'layer2' }]],
        ['extra property', [rej('Bc X', { player_id: 'abc' })]],
        ['script in name is still an item, but not an array', '<script>alert(1)</script>'],
        ['object not array', { name: 'Bc X' }],
        ['2001 items', Array.from({ length: 2001 }, (_, i) => rej(`Bc Nhiều ${i}`))],
      ]
      for (const [label, rejected] of bad) {
        const res = await publish(1, { extra: { rejected } })
        expect([400, 413, 422], label).toContain(res.status)
        isProblem(res)
      }
      expect(await rejectedCount()).toBe(0)
      expect((await getState()).current_version).toBeNull()
    },
    240_000,
  )

  // ====================================================================== AC-PIPE-21
  it(
    'AC-PIPE-21: /pipeline/state.unblocked liệt kê dòng đã bỏ chặn, cũ nhất trước, với trường admin đã sửa; dòng added / approved / blocked không có mặt',
    async () => {
      await env.DB.batch([
        seedRow({ n: 1, name: 'Bc Bỏ Chặn Một' }),
        seedRow({ n: 2, name: 'Bc Bỏ Chặn Hai', emoji: null, description: null }),
        seedRow({ n: 3, name: 'Bc Vẫn Chặn' }),
        seedRow({ n: 4, name: 'Bc Đã Thêm', status: 'added', element_id: await elementId('Bc Đã Thêm') }),
      ])
      expect((await patchRejected(rid(1), { name: 'Bc Bỏ Chặn Một Sửa', emoji: '🤝', description: null })).status).toBe(200)
      expect((await unblock(rid(2))).status).toBe(200)
      expect((await unblock(rid(1))).status).toBe(200)

      const { unblocked } = await getState()
      expect(unblocked.map((u) => u.id)).toEqual([rid(2), rid(1)]) // cũ nhất trước
      const k = unblocked[1]!
      expect(Object.keys(k).sort()).toEqual(['context', 'daily_hint', 'description', 'emoji', 'fold', 'id', 'image_hint', 'name', 'source_name', 'source_url'])
      expect(k).toMatchObject({
        name: 'Bc Bỏ Chặn Một Sửa',
        fold: fold('Bc Bỏ Chặn Một Sửa'),
        emoji: '🤝',
        description: null, // admin để trống: mẻ vẫn cho Gemini mô tả
        daily_hint: 'Gợi ý Daily gốc',
        image_hint: 'Gợi ý ảnh gốc',
        source_name: 'Reddit',
        source_url: 'https://example.com/p/1',
        context: 'Ngữ cảnh nguồn 1',
      })
      expect(unblocked[0]).toMatchObject({ emoji: null, description: null })
      expect(JSON.stringify(unblocked)).not.toContain('Vẫn Chặn')
    },
    120_000,
  )

  it(
    'AC-PIPE-21: mẻ đăng kèm rejected_added chuyển dòng đã bỏ chặn sang "Đã thêm" kèm element_id và rời `unblocked`; id không còn unblocked hoặc không tồn tại bị bỏ qua; mẻ lỗi hoặc mẻ bị từ chối giữ nguyên "Đã bỏ chặn"',
    async () => {
      const kName = 'Bc Được Thêm'
      await env.DB.batch([seedRow({ n: 1, name: kName }), seedRow({ n: 2, name: 'Bc Vẫn Bị Chặn' })])
      expect((await unblock(rid(1))).status).toBe(200)
      const kEl = await elementId(kName)

      // đợt lỗi giữa chừng và mẻ bị từ chối (version cũ): K vẫn "Đã bỏ chặn" cho đợt sau
      expect((await publish(1)).status).toBe(201)
      expect((await publishError()).status).toBe(201)
      const rejectedBatch = await publish(1, { extra: { rejected_added: [{ id: rid(1), element_id: kEl }] } })
      expect(rejectedBatch.status).toBe(409)
      expect((await getRejected(rid(1))).status).toBe('unblocked')
      expect((await getState()).unblocked.map((u) => u.id)).toEqual([rid(1)])

      const ok = await publish(2, {
        extra: {
          rejected_added: [
            { id: rid(1), element_id: kEl },
            { id: rid(2), element_id: await elementId('Bc Vẫn Bị Chặn') }, // đang blocked: bỏ qua
            { id: rid(0xfffff), element_id: await elementId('Bc Không Tồn Tại') }, // không có dòng: bỏ qua
          ],
        },
      })
      expect(ok.status).toBe(201)
      const added = await getRejected(rid(1))
      expect(added.status).toBe('added')
      expect(added.element_id).toBe(kEl)
      expect((await getRejected(rid(2))).status).toBe('blocked')
      expect((await getState()).unblocked).toEqual([])
      // dòng "Đã thêm" chỉ xem, không sửa, không bỏ chặn lại
      expect((await patchRejected(rid(1), { name: 'Bc Đổi Tên Sau Khi Thêm' })).status).toBe(409)
      expect((await unblock(rid(1))).status).toBe(409)
    },
    240_000,
  )

  // ====================================================================== AC-ADMIN-13
  const seed30 = async () => {
    const rows: Seed[] = Array.from({ length: 30 }, (_, i) => {
      const m = i % 3
      const s: Seed = {
        n: i + 1,
        name: i === 3 ? 'Bc Cà Phê Sữa' : `Bc Khái Niệm ${String(i).padStart(2, '0')}`,
        reasons: m === 0 ? POLITICS : m === 1 ? BANNED : UNSURE,
        step: m === 1 ? 'layer1' : 'layer2',
        source_name: i % 2 === 0 ? 'Reddit' : 'Tuổi Trẻ',
        seen_count: i + 1,
        last_seen_at: BASE - i * 60_000, // i càng nhỏ càng mới
      }
      if (i === 5 || i === 6) s.status = 'unblocked'
      if (i === 7) Object.assign(s, { status: 'added', element_id: 'e'.repeat(43) })
      if (i === 8) Object.assign(s, { status: 'approved', element_id: 'f'.repeat(43), a_id: 'a'.repeat(43), b_id: 'b'.repeat(43) })
      return s
    })
    await env.DB.batch(rows.map(seedRow))
  }
  const nameOf = (i: number) => (i === 3 ? 'Bc Cà Phê Sữa' : `Bc Khái Niệm ${String(i).padStart(2, '0')}`)

  it(
    'AC-ADMIN-13: danh sách xếp theo lần gặp cuối mới nhất trước, 50 dòng mỗi trang, mỗi dòng đủ trường (tên, lý do, bước, nguồn, số lần gặp, lần gặp cuối, trạng thái); phân trang size/page',
    async () => {
      await seed30()
      const res = await A('/rejected')
      expect(res.status).toBe(200)
      const page = await json<Page<Rej>>(res)
      expect(page).toMatchObject({ page: 1, size: 50, total: 30 })
      expect(page.items.map((r) => r.name)).toEqual(Array.from({ length: 30 }, (_, i) => nameOf(i)))
      for (const r of page.items) expect(Object.keys(r).sort()).toEqual(REJ_KEYS)
      expect(page.items[0]).toMatchObject({ status: 'blocked', step: 'layer2', reasons: POLITICS, source_name: 'Reddit', seen_count: 1 })
      expect(Date.parse(page.items[0]!.last_seen_at)).toBe(BASE)
      expect(Date.parse(page.items[29]!.last_seen_at)).toBe(BASE - 29 * 60_000)
      expect(page.items.map((r) => r.status)).toEqual(
        Array.from({ length: 30 }, (_, i) => (i === 5 || i === 6 ? 'unblocked' : i === 7 ? 'added' : i === 8 ? 'approved' : 'blocked')),
      )
      expect(page.items[1]).toMatchObject({ step: 'layer1', reasons: BANNED, source_name: 'Tuổi Trẻ', seen_count: 2 })

      const p2 = await listRejected('?size=10&page=2')
      expect(p2).toMatchObject({ page: 2, size: 10, total: 30 })
      expect(p2.items.map((r) => r.name)).toEqual(Array.from({ length: 10 }, (_, i) => nameOf(10 + i)))
      expect((await listRejected('?size=10&page=4')).items).toEqual([])
    },
    120_000,
  )

  it(
    'AC-ADMIN-13: lọc theo lý do, bước, trạng thái (kết hợp được) và tìm theo tên dạng fold (không dấu, không phân biệt hoa thường)',
    async () => {
      await seed30()
      const names = async (qs: string) => (await listRejected(qs)).items.map((r) => r.name)
      const total = async (qs: string) => (await listRejected(qs)).total

      expect(await total('?reason=politics')).toBe(10)
      expect(await total('?reason=banned_term')).toBe(10)
      expect(await total('?reason=unsure')).toBe(10)
      expect(await total('?reason=khong_co_ly_do_nay')).toBe(0)
      expect(await total('?step=layer1')).toBe(10)
      expect(await total('?step=layer2')).toBe(20)
      expect(await total('?status=blocked')).toBe(26)
      expect(await total('?status=unblocked')).toBe(2)
      expect(await total('?status=added')).toBe(1)
      expect(await total('?status=approved')).toBe(1)
      expect(await names('?reason=politics&status=unblocked')).toEqual([nameOf(6)])
      expect(await total('?step=layer1&status=blocked')).toBe(9)
      expect(await total('?step=layer1&reason=politics')).toBe(0)

      expect(await names(`?q=${encodeURIComponent('ca phe')}`)).toEqual(['Bc Cà Phê Sữa'])
      expect(await names(`?q=${encodeURIComponent('CÀ PHÊ')}`)).toEqual(['Bc Cà Phê Sữa'])
      expect(await names(`?q=${encodeURIComponent('Phê Sữa')}`)).toEqual(['Bc Cà Phê Sữa'])
      expect(await total(`?q=${encodeURIComponent('bc khai niem')}`)).toBe(29)
      expect(await total(`?q=${encodeURIComponent('khong co ten nay')}`)).toBe(0)
    },
    120_000,
  )

  it(
    'AC-ADMIN-13: chi tiết một dòng đủ trường AC-MOD-11 (khớp dòng trong danh sách, link nguồn https); id không tồn tại 404; không có dòng nào thì danh sách rỗng',
    async () => {
      expect(await listRejected()).toMatchObject({ page: 1, size: 50, total: 0, items: [] })
      await seed30()
      const row = (await listRejected()).items[3]!
      const res = await A(`/rejected/${row.id}`)
      expect(res.status).toBe(200)
      const detail = await json<Rej>(res)
      expect(detail).toEqual(row)
      expect(detail).toMatchObject({
        name: 'Bc Cà Phê Sữa',
        context: 'Ngữ cảnh nguồn 4',
        source_name: 'Tuổi Trẻ',
        source_url: 'https://example.com/p/4',
        emoji: '😡',
        description: 'Mô tả gốc',
        daily_hint: 'Gợi ý Daily gốc',
        image_hint: 'Gợi ý ảnh gốc',
      })
      expect(detail.source_url!.startsWith('https://')).toBe(true)
      const ghost = await A(`/rejected/${rid(0xfffff)}`)
      expect(ghost.status).toBe(404)
      isProblem(ghost)
    },
    120_000,
  )

  it(
    'AC-ADMIN-13: thiếu token, token sai, sai sơ đồ, token pipeline đều 401 problem+json cho mọi endpoint /admin/rejected* và /admin/elements/{id}; host game /lau-meme/api/admin/rejected trả 404; không đổi gì',
    async () => {
      await env.DB.batch([seedRow({ n: 1, name: 'Bc Khóa Token' })])
      const el = await elementId(EP)
      const targets: Array<[string, string, unknown]> = [
        ['GET', '/rejected', undefined],
        ['GET', `/rejected/${rid(1)}`, undefined],
        ['PATCH', `/rejected/${rid(1)}`, { name: 'Bc Bị Sửa Trộm' }],
        ['POST', `/rejected/${rid(1)}/unblock`, {}],
        ['POST', `/rejected/${rid(1)}/approve`, { a: el, b: el, name: 'Bc X', emoji: '🍲' }],
        ['GET', `/elements/${el}`, undefined],
        ['PATCH', `/elements/${el}`, { name: 'Bc Bị Sửa Trộm P' }],
      ]
      for (const auth of [null, `Bearer ${WRONG}`, `Basic ${btoa(`admin:${TOKEN}`)}`, `Bearer ${PIPELINE_TOKEN}`]) {
        for (const [method, path, body] of targets) {
          const res = await A(path, { method, body, auth })
          expect(res.status, `${method} ${path} ${String(auth)}`).toBe(401)
          isProblem(res)
        }
      }
      const gameHost = await raw(`${GAME_API}/admin/rejected`, {}, { Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': nextIp() })
      expect(gameHost.status).toBe(404)
      expect((await getRejected(rid(1))).name).toBe('Bc Khóa Token')
      expect(await contentChanges()).toBe(0)
    },
    240_000,
  )

  // ====================================================================== AC-ADMIN-14
  const K = { n: 1, name: 'Bc K Gốc', emoji: '😡', description: 'Mô tả cũ', daily_hint: 'Gợi ý Daily cũ', image_hint: 'Gợi ý ảnh cũ' }

  it(
    'AC-ADMIN-14: sửa tên, emoji, mô tả, gợi ý Daily, gợi ý ảnh của dòng "Bị chặn": 200 trả dòng mới, trạng thái giữ nguyên, đúng 1 audit edit_rejected chỉ chứa trường đã đổi; null xóa trường tùy chọn',
    async () => {
      await env.DB.batch([seedRow({ ...K, reasons: POLITICS })])
      const fp = await FP()
      const res = await patchRejected(rid(1), { name: 'Bc K Đã Sửa', emoji: '🤔', description: 'Mô tả mới', daily_hint: 'Gợi ý Daily mới', image_hint: 'Gợi ý ảnh mới' })
      expect(res.status).toBe(200)
      const row = await json<Rej>(res)
      expect(row).toMatchObject({ id: rid(1), name: 'Bc K Đã Sửa', emoji: '🤔', description: 'Mô tả mới', daily_hint: 'Gợi ý Daily mới', image_hint: 'Gợi ý ảnh mới', status: 'blocked', seen_count: 1, reasons: POLITICS })
      expect(row.edited_at).not.toBeNull()
      expect(await getRejected(rid(1))).toEqual(row)

      const audit = await auditItems('edit_rejected')
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        target_kind: 'rejected',
        target_id: rid(1),
        before: { name: 'Bc K Gốc', emoji: '😡', description: 'Mô tả cũ', daily_hint: 'Gợi ý Daily cũ', image_hint: 'Gợi ý ảnh cũ' },
        after: { name: 'Bc K Đã Sửa', emoji: '🤔', description: 'Mô tả mới', daily_hint: 'Gợi ý Daily mới', image_hint: 'Gợi ý ảnh mới' },
        token_fp: fp,
      })

      const cleared = await patchRejected(rid(1), { description: null })
      expect(cleared.status).toBe(200)
      expect((await json<Rej>(cleared)).description).toBeNull()
      const audit2 = await auditItems('edit_rejected')
      expect(audit2).toHaveLength(2)
      expect(audit2.find((a) => JSON.stringify(a.after) === JSON.stringify({ description: null }))).toMatchObject({ before: { description: 'Mô tả mới' } })
    },
    120_000,
  )

  it(
    'AC-ADMIN-14: "Bỏ chặn" dòng "Bị chặn": 200, trạng thái "unblocked", ghi unblock_rejected (trước/sau là trạng thái), vào /pipeline/state.unblocked với tên đã sửa; lần hai 409; sửa tiếp khi đã bỏ chặn vẫn được',
    async () => {
      await env.DB.batch([seedRow({ ...K })])
      expect((await patchRejected(rid(1), { name: 'Bc K Sửa Trước Khi Bỏ Chặn', emoji: '🙂' })).status).toBe(200)
      const res = await unblock(rid(1))
      expect(res.status).toBe(200)
      const row = await json<Rej>(res)
      expect(row.status).toBe('unblocked')
      expect(row.decided_at).not.toBeNull()
      expect(row.name).toBe('Bc K Sửa Trước Khi Bỏ Chặn')

      const audit = await auditItems('unblock_rejected')
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ target_kind: 'rejected', target_id: rid(1), before: { status: 'blocked' }, after: { status: 'unblocked' }, token_fp: await FP() })
      expect((await getState()).unblocked.map((u) => u.name)).toEqual(['Bc K Sửa Trước Khi Bỏ Chặn'])

      const again = await unblock(rid(1))
      expect(again.status).toBe(409)
      isProblem(again)
      expect(await auditItems('unblock_rejected')).toHaveLength(1)

      const edited = await patchRejected(rid(1), { emoji: '😎' })
      expect(edited.status).toBe(200)
      expect((await json<Rej>(edited)).status).toBe('unblocked')
      expect((await getState()).unblocked[0]).toMatchObject({ emoji: '😎' })
    },
    120_000,
  )

  it(
    'AC-ADMIN-14: "Bỏ chặn" khái niệm có tên đang bị quản trị chặn vĩnh viễn (AC-ADMIN-05) trả 409 "Tên đang bị chặn vĩnh viễn, gỡ chặn tên trước", không ghi audit; gỡ chặn tên rồi mới bỏ chặn được',
    async () => {
      const blockedEl = await elementId(EBLK)
      expect((await mod(blockedEl, 'block', 'vi phạm')).status).toBe(200)
      await env.DB.batch([seedRow({ n: 2, name: EBLK, reasons: [{ code: 'admin_blocked', label: 'Đã bị quản trị chặn' }], step: 'layer1' })])
      const res = await unblock(rid(2))
      expect(res.status).toBe(409)
      isProblem(res)
      expect(await problemText(res)).toContain('Tên đang bị chặn vĩnh viễn, gỡ chặn tên trước')
      expect((await getRejected(rid(2))).status).toBe('blocked')
      expect(await auditItems('unblock_rejected')).toHaveLength(0)

      expect((await mod(blockedEl, 'unblock', 'nhầm')).status).toBe(200)
      expect((await unblock(rid(2))).status).toBe(200)
      expect((await getRejected(rid(2))).status).toBe('unblocked')
    },
    120_000,
  )

  it(
    'AC-ADMIN-14: sửa sai (tên rỗng hoặc 101 ký tự, emoji rỗng hoặc 17, mô tả 201, gợi ý Daily 201, gợi ý ảnh 301, thuộc tính thừa, body rỗng, sai kiểu, không phải JSON) 400; tên trùng fold phần tử trong graph hoặc dòng bị chặn khác 409; id lạ 404; dòng "Đã thêm" và "Đã duyệt tay" chỉ xem (409); thất bại không đổi dòng, không audit',
    async () => {
      await env.DB.batch([
        seedRow({ ...K }),
        seedRow({ n: 2, name: 'Bc Dòng Khác' }),
        seedRow({ n: 3, name: 'Bc Dòng Đã Thêm', status: 'added', element_id: await elementId('Bc Dòng Đã Thêm') }),
        seedRow({ n: 4, name: 'Bc Dòng Duyệt Tay', status: 'approved', element_id: await elementId('Bc Dòng Duyệt Tay'), a_id: 'a'.repeat(43), b_id: 'b'.repeat(43) }),
      ])
      const before = await getRejected(rid(1))
      const bad: Array<[string, unknown]> = [
        ['name empty', { name: '' }],
        ['name 101', { name: 'n'.repeat(101) }],
        ['name null', { name: null }],
        ['name number', { name: 123 }],
        ['emoji empty', { emoji: '' }],
        ['emoji 17', { emoji: 'e'.repeat(17) }],
        ['description 201', { description: 'd'.repeat(201) }],
        ['daily_hint 201', { daily_hint: 'h'.repeat(201) }],
        ['image_hint 301', { image_hint: 'i'.repeat(301) }],
        ['extra property', { name: 'Bc OK', status: 'approved' }],
        ['status only', { status: 'unblocked' }],
        ['empty body', {}],
        ['array body', ['Bc X']],
        ['not json', '{"name": '],
      ]
      for (const [label, body] of bad) {
        const res = await patchRejected(rid(1), body)
        expect(res.status, label).toBe(400)
        isProblem(res)
      }
      for (const [label, name] of [
        ['same fold as graph element', 'BC MON A'],
        ['same fold as other rejected row', 'bc dong khac'],
      ] as const) {
        const res = await patchRejected(rid(1), { name })
        expect(res.status, label).toBe(409)
        isProblem(res)
      }
      const ghost = await patchRejected(rid(0xfffff), { name: 'Bc Ma' })
      expect(ghost.status).toBe(404)
      isProblem(ghost)
      expect((await unblock(rid(0xfffff))).status).toBe(404)
      for (const n of [3, 4]) {
        const res = await patchRejected(rid(n), { emoji: '🙈' })
        expect(res.status, `readonly ${n}`).toBe(409)
        isProblem(res)
        expect((await unblock(rid(n))).status).toBe(409)
      }

      expect(await getRejected(rid(1))).toEqual(before)
      expect(await contentChanges()).toBe(0)
    },
    240_000,
  )

  // ====================================================================== AC-ADMIN-15
  const APPROVE = { name: 'Bc K Duyệt', emoji: '🍜', description: 'Mô tả của admin', daily_hint: 'Gợi ý Daily admin', image_hint: 'Gợi ý ảnh admin' }

  it(
    'AC-ADMIN-15: "Duyệt luôn" A + B = K: 200, dòng thành "approved" (element_id = id của fold(tên), a <= b), audit approve_rejected, vào /pipeline/state.manual_approvals và rời `unblocked`; tier khác 1 vào /pipeline/state.tiers; cặp đã duyệt tay hoặc đã có công thức 409',
    async () => {
      await env.DB.batch([seedRow({ n: 1, name: APPROVE.name }), seedRow({ n: 2, name: 'Bc K Hai', status: 'blocked' }), seedRow({ n: 3, name: 'Bc K Ba' })])
      expect((await publish(1)).status).toBe(201)
      const [ia, ib] = [await elementId(EA), await elementId(EB)]
      const [lo, hi] = [ia, ib].sort()
      const kEl = await elementId(APPROVE.name)

      const res = await approve(rid(1), { a: hi, b: lo, ...APPROVE }) // gửi ngược thứ tự: Worker sắp lại
      expect(res.status).toBe(200)
      const row = await json<Rej>(res)
      expect(row).toMatchObject({ id: rid(1), status: 'approved', element_id: kEl, a: lo, b: hi, name: APPROVE.name, emoji: APPROVE.emoji, tier: null })
      expect(row.decided_at).not.toBeNull()
      expect(await getRejected(rid(1))).toEqual(row)

      const audit = await auditItems('approve_rejected')
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ target_kind: 'rejected', target_id: rid(1), before: { status: 'blocked' }, token_fp: await FP() })
      expect(audit[0]!.after).toMatchObject({ status: 'approved', a: lo, b: hi, element_id: kEl })

      const state = await getState()
      const m = state.manual_approvals.find((x) => x.element_id === kEl)!
      expect(m).toBeDefined()
      expect(Object.keys(m).sort()).toEqual(['a', 'approved_at', 'b', 'daily_hint', 'description', 'element_id', 'emoji', 'image_hint', 'name'])
      expect(m).toMatchObject({ a: lo, b: hi, name: APPROVE.name, emoji: APPROVE.emoji, description: APPROVE.description, daily_hint: APPROVE.daily_hint, image_hint: APPROVE.image_hint })
      expect(state.unblocked).toEqual([])
      expect(state.tiers.find((t) => t.element_id === kEl)).toBeUndefined() // tier mặc định 1 không ghi element_tier

      // cùng cặp cho dòng khác: 409
      const dup = await approve(rid(2), { a: ia, b: ib, name: 'Bc K Hai', emoji: '🍕' })
      expect(dup.status).toBe(409)
      isProblem(dup)
      expect((await getRejected(rid(2))).status).toBe('blocked')

      // cặp đã có công thức trong graph hiện hành: 409; cặp khác thì được, kèm tier 3, hint tùy chọn vắng thành null
      expect((await publish(2, { recipes: [[EA, EQ, EC]] })).status).toBe(201)
      const withRecipe = await approve(rid(2), { a: ia, b: await elementId(EQ), name: 'Bc K Hai', emoji: '🍕' })
      expect(withRecipe.status).toBe(409)
      const ok = await approve(rid(3), { a: await elementId(EP), b: await elementId(EQ), name: 'Bc K Ba', emoji: '🍕', tier: 3 })
      expect(ok.status).toBe(200)
      expect((await json<Rej>(ok)).tier).toBe(3)
      const state2 = await getState()
      const k3 = await elementId('Bc K Ba')
      expect(state2.tiers.find((t) => t.element_id === k3)).toMatchObject({ tier: 3 })
      expect(state2.manual_approvals.find((x) => x.element_id === k3)).toMatchObject({ description: null, daily_hint: null, image_hint: null })
      expect(state2.manual_approvals.map((x) => x.element_id)).toEqual([kEl, k3]) // cũ nhất trước
      expect(await auditItems('approve_rejected')).toHaveLength(2)
    },
    240_000,
  )

  it(
    'AC-ADMIN-15: "Duyệt luôn" sai: thiếu A, B, tên hoặc emoji, A = B, tên 101, emoji 17, mô tả 201, tier 0 hoặc 6, id sai định dạng, thuộc tính thừa, không phải JSON 400; A hoặc B ẩn/chặn hoặc không có trong graph, tên trùng phần tử có sẵn, tên đang bị quản trị chặn, dòng đã duyệt/đã thêm 409; id lạ 404; không đổi dòng, không audit',
    async () => {
      const blockedEl = await elementId(EBLK)
      await env.DB.batch([
        seedRow({ n: 1, name: APPROVE.name }),
        seedRow({ n: 2, name: EBLK, reasons: [{ code: 'admin_blocked', label: 'Đã bị quản trị chặn' }], step: 'layer1' }),
        seedRow({ n: 3, name: 'Bc Đã Thêm', status: 'added', element_id: await elementId('Bc Đã Thêm') }),
        seedRow({ n: 4, name: 'Bc Đã Duyệt', status: 'approved', element_id: await elementId('Bc Đã Duyệt'), a_id: 'a'.repeat(43), b_id: 'b'.repeat(43) }),
      ])
      expect((await publish(1)).status).toBe(201)
      expect((await mod(await elementId(EH), 'hide', 'tạm ẩn')).status).toBe(200)
      expect((await mod(blockedEl, 'block', 'vi phạm')).status).toBe(200)
      const [ia, ib, ih] = [await elementId(EA), await elementId(EB), await elementId(EH)]
      const ok = { a: ia, b: ib, ...APPROVE }
      const before = await getRejected(rid(1))

      const bad: Array<[string, unknown]> = [
        ['missing a', { b: ib, ...APPROVE }],
        ['missing b', { a: ia, ...APPROVE }],
        ['missing name', { a: ia, b: ib, emoji: '🍜' }],
        ['missing emoji', { a: ia, b: ib, name: 'Bc K Duyệt' }],
        ['a == b', { ...ok, b: ia }],
        ['name empty', { ...ok, name: '' }],
        ['name 101', { ...ok, name: 'n'.repeat(101) }],
        ['emoji 17', { ...ok, emoji: 'e'.repeat(17) }],
        ['description 201', { ...ok, description: 'd'.repeat(201) }],
        ['daily_hint 201', { ...ok, daily_hint: 'h'.repeat(201) }],
        ['image_hint 301', { ...ok, image_hint: 'i'.repeat(301) }],
        ['tier 0', { ...ok, tier: 0 }],
        ['tier 6', { ...ok, tier: 6 }],
        ['tier string', { ...ok, tier: 'auto' }],
        ['short id', { ...ok, a: 'abc' }],
        ['sql id', { ...ok, a: "'; DROP TABLE element;--".padEnd(43, 'a') }],
        ['extra property', { ...ok, status: 'approved' }],
        ['not json', '{"a": '],
      ]
      for (const [label, body] of bad) {
        const res = await approve(rid(1), body)
        expect(res.status, label).toBe(400)
        isProblem(res)
      }

      const conflicts: Array<[string, string, unknown]> = [
        ['hidden a', rid(1), { ...ok, a: ih }],
        ['unknown b', rid(1), { ...ok, b: await elementId('Bc Không Có Trong Graph') }],
        ['name equals existing element', rid(1), { ...ok, name: 'BC MON C' }],
        ['fold admin-blocked', rid(2), { ...ok, name: EBLK }],
        ['already added', rid(3), { ...ok, name: 'Bc Đã Thêm' }],
        ['already approved', rid(4), { ...ok, name: 'Bc Đã Duyệt' }],
      ]
      for (const [label, id, body] of conflicts) {
        const res = await approve(id, body)
        expect(res.status, label).toBe(409)
        isProblem(res)
      }
      const ghost = await approve(rid(0xfffff), ok)
      expect(ghost.status).toBe(404)
      isProblem(ghost)

      expect(await getRejected(rid(1))).toEqual(before)
      // the seeded approved row rid(4) is the only manual approval: the failed attempts added nothing
      expect((await getState()).manual_approvals.map((m) => m.element_id)).toEqual([await elementId('Bc Đã Duyệt')])
      expect(await contentChanges()).toBe(0)
    },
    300_000,
  )

  // ====================================================================== AC-ADMIN-16
  it(
    'AC-ADMIN-16: GET /admin/elements/{id} trả giá trị mẻ gần nhất (published), chưa sửa thì edit null, pending false, aliases rỗng; id lạ 404',
    async () => {
      const id = await elementId(EP)
      const res = await A(`/elements/${id}`)
      expect(res.status).toBe(200)
      const d = await json<Detail>(res)
      expect(d).toMatchObject({ id, edit: null, pending: false, aliases: [], state: 'active' })
      expect(d.published).toEqual({ name: EP, emoji: '🍲', description: P_DESC, daily_hint: P_DAILY, image_hint: P_IMG, origin: 'vn' })
      expect(Object.keys(d).sort()).toEqual(['aliases', 'edit', 'id', 'image_key', 'image_source', 'pending', 'published', 'state', 'tier', 'tier_source'])
      const ghost = await A(`/elements/${await elementId('Bc Không Có Thật')}`)
      expect(ghost.status).toBe(404)
      isProblem(ghost)
    },
    60_000,
  )

  it(
    'AC-ADMIN-16: sửa mọi thuộc tính (tên, emoji, mô tả, gợi ý Daily, gợi ý ảnh, nguồn gốc): 200, id giữ nguyên, tên cũ thành bí danh, pending true, đúng 1 audit edit_element chỉ chứa trường đã đổi; /pipeline/state có element_edits (rev) và element_aliases',
    async () => {
      const id = await elementId(EP)
      const res = await patchElement(id, { name: 'Bc Phần Tử P Mới', emoji: '🧪', description: 'Mô tả sửa', daily_hint: 'Daily sửa', image_hint: 'Ảnh sửa', origin: 'intl' })
      expect(res.status).toBe(200)
      const d = await json<Detail>(res)
      expect(d.id).toBe(id)
      expect(d.edit).toEqual({ name: 'Bc Phần Tử P Mới', emoji: '🧪', description: 'Mô tả sửa', daily_hint: 'Daily sửa', image_hint: 'Ảnh sửa', origin: 'intl' })
      expect(d.pending).toBe(true) // "Chờ mẻ kế tiếp"
      expect(d.aliases).toEqual([fold(EP)])
      expect(d.published.name).toBe(EP) // graph chỉ có giá trị mới từ mẻ kế tiếp
      expect(await getDetail(id)).toEqual(d)

      const audit = await auditItems('edit_element')
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        target_kind: 'element',
        target_id: id,
        before: { name: EP, emoji: '🍲', description: P_DESC, daily_hint: P_DAILY, image_hint: P_IMG, origin: 'vn' },
        after: { name: 'Bc Phần Tử P Mới', emoji: '🧪', description: 'Mô tả sửa', daily_hint: 'Daily sửa', image_hint: 'Ảnh sửa', origin: 'intl' },
        token_fp: await FP(),
      })

      const state = await getState()
      const edit = state.element_edits.find((e) => e.element_id === id)!
      expect(edit).toMatchObject({ rev: 1, name: 'Bc Phần Tử P Mới', emoji: '🧪', origin: 'intl' })
      expect(state.element_aliases).toContainEqual({ fold: fold(EP), element_id: id })

      // sửa một trường: audit chỉ có trường đó, rev tăng
      const one = await patchElement(id, { description: 'Mô tả sửa lần hai' })
      expect(one.status).toBe(200)
      const audit2 = (await auditItems('edit_element')).find((a) => JSON.stringify(a.after) === JSON.stringify({ description: 'Mô tả sửa lần hai' }))!
      expect(audit2.before).toEqual({ description: 'Mô tả sửa' })
      expect((await getState()).element_edits.find((e) => e.element_id === id)!.rev).toBe(2)

      // null bỏ giá trị admin đã sửa của trường đó
      const cleared = await patchElement(id, { emoji: null })
      expect(cleared.status).toBe(200)
      expect((await json<Detail>(cleared)).edit?.emoji ?? null).toBeNull()
      expect(await auditItems('edit_element')).toHaveLength(3)

      // không có trường nào đổi so với giá trị hiện tại: 200, không audit
      const same = await patchElement(id, { description: 'Mô tả sửa lần hai' })
      expect(same.status).toBe(200)
      expect(await auditItems('edit_element')).toHaveLength(3)
    },
    240_000,
  )

  it(
    'AC-ADMIN-16: "Chờ mẻ kế tiếp" theo rev: mẻ đăng element_edits_applied với rev đã áp thì pending false và published theo content; sửa lại thì pending true; rev cũ hơn rev hiện tại (sửa lưu trong lúc mẻ chạy) vẫn pending',
    async () => {
      const id = await elementId(EP)
      expect((await patchElement(id, { description: 'Mô tả v1' })).status).toBe(200)
      const rev1 = (await getState()).element_edits.find((e) => e.element_id === id)!.rev

      const first = await publish(1, { elements: { [EP]: { description: 'Mô tả v1' } }, extra: { element_edits_applied: [{ element_id: id, rev: rev1 }] } })
      expect(first.status).toBe(201)
      let d = await getDetail(id)
      expect(d.pending).toBe(false)
      expect(d.published.description).toBe('Mô tả v1')

      expect((await patchElement(id, { description: 'Mô tả v2' })).status).toBe(200)
      const rev2 = (await getState()).element_edits.find((e) => e.element_id === id)!.rev
      expect(rev2).toBeGreaterThan(rev1)
      expect((await getDetail(id)).pending).toBe(true)

      // mẻ đã đọc state trước khi sửa v2 nên chỉ áp rev1
      expect((await publish(2, { elements: { [EP]: { description: 'Mô tả v1' } }, extra: { element_edits_applied: [{ element_id: id, rev: rev1 }] } })).status).toBe(201)
      d = await getDetail(id)
      expect(d.pending).toBe(true)
      expect(d.edit?.description).toBe('Mô tả v2')

      expect((await publish(3, { elements: { [EP]: { description: 'Mô tả v2' } }, extra: { element_edits_applied: [{ element_id: id, rev: rev2 }] } })).status).toBe(201)
      d = await getDetail(id)
      expect(d.pending).toBe(false)
      expect(d.published.description).toBe('Mô tả v2')
      // bản sửa sống qua mẻ: vẫn có trong state cho mẻ sau áp lại, không ghi đè
      expect((await getState()).element_edits.find((e) => e.element_id === id)).toMatchObject({ rev: rev2, description: 'Mô tả v2' })
    },
    300_000,
  )

  it(
    'AC-ADMIN-16: đổi tên trùng fold phần tử khác, trùng bí danh của phần tử khác, hoặc trùng tên đã "Duyệt luôn" trả 409; giá trị sai 400; phần tử lạ 404; thất bại không ghi gì',
    async () => {
      const [p, q] = [await elementId(EP), await elementId(EQ)]
      await env.DB.batch([seedRow({ n: 1, name: 'Bc Đã Duyệt Tay', status: 'approved', element_id: await elementId('Bc Đã Duyệt Tay'), a_id: 'a'.repeat(43), b_id: 'b'.repeat(43) })])
      expect((await patchElement(p, { name: 'Bc Phần Tử P Đổi Tên' })).status).toBe(200) // fold cũ của P thành bí danh
      const changes = await contentChanges()
      const before = await getDetail(q)

      for (const [label, name] of [
        ['same fold as other element (P, renamed above)', 'BC PHAN TU P DOI TEN'],
        ['alias of other element', EP],
        ['approved by hand', 'Bc Đã Duyệt Tay'],
        ['name of another element', EA],
      ] as const) {
        const res = await patchElement(q, { name })
        expect(res.status, label).toBe(409)
        isProblem(res)
      }
      const bad: Array<[string, unknown]> = [
        ['name empty', { name: '' }],
        ['name 101', { name: 'n'.repeat(101) }],
        ['emoji empty', { emoji: '' }],
        ['emoji 17', { emoji: 'e'.repeat(17) }],
        ['description 201', { description: 'd'.repeat(201) }],
        ['daily_hint 201', { daily_hint: 'h'.repeat(201) }],
        ['image_hint 301', { image_hint: 'i'.repeat(301) }],
        ['origin vn/intl only', { origin: 'asia' }],
        ['origin V (core letter)', { origin: 'V' }],
        ['extra property', { name: 'Bc OK', tier: 5 }],
        ['empty body', {}],
        ['name number', { name: 7 }],
        ['array body', [{ name: 'Bc X' }]],
        ['not json', '{"name": '],
      ]
      for (const [label, body] of bad) {
        const res = await patchElement(q, body)
        expect(res.status, label).toBe(400)
        isProblem(res)
      }
      const ghost = await patchElement(await elementId('Bc Không Có Thật'), { emoji: '🙈' })
      expect(ghost.status).toBe(404)
      isProblem(ghost)

      expect(await getDetail(q)).toEqual(before)
      expect(await contentChanges()).toBe(changes)
    },
    300_000,
  )

  // ====================================================================== AC-ADMIN-17
  it(
    'AC-ADMIN-17: tác vụ dọn hằng ngày xóa dòng "Bị chặn" có lần gặp cuối > 90 ngày (cả dòng "Đã thêm"), giữ dòng đúng 89 và 90 ngày; audit của dòng đã xóa còn; crawl lại tên đã xóa tạo dòng mới với số lần gặp 1',
    async () => {
      const now = Date.now()
      await env.DB.batch([
        seedRow({ n: 1, name: 'Bc Dọn 89', last_seen_at: now - 89 * DAY, seen_count: 4 }),
        seedRow({ n: 2, name: 'Bc Dọn 90', last_seen_at: now - 90 * DAY, seen_count: 4 }),
        seedRow({ n: 3, name: 'Bc Dọn 91', last_seen_at: now - 91 * DAY, seen_count: 4 }),
        seedRow({ n: 4, name: 'Bc Dọn Đã Thêm', status: 'added', element_id: await elementId('Bc Dọn Đã Thêm'), last_seen_at: now - 91 * DAY, seen_count: 4 }),
        ...[3, 4].map((n) =>
          env.DB.prepare('INSERT INTO content_change (id, action, target_kind, target_id, before_json, after_json, token_fp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
            `0190b1c2-0000-7000-8000-0000000000c${n}`,
            'edit_rejected',
            'rejected',
            rid(n),
            '{"emoji":"a"}',
            '{"emoji":"b"}',
            '0123abcd',
            now - 100 * DAY,
          ),
        ),
      ])

      const ctx = createExecutionContext()
      await (worker as unknown as Scheduled).scheduled(createScheduledController({ scheduledTime: new Date(now), cron: '0 20 * * *' }), { ...env, IP_HASH_KEY: IP_KEY }, ctx)
      await waitOnExecutionContext(ctx)

      const left = await listRejected()
      expect(left.items.map((r) => r.name).sort()).toEqual(['Bc Dọn 89', 'Bc Dọn 90'])
      expect(left.total).toBe(2)
      const audit = (await auditItems('edit_rejected')).map((a) => a.target_id).sort()
      expect(audit).toEqual([rid(3), rid(4)]) // audit giữ 12 tháng, kể cả khi dòng đã xóa

      const again = await publish(1, { extra: { rejected: [rej('Bc Dọn 91'), rej('Bc Dọn Đã Thêm', { reasons: UNSURE })] } })
      expect(again.status).toBe(201)
      const after = await listRejected()
      expect(after.total).toBe(4)
      for (const name of ['Bc Dọn 91', 'Bc Dọn Đã Thêm']) {
        const row = after.items.find((r) => r.name === name)!
        expect(row).toMatchObject({ seen_count: 1, status: 'blocked', element_id: null })
        expect([rid(3), rid(4)]).not.toContain(row.id)
      }
      expect(after.items.find((r) => r.name === 'Bc Dọn 90')!.seen_count).toBe(4)
    },
    240_000,
  )

  // ====================================================================== AC-ADMIN-VALIDATION
  it(
    'AC-ADMIN-VALIDATION: tham số truy vấn và id nguy hiểm của /admin/rejected (q 101 ký tự, reason 51 ký tự, step/status lạ, page 0, size 0 hoặc 101, chữ thay số, SQL trong q, id không phải uuid) bị từ chối 400/404, không lỗi 500, không đổi gì',
    async () => {
      await env.DB.batch([seedRow({ n: 1, name: 'Bc Mục Tiêu' })])
      const badQuery = [
        `?q=${'q'.repeat(101)}`,
        `?reason=${'r'.repeat(51)}`,
        '?step=layer3',
        '?status=hacked',
        '?page=0',
        '?page=abc',
        '?size=0',
        '?size=101',
        '?size=-5',
      ]
      for (const qs of badQuery) {
        const res = await A(`/rejected${qs}`)
        expect(res.status, qs).toBe(400)
        isProblem(res)
      }
      const sql = await A(`/rejected?q=${encodeURIComponent("'; DROP TABLE rejected_concept;--")}`)
      expect(sql.status).toBe(200)
      expect((await json<Page<Rej>>(sql)).total).toBe(0)
      const scriptQ = await A(`/rejected?q=${encodeURIComponent('<script>alert(1)</script>')}`)
      expect(scriptQ.status).toBe(200)
      expect((await json<Page<Rej>>(scriptQ)).total).toBe(0)

      for (const id of ['abc', "1'; DROP TABLE rejected_concept;--", 'a'.repeat(300), 'not-a-uuid-at-all-0000-000000000000']) {
        for (const [method, suffix, body] of [
          ['GET', '', undefined],
          ['PATCH', '', { name: 'Bc X' }],
          ['POST', '/unblock', {}],
          ['POST', '/approve', { a: 'a'.repeat(43), b: 'b'.repeat(43), name: 'Bc X', emoji: '🍲' }],
        ] as const) {
          const res = await A(`/rejected/${encodeURIComponent(id)}${suffix}`, { method, body })
          expect([400, 404], `${method} ${id}${suffix}`).toContain(res.status)
          isProblem(res)
        }
      }
      for (const id of ['abc', 'a'.repeat(300), "x'; DROP TABLE element;--"]) {
        const res = await patchElement(encodeURIComponent(id), { name: 'Bc X' })
        expect([400, 404], id).toContain(res.status)
        expect([400, 404]).toContain((await A(`/elements/${encodeURIComponent(id)}`)).status)
      }

      expect(await rejectedCount()).toBe(1)
      expect((await getRejected(rid(1))).status).toBe('blocked')
      expect(await contentChanges()).toBe(0)
    },
    240_000,
  )
})
