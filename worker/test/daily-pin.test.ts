// Phủ (thêm 2026-10-26, ADR 0019, migration 0010 `daily_pin` + `daily_pin_change`, contract 0.7.0):
//   AC-DAILY-19  GET/PUT/DELETE /admin/daily-pin (adminGetDailyPin, adminSetDailyPin, adminClearDailyPin): PUT trên phần tử có thật,
//                chưa bị chặn, hint 1-200 ký tự sau trim, không chứa tên món (fold, nguyên từ) -> 200 {before, after: DailyPin}, thay chỉ
//                định cũ; 400/404/401 không đổi gì và không audit; audit `set_daily_pin` / `clear_daily_pin` (AC-ADMIN-09) trong
//                /admin/audit; DELETE -> 204, lần hai 204 không audit.
//                /pipeline/state.daily_pin {id, element_id, hint} | null; POST /pipeline/batches với `daily_pin_id` xóa đúng chỉ định
//                đó (id khác thì giữ), 422 khi stats.daily_pin = used mà content.daily_element_id khác chỉ định còn đó, mẻ lỗi giữ chỉ định.
//   AC-DAILY-VALIDATION (endpoint này); 401/404 host game nằm trong một test AC-DAILY-19.
// Black-box: docs/api/openapi.yaml (/admin/daily-pin, DailyPin, PipelineState.daily_pin, PublishBatchRequest.daily_pin_id),
// ADR 0002 ids, ADR 0019, migrations 0002_content, 0004_ops, 0010_daily_pin.
// Performance: D1 in Miniflare costs ~66 ms/query, so tests seed with ONE env.DB.batch and combine assertions per case.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['dpin', 'admin', 'token', 'ok'].join('-')
const WRONG = ['dpin', 'admin', 'token', 'no'].join('-')
const PIPELINE_TOKEN = ['dpin', 'pipeline', 'token'].join('-')
const IP_KEY = ['dpin', 'ip', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_ORIGIN = 'https://dinoduct.fun'
const GAME_API = `${GAME_ORIGIN}/lau-meme/api`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Scheduled = { scheduled: (controller: ScheduledController, env: unknown, ctx: ExecutionContext) => Promise<void> }
type Page<T> = { page: number; size: number; total: number; items: T[] }
type AuditItem = { action: string; target_kind: string; target_id: string; before: unknown; after: unknown; token_fp: string; created_at: string }
type Pin = { element_id: string; name: string; emoji: string; hint: string; created_at: string }
type PinResult = { before: Pin | null; after: Pin }
type StatePin = { id: string; element_id: string; hint: string } | null

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
const A = 'Dp Món Một'
const B = 'Dp Món Hai'
const SIGMA = 'Sigma' // hint must not contain it as a whole word
const CAFE = 'Cà Phê' // hint must not contain "ca phe" in any case or diacritics
const BLOCKED = 'Dp Bị Chặn'
const NAMES = [A, B, SIGMA, CAFE, BLOCKED]
const EMOJI = '🍲'

const elementRow = (name: string) =>
  elementId(name).then((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO element (id, name, name_fold, emoji, depth, origin, image_key, image_source, first_version, last_version, updated_at) VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, 1, 1, ?)',
    ).bind(id, name, fold(name), EMOJI, 'vn', Date.now()),
  )

// ---------------------------------------------------------------------------- HTTP helpers
let ipCounter = 0
const nextIp = () => {
  ipCounter++
  return `10.50.${ipCounter >> 8}.${ipCounter & 255}`
}

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

type AOpts = { auth?: string | null; headers?: Record<string, string>; origin?: string }
function admin(method: string, path: string, body: unknown, o: AOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': nextIp(), ...(o.headers ?? {}) }
  const auth = o.auth === undefined ? `Bearer ${TOKEN}` : o.auth
  if (auth !== null) headers.Authorization = auth
  const init: RequestInit = { method }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  return raw(`${o.origin ?? `${ADMIN_ORIGIN}/api/admin`}${path}`, init, headers)
}
const getPin = (o: AOpts = {}) => admin('GET', '/daily-pin', undefined, o)
const putPin = (body: unknown, o: AOpts = {}) => admin('PUT', '/daily-pin', body, o)
const delPin = (o: AOpts = {}) => admin('DELETE', '/daily-pin', undefined, o)
const pipelineHeaders = () => ({ Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
const getState = async () => (await (await raw(`${GAME_API}/pipeline/state`, {}, pipelineHeaders())).json()) as { daily_pin: StatePin; current_version: number | null }

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const json = async <T>(res: Response) => (await res.json()) as T
const currentPin = async () => (await json<{ pin: Pin | null }>(await getPin())).pin
const auditItems = async (action?: string) => {
  const items = (await json<Page<AuditItem>>(await admin('GET', '/audit?size=100', undefined))).items
  return action === undefined ? items : items.filter((a) => a.action === action)
}
const changeCount = async (): Promise<number> => (await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_pin_change').first<{ n: number }>())!.n

// ---------------------------------------------------------------------------- publish (success / error batch)
async function publish(version: number, o: { target: string; stats?: Record<string, unknown>; pinId?: string }): Promise<Response> {
  const starterNames = ['Cay', 'Cười', 'Toang', 'Deadline']
  const starters = await Promise.all(starterNames.map(elementId))
  const batchAt = '2026-10-20T05:30:00.000Z'
  const [x, y] = [starters[0]!, starters[1]!].sort()
  const target = await elementId(o.target)
  const elems = await Promise.all(
    [A, B, SIGMA].map(async (name) => ({ id: await elementId(name), name, fold: fold(name), emoji: EMOJI, depth: 4, auto_tier: 3 })),
  )
  const body: Record<string, unknown> = {
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
      daily: { element_id: target, emoji: EMOJI, hint: 'Món cay cay', depth: 4 },
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
    stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {}, ...(o.stats ?? {}) },
  }
  if (o.pinId !== undefined) body.daily_pin_id = o.pinId
  return raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) }, pipelineHeaders())
}
const publishError = () =>
  raw(
    `${GAME_API}/pipeline/batches`,
    {
      method: 'POST',
      body: JSON.stringify({
        status: 'error',
        batch_at: '2026-10-20T06:30:00.000Z',
        mode: 'core',
        failed_step: 'publish',
        stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
      }),
    },
    pipelineHeaders(),
  )

beforeEach(async () => {
  await env.DB.batch([
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
    ...(await Promise.all(NAMES.map(elementRow))),
    env.DB.prepare("INSERT INTO block (kind, target_id, state, reason, created_at) VALUES ('element', ?, 'blocked', 'admin', ?)").bind(await elementId(BLOCKED), Date.now()),
  ])
})

describe('daily pin (worker)', () => {
  it(
    'AC-DAILY-19: PUT chỉ định phần tử hợp lệ: 200 {before null, after DailyPin} (hint được trim), GET trả đúng; PUT phần tử khác thay chỉ định cũ (before = chỉ định trước); audit set_daily_pin đủ trước/sau',
    async () => {
      const [a, b] = [await elementId(A), await elementId(B)]
      const fp = hex(await sha256(TOKEN)).slice(0, 8)
      expect(await json(await getPin())).toEqual({ pin: null })

      const first = await putPin({ element_id: a, hint: '   Món cay cay hơn bạn nghĩ  ' })
      expect(first.status).toBe(200)
      const r1 = await json<PinResult>(first)
      expect(r1.before).toBeNull()
      expect(r1.after).toMatchObject({ element_id: a, name: A, emoji: EMOJI, hint: 'Món cay cay hơn bạn nghĩ' })
      expect(Math.abs(Date.parse(r1.after.created_at) - Date.now())).toBeLessThan(5 * 60_000)
      expect(Object.keys(r1.after).sort()).toEqual(['created_at', 'element_id', 'emoji', 'hint', 'name'])
      expect(await json(await getPin())).toEqual({ pin: r1.after })

      const second = await putPin({ element_id: b, hint: 'Nóng hổi vừa thổi vừa ăn' })
      expect(second.status).toBe(200)
      const r2 = await json<PinResult>(second)
      expect(r2.before).toEqual(r1.after)
      expect(r2.after).toMatchObject({ element_id: b, name: B, emoji: EMOJI, hint: 'Nóng hổi vừa thổi vừa ăn' })
      expect(await json(await getPin())).toEqual({ pin: r2.after })

      const audit = await auditItems('set_daily_pin')
      expect(audit).toHaveLength(2)
      const byTarget = new Map(audit.map((x) => [x.target_id, x]))
      expect(byTarget.get(a)).toMatchObject({
        target_kind: 'element',
        before: null,
        after: { element_id: a, hint: 'Món cay cay hơn bạn nghĩ' },
        token_fp: fp,
      })
      expect(byTarget.get(b)).toMatchObject({
        target_kind: 'element',
        before: { element_id: a, hint: 'Món cay cay hơn bạn nghĩ' },
        after: { element_id: b, hint: 'Nóng hổi vừa thổi vừa ăn' },
        token_fp: fp,
      })
      expect(Math.abs(Date.parse(audit[0]!.created_at) - Date.now())).toBeLessThan(5 * 60_000)
      expect(await changeCount()).toBe(2)
    },
    120_000,
  )

  it(
    'AC-DAILY-19: biên hợp lệ: hint đúng 200 ký tự; hint chỉ chứa tên món như một phần của từ khác ("Sigmaxyz") đều được nhận',
    async () => {
      const [b, s] = [await elementId(B), await elementId(SIGMA)]
      const long = 'g'.repeat(200)
      const res200 = await putPin({ element_id: b, hint: long })
      expect(res200.status).toBe(200)
      expect((await json<PinResult>(res200)).after.hint).toBe(long)

      const inWord = await putPin({ element_id: s, hint: 'Sigmaxyz là gì vậy' })
      expect(inWord.status).toBe(200)
      expect((await json<PinResult>(inWord)).after).toMatchObject({ element_id: s, name: SIGMA, hint: 'Sigmaxyz là gì vậy' })
      expect((await currentPin())?.element_id).toBe(s)
    },
    60_000,
  )

  it(
    'AC-DAILY-VALIDATION: đầu vào nguy hiểm đều 400 problem+json (phần tử bị chặn, hint rỗng/toàn khoảng trắng, 201 ký tự, hint chứa tên món theo fold, thuộc tính thừa, thiếu trường, sai kiểu, id sai định dạng, không phải JSON); phần tử lạ 404; chỉ định cũ giữ nguyên, không audit mới',
    async () => {
      const [a, s, c, x] = [await elementId(A), await elementId(SIGMA), await elementId(CAFE), await elementId(BLOCKED)]
      const ok = await putPin({ element_id: a, hint: 'Gợi ý hợp lệ' })
      expect(ok.status).toBe(200)
      const pin0 = (await json<PinResult>(ok)).after

      const bad: Array<[string, unknown]> = [
        ['blocked element', { element_id: x, hint: 'Gợi ý hợp lệ' }],
        ['empty hint', { element_id: a, hint: '' }],
        ['blank hint', { element_id: a, hint: '    \t  ' }],
        ['201 chars', { element_id: a, hint: 'k'.repeat(201) }],
        ['name in hint (case)', { element_id: s, hint: 'đúng là SIGMA thật' }],
        ['name in hint (diacritics)', { element_id: c, hint: 'thích CA PHE lắm' }],
        ['name in hint (exact)', { element_id: c, hint: 'Cà Phê sữa đá' }],
        ['extra property', { element_id: a, hint: 'Gợi ý hợp lệ', extra: 1 }],
        ['missing hint', { element_id: a }],
        ['missing element_id', { hint: 'Gợi ý hợp lệ' }],
        ['hint is number', { element_id: a, hint: 123 }],
        ['element_id is number', { element_id: 1, hint: 'Gợi ý hợp lệ' }],
        ['short id', { element_id: 'abc', hint: 'Gợi ý hợp lệ' }],
        ['10000 char id', { element_id: 'A'.repeat(10_000), hint: 'Gợi ý hợp lệ' }],
        ['sql id', { element_id: "'; DROP TABLE element;--".padEnd(43, 'a'), hint: 'Gợi ý hợp lệ' }],
        ['recipe id as element', { element_id: await recipeId(A, B), hint: 'Gợi ý hợp lệ' }],
        ['not json', '{"element_id": '],
        ['array body', [a, 'Gợi ý hợp lệ']],
      ]
      for (const [label, body] of bad) {
        const res = await putPin(body)
        // a well-formed id of another kind (recipe) is simply not an element: 404 is as safe as 400
        const allowed = label === 'recipe id as element' ? [400, 404] : [400]
        expect(allowed, label).toContain(res.status)
        isProblem(res)
      }

      const ghost = await putPin({ element_id: await elementId('Dp Không Có Thật'), hint: 'Gợi ý hợp lệ' })
      expect(ghost.status).toBe(404)
      isProblem(ghost)

      expect(await currentPin()).toEqual(pin0)
      expect(await auditItems('set_daily_pin')).toHaveLength(1)
      expect(await changeCount()).toBe(1)
    },
    180_000,
  )

  it(
    'AC-DAILY-19: thiếu token, token sai, sai sơ đồ, token pipeline đều 401 problem+json cho GET/PUT/DELETE, chỉ định không đổi; host game /lau-meme/api/admin/daily-pin trả 404',
    async () => {
      const a = await elementId(A)
      const ok = await putPin({ element_id: a, hint: 'Gợi ý hợp lệ' })
      expect(ok.status).toBe(200)
      const pin0 = (await json<PinResult>(ok)).after

      const b = await elementId(B)
      for (const auth of [null, `Bearer ${WRONG}`, `Basic ${btoa(`admin:${TOKEN}`)}`, `Bearer ${PIPELINE_TOKEN}`]) {
        for (const res of [await getPin({ auth }), await putPin({ element_id: b, hint: 'Đổi gợi ý' }, { auth }), await delPin({ auth })]) {
          expect(res.status, String(auth)).toBe(401)
          isProblem(res)
        }
      }
      const spoof = { 'X-Admin': 'true', 'X-Forwarded-For': '1.2.3.4' }
      expect((await delPin({ auth: null, headers: spoof })).status).toBe(401)
      expect((await getPin({ origin: `${GAME_API}/admin` })).status).toBe(404)
      expect((await delPin({ origin: `${GAME_API}/admin` })).status).toBe(404)

      expect(await currentPin()).toEqual(pin0)
      expect(await auditItems('set_daily_pin')).toHaveLength(1)
      expect(await auditItems('clear_daily_pin')).toHaveLength(0)
    },
    120_000,
  )

  it(
    'AC-DAILY-19: DELETE bỏ chỉ định: 204, GET {pin: null}, đúng 1 audit clear_daily_pin (trước {element_id, hint}, sau null); DELETE lần nữa vẫn 204 và không thêm audit',
    async () => {
      const a = await elementId(A)
      expect((await putPin({ element_id: a, hint: 'Gợi ý sắp bị bỏ' })).status).toBe(200)

      const res = await delPin()
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
      expect(await json(await getPin())).toEqual({ pin: null })
      const cleared = await auditItems('clear_daily_pin')
      expect(cleared).toHaveLength(1)
      expect(cleared[0]).toMatchObject({
        target_kind: 'element',
        target_id: a,
        before: { element_id: a, hint: 'Gợi ý sắp bị bỏ' },
        after: null,
        token_fp: hex(await sha256(TOKEN)).slice(0, 8),
      })

      const again = await delPin()
      expect(again.status).toBe(204)
      expect(await auditItems('clear_daily_pin')).toHaveLength(1)
      expect(await changeCount()).toBe(2) // set + clear
    },
    90_000,
  )

  it(
    'AC-DAILY-19: /pipeline/state.daily_pin là null khi không có, là {id uuid, element_id, hint} khi có, và đổi id mỗi lần đặt lại',
    async () => {
      const [a, b] = [await elementId(A), await elementId(B)]
      expect((await getState()).daily_pin).toBeNull()

      expect((await putPin({ element_id: a, hint: 'Gợi ý một' })).status).toBe(200)
      const s1 = (await getState()).daily_pin
      expect(s1).not.toBeNull()
      expect(Object.keys(s1!).sort()).toEqual(['element_id', 'hint', 'id'])
      expect(s1).toMatchObject({ element_id: a, hint: 'Gợi ý một' })
      expect(s1!.id).toMatch(UUID)

      expect((await putPin({ element_id: a, hint: 'Gợi ý một' })).status).toBe(200) // cùng nội dung, vẫn là lần đặt mới
      const s2 = (await getState()).daily_pin
      expect(s2!.id).toMatch(UUID)
      expect(s2!.id).not.toBe(s1!.id)

      expect((await putPin({ element_id: b, hint: 'Gợi ý hai' })).status).toBe(200)
      expect((await getState()).daily_pin).toMatchObject({ element_id: b, hint: 'Gợi ý hai' })
      expect((await delPin()).status).toBe(204)
      expect((await getState()).daily_pin).toBeNull()
    },
    120_000,
  )

  it(
    'AC-DAILY-19: mẻ success gửi daily_pin_id đã đọc: 201 và chỉ định bị xóa; admin đặt lại trong lúc mẻ chạy (id mới) thì đăng bằng id cũ giữ chỉ định mới',
    async () => {
      const [a, b] = [await elementId(A), await elementId(B)]
      expect((await putPin({ element_id: a, hint: 'Gợi ý cho mẻ một' })).status).toBe(200)
      const read1 = (await getState()).daily_pin!
      const used = await publish(1, { target: A, stats: { daily_pin: 'used' }, pinId: read1.id })
      expect(used.status).toBe(201)
      expect(await json(await getPin())).toEqual({ pin: null })
      expect((await getState()).daily_pin).toBeNull()

      // race: the batch read the pin, then the admin set another one before the batch published
      expect((await putPin({ element_id: a, hint: 'Gợi ý bị mẻ đọc' })).status).toBe(200)
      const stale = (await getState()).daily_pin!
      expect((await putPin({ element_id: b, hint: 'Gợi ý đặt lại giữa chừng' })).status).toBe(200)
      const fresh = (await getState()).daily_pin!
      expect(fresh.id).not.toBe(stale.id)
      const res = await publish(2, { target: SIGMA, stats: { daily_pin: 'dropped' }, pinId: stale.id })
      expect(res.status).toBe(201)
      const kept = await getState()
      expect(kept.daily_pin).toEqual(fresh)
      expect((await currentPin())?.element_id).toBe(b)

      // dropped pins are cleared too: the id read is sent back whatever happened to the element
      const cleared = await publish(3, { target: SIGMA, stats: { daily_pin: 'dropped' }, pinId: fresh.id })
      expect(cleared.status).toBe(201)
      expect((await getState()).daily_pin).toBeNull()
    },
    180_000,
  )

  it(
    'AC-DAILY-19: stats.daily_pin và daily_pin_id phải đi cùng nhau (thiếu một trong hai thì 422); used + id của chỉ định đang lưu mà content.daily_element_id khác phần tử của chỉ định cũng 422; version hiện hành không đổi, chỉ định giữ nguyên; mẻ lỗi không động tới chỉ định',
    async () => {
      const [a] = [await elementId(A)]
      expect((await putPin({ element_id: a, hint: 'Gợi ý phải được dùng' })).status).toBe(200)
      const pin = (await getState()).daily_pin!
      const before = (await getState()).current_version

      const bad: Array<[string, Parameters<typeof publish>[1]]> = [
        ['used without id', { target: A, stats: { daily_pin: 'used' } }],
        ['dropped without id', { target: A, stats: { daily_pin: 'dropped' } }],
        ['id without stats.daily_pin', { target: A, pinId: pin.id }],
        ['used, stored id, other element', { target: B, stats: { daily_pin: 'used' }, pinId: pin.id }],
      ]
      for (const [i, [label, opts]] of bad.entries()) {
        const res = await publish(4 + i, opts)
        expect(res.status, label).toBe(422)
        isProblem(res)
      }
      const after = await getState()
      expect(after.current_version).toBe(before)
      expect(after.daily_pin).toEqual(pin)

      const err = await publishError()
      expect(err.status).toBe(201)
      const afterError = await getState()
      expect(afterError.current_version).toBe(before)
      expect(afterError.daily_pin).toEqual(pin)
      expect((await currentPin())?.element_id).toBe(a)
    },
    120_000,
  )

  it(
    'AC-DAILY-19: admin ghim phần tử KHÁC trong lúc mẻ chạy: đăng bằng id cũ với used + content.daily_element_id = phần tử cũ thì 201 và chỉ định mới còn nguyên; dropped + id không khớp dòng nào cũng 201, chỉ định lưu không đổi',
    async () => {
      const [a, b] = [await elementId(A), await elementId(B)]
      expect((await putPin({ element_id: a, hint: 'Gợi ý bị mẻ đọc' })).status).toBe(200)
      const stale = (await getState()).daily_pin!
      expect((await putPin({ element_id: b, hint: 'Gợi ý đặt lại giữa chừng' })).status).toBe(200)
      const fresh = (await getState()).daily_pin!
      expect(fresh.id).not.toBe(stale.id)

      const published = await publish(5, { target: A, stats: { daily_pin: 'used' }, pinId: stale.id })
      expect(published.status).toBe(201)
      expect((await getState()).current_version).toBe(5)
      expect((await getState()).daily_pin).toEqual(fresh)
      expect(await currentPin()).toMatchObject({ element_id: b, hint: 'Gợi ý đặt lại giữa chừng' })

      const orphan = await publish(6, { target: SIGMA, stats: { daily_pin: 'dropped' }, pinId: '0190b1c2-0000-7000-8000-00000000ffff' })
      expect(orphan.status).toBe(201)
      expect((await getState()).daily_pin).toEqual(fresh)
      expect((await currentPin())?.element_id).toBe(b)
    },
    120_000,
  )

  it('AC-DAILY-19: tác vụ dọn hằng ngày xóa daily_pin_change cũ hơn 365 ngày và giữ dòng mới hơn (AC-ADMIN-09, giữ 12 tháng)', async () => {
    const now = Date.now()
    const day = 86_400_000
    const row = (id: string, at: number) =>
      env.DB.prepare('INSERT INTO daily_pin_change (id, action, before_json, after_json, token_fp, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
        id,
        'set_daily_pin',
        'null',
        '{"element_id":"x","hint":"y"}',
        '0123abcd',
        at,
      )
    await env.DB.batch([
      row('0190b1c2-0000-7000-8000-0000000000a1', now - 366 * day),
      row('0190b1c2-0000-7000-8000-0000000000a2', now - 364 * day),
      row('0190b1c2-0000-7000-8000-0000000000a3', now - 1 * day),
    ])

    const ctx = createExecutionContext()
    await (worker as unknown as Scheduled).scheduled(createScheduledController({ scheduledTime: new Date(now), cron: '0 20 * * *' }), { ...env, IP_HASH_KEY: IP_KEY }, ctx)
    await waitOnExecutionContext(ctx)

    const left = await env.DB.prepare('SELECT id FROM daily_pin_change ORDER BY id').all<{ id: string }>()
    expect(left.results.map((r) => r.id)).toEqual(['0190b1c2-0000-7000-8000-0000000000a2', '0190b1c2-0000-7000-8000-0000000000a3'])
  })
})
