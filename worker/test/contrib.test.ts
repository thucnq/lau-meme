// Acceptance tests cho docs/acceptance/contrib.md, phần worker: AC-CONTRIB-01..08, 09 (phía Worker), 10, 11, 12,
// cộng AC-CONTRIB-TENANT và AC-CONTRIB-VALIDATION.
// Black-box: chỉ dùng hợp đồng HTTP (docs/api/openapi.yaml), ADR 0013, ADR 0002 và schema D1 (migrations 0003-0008).
//
// Phủ gì:
//   AC-CONTRIB-01  POST /contributions: 201 {id, status pending, ...}, chỉ tên bắt buộc, cặp lưu không thứ tự, người gửi + thời điểm,
//                  chưa duyệt thì không lộ ra graph / pipeline state / người chơi khác
//   AC-CONTRIB-02  đầu vào sai -> 400 problem+json nêu trường sai, không tạo đề xuất (kèm biên hợp lệ 40 / 200 / 500)
//   AC-CONTRIB-03  409: cặp đã có công thức, tên trùng theo fold ("stonks!!"), gửi lặp (kể cả 2 request song song); B vẫn gửi được
//   AC-CONTRIB-04  422 "Nội dung không phù hợp" (từ cấm, bí danh), không nêu từ nào, không tạo đề xuất, không gọi mạng ngoài
//   AC-CONTRIB-05  401 chưa đăng nhập, 403 chưa đồng ý, 429 + Retry-After tới 00:00 GMT+7 ở đề xuất thứ 6, 429 theo IP băm 10/phút
//   AC-CONTRIB-06  GET /me/contributions (mới nhất trước, phân trang, bản admin đã sửa), GET /contributions/{id} (404 cho của người khác)
//   AC-CONTRIB-07  GET/PATCH /admin/contributions: phân trang, lọc, oldest first, không lộ mã tài khoản, audit edit_contribution
//   AC-CONTRIB-08  approve / reject: element_id, tier, tự từ chối đề xuất cùng cặp, 409 duyệt lại, audit, /pipeline/state.contributions
//                  chỉ có trường game, graph đang phục vụ không đổi, cha bị ẩn thì đề xuất vẫn ở state
//   AC-CONTRIB-09  (Worker) emoji đã sửa / null đi qua /pipeline/state.contributions; gợi ý ảnh của admin, không có link ảnh
//   AC-CONTRIB-10  GET /creators/{version}: bản chụp nickname lúc đăng mẻ, null khi không có nickname, không có phần tử lõi
//   AC-CONTRIB-11  GET /contributors/leaderboard: thứ tự, hòa, top 20, me, không lộ id
//   AC-CONTRIB-12  GET /me có account.contributions; DELETE /me xóa đề xuất chờ duyệt, bỏ gắn đề xuất đã duyệt, creators -> null,
//                  rời bảng xếp hạng ngay
//   AC-CONTRIB-TENANT, AC-CONTRIB-VALIDATION
//
// Giả định cần người xem lại (xem báo cáo): "nêu trường sai" = chữ tên trường (name, description, emoji, image_url) nằm trong
// problem JSON; Retry-After tính từ đồng hồ của Worker; đề xuất bị từ chối/đã duyệt cũng tính vào hạn 5/ngày.
//
// Hiệu năng: D1 trong Miniflare ~66 ms/truy vấn, nên mỗi test gieo dữ liệu bằng MỘT env.DB.batch (tài khoản và phiên gieo thẳng
// vào D1, không đi qua Google). Hạn mức tần suất tính theo đồng hồ, nên `tick()` đẩy giờ giả lên 61 giây giữa các request.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['contrib', 'admin', 'token', 'ok'].join('-')
const WRONG = ['contrib', 'admin', 'token', 'no'].join('-')
const PIPELINE_TOKEN = ['contrib', 'pipeline', 'token'].join('-')
const IP_KEY = ['contrib', 'ip', 'hash', 'key'].join('-')
const HASH_KEY = ['contrib', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_API = 'https://dinoduct.fun/lau-meme/api'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const T0 = Date.parse('2026-10-20T10:00:05.000Z') // 17:00:05 GMT+7, 5 s vào một phút
const ANON = 'Thực khách ẩn danh'
const NOT_OK = 'Nội dung không phù hợp'
const COOKIE = 'laumeme_sid'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Row = Record<string, unknown>
type Problem = { type: string; title: string; status: number; detail?: string }
type Page<T> = { page: number; size: number; total: number; items: T[] }
type StarterRef = { id: string; name: string; emoji: string }
type Contribution = {
  id: string
  a: StarterRef
  b: StarterRef
  name: string
  emoji: string | null
  description: string | null
  image_url: string | null
  status: 'pending' | 'approved' | 'rejected'
  reject_reason: string | null
  created_at: string
}
type AdminContribution = Omit<Contribution, 'created_at'> & {
  image_hint: string | null
  tier: number
  element_id: string | null
  nickname: string
  created_at: string
  decided_at: string | null
}
type AuditItem = { action: string; target_kind: string; target_id: string; before: unknown; after: unknown; reason: string | null; token_fp: string; created_at: string }
type StateContribution = { element_id: string; name: string; emoji: string | null; a: string; b: string; image_hint: string; approved_at: string }
type Board = { rows: Array<{ rank: number; nickname: string; approved: number }>; me: { rank: number; nickname: string; approved: number } | null }

const CONTRIB_KEYS = ['a', 'b', 'created_at', 'description', 'emoji', 'id', 'image_url', 'name', 'reject_reason', 'status']
const ADMIN_KEYS = [
  'a', 'b', 'created_at', 'decided_at', 'description', 'element_id', 'emoji', 'id', 'image_hint', 'image_url', 'name', 'nickname',
  'reject_reason', 'status', 'tier',
]
const STATE_KEYS = ['a', 'approved_at', 'b', 'element_id', 'emoji', 'image_hint', 'name']

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
const fakeId = async (label: string) => b64u(await sha256(`contrib-test|${label}`))
const iso = (ms: number) => new Date(ms).toISOString()

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
const ELEMENT_NAMES = [...STARTERS.map((s) => s.name), ...DEFS.map((d) => d.result)]
// Cặp chưa có công thức: (Deadline, Cà Phê), (Cay, Cà Phê), (Toang, Cà Phê), (Cười, Cà Phê), (Hết Cứu, Toang).
const HINT = 'một ly cà phê đen đang chạy deadline'

async function batchBody(version: number, extra: Def[] = []) {
  const starterIds = await Promise.all(STARTERS.map((s) => elementId(s.name)))
  const defs = [...DEFS, ...extra]
  const recipes = await Promise.all(
    defs.map(async (d) => {
      const [x, y] = [await elementId(d.a), await elementId(d.b)].sort()
      return { id: await recipeId(d.a, d.b), a: x!, b: y!, result: await elementId(d.result) }
    }),
  )
  const target = await elementId('Stonks')
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
          defs.map(async (d) => ({ id: await elementId(d.result), name: d.result, fold: fold(d.result), emoji: d.emoji, depth: d.depth, origin: 'vn' })),
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
    { ...env, ADMIN_TOKEN: TOKEN, PIPELINE_TOKEN, IP_HASH_KEY: IP_KEY, ACCOUNT_HASH_KEY: HASH_KEY },
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
async function expectProblem(res: Response, status: number): Promise<Problem> {
  expect(res.status).toBe(status)
  isProblem(res)
  const body = await json<Problem>(res)
  expect(body.status).toBe(status)
  return body
}
const str = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body))

/** Đẩy đồng hồ giả lên 61 s: sang một phút hạn mức mới, vẫn trong cùng ngày GMT+7. */
const tick = () => vi.setSystemTime(Date.now() + 61_000)

// ---------------------------------------------------------------------------- accounts (seeded straight into D1)
type Acct = { id: string; player: string; cookie: string; nickname: string | null; stmts: D1PreparedStatement[] }
async function acct(nickname: string | null = null, o: { consent?: boolean; light?: boolean } = {}): Promise<Acct> {
  const id = crypto.randomUUID()
  const player = crypto.randomUUID()
  const cookie = b64u(crypto.getRandomValues(new Uint8Array(32)))
  const now = Date.now()
  const stmts = [
    env.DB.prepare('INSERT INTO account (id, sub_hash, nickname, nickname_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id,
      crypto.getRandomValues(new Uint8Array(32)),
      nickname,
      nickname ? fold(nickname) : null,
      now - 86_400_000,
      now - 86_400_000,
    ),
  ]
  if (!o.light) {
    stmts.push(
      env.DB.prepare('INSERT INTO account_player (player_id, account_id, linked_at) VALUES (?, ?, ?)').bind(player, id, now - 86_000_000),
      env.DB.prepare('INSERT INTO session (token_hash, account_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(
        await sha256(cookie),
        id,
        now - 80_000_000,
        now - 1000,
        now + 90 * 86_400_000,
      ),
    )
    if (o.consent !== false) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
        ).bind(crypto.randomUUID(), player, POLICY_VERSION, now - 80_000_000),
      )
    }
  }
  return { id, player, cookie, nickname, stmts }
}

function ipFor(player: string): string {
  const h = player.replaceAll('-', '')
  return `10.${parseInt(h.slice(0, 2), 16)}.${parseInt(h.slice(2, 4), 16)}.${parseInt(h.slice(4, 6), 16)}`
}
type HdrOpts = { ip?: string; player?: string; cookie?: string | null }
function hdr(a: Acct | null, o: HdrOpts = {}): Record<string, string> {
  const player = o.player ?? a?.player ?? crypto.randomUUID()
  const h: Record<string, string> = { 'CF-Connecting-IP': o.ip ?? (a ? ipFor(a.player) : nextIp()), 'X-Player-Id': player }
  const cookie = o.cookie === undefined ? a?.cookie : o.cookie
  if (cookie) h.Cookie = `${COOKIE}=${cookie}`
  return h
}
const G = (path: string, init: RequestInit, a: Acct | null, o: HdrOpts = {}) => raw(`${GAME_API}${path}`, init, hdr(a, o))
const postC = (a: Acct | null, body: unknown, o: HdrOpts = {}) => G('/contributions', { method: 'POST', body: str(body) }, a, o)
const getMine = (a: Acct | null, qs = '') => G(`/me/contributions${qs}`, {}, a)
const getOne = (a: Acct | null, id: string) => G(`/contributions/${id}`, {}, a)
const getBoard = (a: Acct | null) => G('/contributors/leaderboard', {}, a)
const getCreators = (version: number | string) => raw(`${GAME_API}/creators/${version}`, {}, { 'CF-Connecting-IP': nextIp() })
const getState = () => raw(`${GAME_API}/pipeline/state`, {}, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
const stateContributions = async () => (await json<{ contributions: StateContribution[] }>(await getState())).contributions

type AOpts = { method?: string; body?: unknown; auth?: string | null; ip?: string; headers?: Record<string, string> }
function AD(path: string, o: AOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': o.ip ?? nextIp(), ...(o.headers ?? {}) }
  const auth = o.auth === undefined ? `Bearer ${TOKEN}` : o.auth
  if (auth !== null) headers.Authorization = auth
  const hasBody = o.body !== undefined
  const init: RequestInit = { method: o.method ?? (hasBody ? 'POST' : 'GET') }
  if (hasBody) init.body = str(o.body)
  return raw(`${ADMIN_ORIGIN}/api/admin${path}`, init, headers)
}
const adminList = (qs: string, o: AOpts = {}) => AD(`/contributions${qs}`, o)
const adminEdit = (id: string, body: unknown, o: AOpts = {}) => AD(`/contributions/${id}`, { method: 'PATCH', body, ...o })
const adminApprove = (id: string, body: unknown, o: AOpts = {}) => AD(`/contributions/${id}/approve`, { body, ...o })
const adminReject = (id: string, body: unknown, o: AOpts = {}) => AD(`/contributions/${id}/reject`, { body, ...o })

// ---------------------------------------------------------------------------- D1 seeding and probes
type CRow = {
  id?: string
  account: string | null
  a: string
  b: string
  raw?: boolean // a, b đã là ElementId
  name: string
  emoji?: string | null
  description?: string | null
  image_url?: string | null
  status?: 'pending' | 'approved' | 'rejected'
  reason?: string
  hint?: string
  at?: number
  decided?: number
}
async function crow(r: CRow): Promise<{ id: string; stmt: D1PreparedStatement }> {
  const id = r.id ?? crypto.randomUUID()
  const ids = r.raw ? [r.a, r.b] : await Promise.all([elementId(r.a), elementId(r.b)])
  ids.sort()
  const status = r.status ?? 'pending'
  const at = r.at ?? Date.now()
  const stmt = env.DB.prepare(
    'INSERT INTO contribution (id, account_id, a_id, b_id, name, name_fold, emoji, description, image_url, status, reject_reason, image_hint, element_id, created_at, updated_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id,
    r.account,
    ids[0],
    ids[1],
    r.name,
    fold(r.name),
    r.emoji ?? null,
    r.description ?? null,
    r.image_url ?? null,
    status,
    status === 'rejected' ? (r.reason ?? 'Không phù hợp') : null,
    status === 'approved' ? (r.hint ?? HINT) : null,
    status === 'approved' ? await elementId(r.name) : null,
    at,
    at,
    status === 'pending' ? null : (r.decided ?? at + 1000),
  )
  return { id, stmt }
}
const stmtsOf = async (rows: CRow[]) => (await Promise.all(rows.map(crow))).map((x) => x.stmt)
const blockStmt = (kind: 'element', target: string, state: 'hidden' | 'blocked') =>
  env.DB.prepare("INSERT INTO block (kind, target_id, state, reason, created_at) VALUES (?, ?, ?, 'admin', ?)").bind(kind, target, state, Date.now())
const termStmt = (term: string, source: 'wordlist' | 'mod' | 'admin') =>
  env.DB.prepare('INSERT INTO banned_term (term_fold, source, created_at) VALUES (?, ?, ?)').bind(term, source, Date.now())

async function q<T = Row>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results
}
async function n(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0
}
const countC = (accountId: string) => n('SELECT COUNT(*) AS n FROM contribution WHERE account_id = ?', accountId)
const countAllC = () => n('SELECT COUNT(*) AS n FROM contribution')
const changeRows = () => q('SELECT * FROM admin_change ORDER BY created_at, id')
const idsOfPair = async (a: string, b: string) => (await Promise.all([elementId(a), elementId(b)])).sort() as [string, string]

// ---------------------------------------------------------------------------- content lifecycle
let contentDirty = true
async function publish(version: number, extra: Def[] = []): Promise<void> {
  contentDirty = true
  const res = await raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(await batchBody(version, extra)) }, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
  expect(res.status).toBe(201)
}
async function ensureContent(): Promise<void> {
  const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'current_version'").first<{ value: string }>()
  if (!contentDirty && row?.value === '1') return
  await env.DB.batch([
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
  await publish(1)
  contentDirty = false
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(T0))
  await env.DB.batch([
    env.DB.prepare('DELETE FROM contribution'),
    env.DB.prepare('DELETE FROM admin_change'),
    env.DB.prepare('DELETE FROM element_tier'),
    env.DB.prepare('DELETE FROM banned_term'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM rate_counter'),
    env.DB.prepare('DELETE FROM consent'),
    env.DB.prepare('DELETE FROM session'),
    env.DB.prepare('DELETE FROM account_player'),
    env.DB.prepare('DELETE FROM account'),
  ])
  await ensureContent()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function secondsToNextMidnightGmt7(nowMs: number): number {
  const day = Math.floor((nowMs + 7 * 3_600_000) / 86_400_000)
  return Math.ceil(((day + 1) * 86_400_000 - 7 * 3_600_000 - nowMs) / 1000)
}
const startOfTodayGmt7 = (nowMs: number) => Math.floor((nowMs + 7 * 3_600_000) / 86_400_000) * 86_400_000 - 7 * 3_600_000

describe('contrib (worker)', () => {
  // ========================================================================== AC-CONTRIB-01
  it('AC-CONTRIB-01: gửi (Deadline, Cà Phê) chỉ với tên -> 201 {id, status pending}, lưu kèm tài khoản người gửi và thời điểm, cặp không thứ tự; chưa duyệt thì người khác, graph và pipeline state không thấy', async () => {
    const A = await acct('Bún Chả')
    const B = await acct()
    await env.DB.batch([...A.stmts, ...B.stmts])
    const [dl, cp] = await Promise.all([elementId('Deadline'), elementId('Cà Phê')])

    const res = await postC(A, { a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Chạy Deadline' })
    expect(res.status).toBe(201)
    const body = await json<Contribution>(res)
    expect(Object.keys(body).sort()).toEqual(CONTRIB_KEYS)
    expect(body.id).toMatch(UUID_RE)
    expect(body).toMatchObject({ name: 'Cà Phê Chạy Deadline', emoji: null, description: null, image_url: null, status: 'pending', reject_reason: null })
    expect(Math.abs(Date.parse(body.created_at) - Date.now())).toBeLessThan(60_000)
    expect([body.a.id, body.b.id].sort()).toEqual([dl, cp].sort())
    expect([body.a.name, body.b.name].sort()).toEqual(['Cà Phê', 'Deadline'])

    const rows = await q<{ account_id: string; a_id: string; b_id: string; status: string; created_at: number }>(
      'SELECT account_id, a_id, b_id, status, created_at FROM contribution WHERE id = ?',
      body.id,
    )
    expect(rows).toHaveLength(1)
    const [lo, hi] = [dl, cp].sort()
    expect(rows[0]).toMatchObject({ account_id: A.id, a_id: lo, b_id: hi, status: 'pending' })
    expect(Math.abs(rows[0]!.created_at - Date.now())).toBeLessThan(60_000)

    // chưa duyệt: B không thấy, pipeline state không có, kho nội dung không đổi
    expect((await json<Page<Contribution>>(await getMine(B))).items).toEqual([])
    expect((await getOne(B, body.id)).status).toBe(404)
    expect(await stateContributions()).toEqual([])
    expect(await n('SELECT COUNT(*) AS n FROM recipe')).toBe(DEFS.length)
  })

  it('AC-CONTRIB-01: gửi thêm biểu tượng "☕", mô tả, link ảnh với cặp đảo thứ tự (Cà Phê, Deadline) -> 201 lưu đủ trường; cùng cặp không thứ tự với đề xuất của người khác', async () => {
    const A = await acct('Bún Chả')
    const B = await acct()
    await env.DB.batch([...A.stmts, ...B.stmts])
    const first = await postC(A, { a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Chạy Deadline' })
    expect(first.status).toBe(201)
    tick()
    const full = { a: 'Cà Phê', b: 'Deadline', name: 'Cà Phê Thức Đêm', emoji: '☕', description: 'Uống để thức tới sáng', image_url: 'https://example.com/a.png' }
    const res = await postC(B, full)
    expect(res.status).toBe(201)
    const body = await json<Contribution>(res)
    expect(body).toMatchObject({ name: 'Cà Phê Thức Đêm', emoji: '☕', description: 'Uống để thức tới sáng', image_url: 'https://example.com/a.png', status: 'pending' })
    const rows = await q<{ a_id: string; b_id: string; account_id: string }>('SELECT a_id, b_id, account_id FROM contribution ORDER BY created_at')
    expect(rows).toHaveLength(2)
    expect([rows[0]!.a_id, rows[0]!.b_id]).toEqual([rows[1]!.a_id, rows[1]!.b_id]) // (Deadline, Cà Phê) và (Cà Phê, Deadline) là cùng cặp
    expect(rows[0]!.a_id <= rows[0]!.b_id).toBe(true)
    expect(rows.map((r) => r.account_id)).toEqual([A.id, B.id])
  })

  it('AC-CONTRIB-01: tên được cắt khoảng trắng hai đầu', async () => {
    const A = await acct()
    await env.DB.batch(A.stmts)
    const res = await postC(A, { a: 'Deadline', b: 'Cà Phê', name: '   Cà Phê Chạy Deadline  ' })
    expect(res.status).toBe(201)
    expect((await json<Contribution>(res)).name).toBe('Cà Phê Chạy Deadline')
    expect((await q<{ name: string }>('SELECT name FROM contribution WHERE account_id = ?', A.id))[0]!.name).toBe('Cà Phê Chạy Deadline')
  })

  // ========================================================================== AC-CONTRIB-02
  it(
    'AC-CONTRIB-02: thiếu tên, tên trống, tên 41 ký tự, mô tả 201 ký tự, biểu tượng sai, link không https hoặc quá 500, phần tử không có/ẩn/bị chặn, trường thừa, thân không phải JSON -> 400 problem+json, không tạo đề xuất',
    async () => {
      const A = await acct()
      await env.DB.batch([
        ...A.stmts,
        blockStmt('element', await elementId('Khét Lẹt'), 'hidden'),
        blockStmt('element', await elementId('Hết Cứu'), 'blocked'),
      ])
      const ok = { a: 'Deadline', b: 'Cà Phê' }
      const cases: Array<[string, unknown, string | null]> = [
        ['thiếu tên', { ...ok }, 'name'],
        ['tên null', { ...ok, name: null }, 'name'],
        ['tên chỉ khoảng trắng', { ...ok, name: '    ' }, 'name'],
        ['tên rỗng', { ...ok, name: '' }, 'name'],
        ['tên 41 ký tự', { ...ok, name: 'x'.repeat(41) }, 'name'],
        ['mô tả 201 ký tự', { ...ok, name: 'Tên Tốt', description: 'm'.repeat(201) }, 'description'],
        ['biểu tượng là chữ', { ...ok, name: 'Tên Tốt', emoji: 'ab' }, 'emoji'],
        ['biểu tượng hai emoji', { ...ok, name: 'Tên Tốt', emoji: '🔥🔥' }, 'emoji'],
        ['biểu tượng là thẻ script', { ...ok, name: 'Tên Tốt', emoji: '<script>' }, 'emoji'],
        ['biểu tượng emoji kèm chữ', { ...ok, name: 'Tên Tốt', emoji: '☕x' }, 'emoji'],
        ['link http', { ...ok, name: 'Tên Tốt', image_url: 'http://example.com/a.png' }, 'image_url'],
        ['link javascript:', { ...ok, name: 'Tên Tốt', image_url: 'javascript:alert(1)' }, 'image_url'],
        ['link 501 ký tự', { ...ok, name: 'Tên Tốt', image_url: `https://example.com/${'a'.repeat(481)}` }, 'image_url'],
        ['phần tử a không tồn tại', { a: 'Món Không Có', b: 'Cà Phê', name: 'Tên Tốt' }, null],
        ['phần tử b không tồn tại', { a: 'Deadline', b: 'Món Không Có', name: 'Tên Tốt' }, null],
        ['phần tử b đang ẩn', { a: 'Cay', b: 'Khét Lẹt', name: 'Tên Tốt' }, null],
        ['phần tử a bị chặn', { a: 'Hết Cứu', b: 'Cay', name: 'Tên Tốt' }, null],
        ['thiếu b', { a: 'Deadline', name: 'Tên Tốt' }, null],
        ['a không phải chuỗi', { a: 5, b: 'Cà Phê', name: 'Tên Tốt' }, null],
        ['trường lạ', { ...ok, name: 'Tên Tốt', account_id: 'x' }, null],
        ['thân không phải JSON', 'đây không phải JSON {', null],
        ['thân JSON cụt', '{"a": "Deadline", ', null],
        ['thân là mảng', [], null],
      ]
      expect(new Set(cases.map((c) => c[0])).size).toBe(cases.length)
      for (const [label, body, field] of cases) {
        tick()
        const res = await postC(A, body)
        expect(res.status, label).toBe(400)
        isProblem(res)
        const text = JSON.stringify(await res.json())
        if (field !== null) expect(text, `${label}: phải nêu trường ${field}`).toContain(field)
      }
      expect(await countAllC()).toBe(0)

      // biên hợp lệ: tên 40, mô tả 200, link đúng 500 ký tự, emoji có VS16
      tick()
      const edge = await postC(A, {
        a: 'Cười',
        b: 'Cà Phê',
        name: 'T'.repeat(40),
        description: 'm'.repeat(200),
        emoji: '🌶️',
        image_url: `https://example.com/${'a'.repeat(480)}`,
      })
      expect(edge.status, await edge.clone().text()).toBe(201)
      expect(await countAllC()).toBe(1)
    },
    120_000,
  )

  // ========================================================================== AC-CONTRIB-03
  it(
    'AC-CONTRIB-03: cặp đã có công thức, tên trùng theo fold ("stonks!!", "STONKS", "ca phe", đề xuất đã duyệt), gửi lại cặp đang chờ (cả đảo thứ tự) -> 409 problem+json, không tạo thêm; B vẫn gửi được; bấm 2 lần liên tiếp chỉ tạo 1',
    async () => {
      const A = await acct()
      const B = await acct()
      const C = await acct()
      const seeded = await stmtsOf([
        { account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Chờ Duyệt' },
        { account: C.id, a: 'Hết Cứu', b: 'Toang', name: 'Meme Đã Duyệt', status: 'approved' },
      ])
      await env.DB.batch([...A.stmts, ...B.stmts, ...C.stmts, ...seeded])
      const before = await countAllC()

      const conflicts: Array<[string, unknown]> = [
        ['cặp đã có công thức', { a: 'Cười', b: 'Toang', name: 'Cười Mới Toanh' }],
        ['cặp đã có công thức, đảo thứ tự', { a: 'Toang', b: 'Cười', name: 'Cười Mới Toanh' }],
        ['tên trùng "stonks!!"', { a: 'Cay', b: 'Cà Phê', name: 'stonks!!' }],
        ['tên trùng "STONKS"', { a: 'Cay', b: 'Cà Phê', name: 'STONKS' }],
        ['tên trùng bỏ dấu "ca phe"', { a: 'Cay', b: 'Cà Phê', name: 'ca phe' }],
        ['tên trùng đề xuất đã duyệt', { a: 'Cay', b: 'Cà Phê', name: 'meme da duyet' }],
        ['cặp đã có đề xuất được duyệt', { a: 'Hết Cứu', b: 'Toang', name: 'Tên Khác Hẳn' }],
        ['gửi lại cặp đang chờ', { a: 'Deadline', b: 'Cà Phê', name: 'Gửi Lại Lần Hai' }],
        ['gửi lại cặp đang chờ, đảo thứ tự', { a: 'Cà Phê', b: 'Deadline', name: 'Gửi Lại Lần Ba' }],
      ]
      for (const [label, body] of conflicts) {
        tick()
        const res = await postC(A, body)
        expect(res.status, label).toBe(409)
        isProblem(res)
      }
      expect(await countAllC()).toBe(before)

      // bấm 2 lần liên tiếp: một 201 và một 409, đúng 1 dòng
      tick()
      const [r1, r2] = await Promise.all([
        postC(A, { a: 'Toang', b: 'Cà Phê', name: 'Bấm Hai Lần' }),
        postC(A, { a: 'Toang', b: 'Cà Phê', name: 'Bấm Hai Lần' }),
      ])
      expect([r1.status, r2.status].sort()).toEqual([201, 409])
      const [x, y] = await idsOfPair('Toang', 'Cà Phê')
      expect(await n('SELECT COUNT(*) AS n FROM contribution WHERE account_id = ? AND a_id = ? AND b_id = ?', A.id, x, y)).toBe(1)

      // thực khách B vẫn gửi được cùng cặp (Deadline, Cà Phê)
      tick()
      const other = await postC(B, { a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Của B' })
      expect(other.status).toBe(201)
      const [p, r] = await idsOfPair('Deadline', 'Cà Phê')
      expect(await n("SELECT COUNT(*) AS n FROM contribution WHERE a_id = ? AND b_id = ? AND status = 'pending'", p, r)).toBe(2)
    },
    120_000,
  )

  // ========================================================================== AC-CONTRIB-04
  it(
    'AC-CONTRIB-04: tên hoặc mô tả chứa từ cấm / bí danh (so theo fold) -> 422 problem+json "Nội dung không phù hợp", không nêu từ nào, không tạo đề xuất, không gọi mạng ngoài',
    async () => {
      const A = await acct()
      await env.DB.batch([...A.stmts, termStmt('tu cam', 'wordlist'), termStmt('abc xyz', 'mod'), termStmt('badword', 'admin')])
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const pair = { a: 'Deadline', b: 'Cà Phê' }
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['từ cấm trong tên', { name: 'Món Tư Cầm 1' }, 'cam'],
        ['từ cấm hoa thường trong tên', { name: 'TU CAM Đặc Biệt' }, 'cam'],
        ['bí danh sát nhau trong tên', { name: 'Món ABCxyz Lạ' }, 'xyz'],
        ['từ cấm do admin trong mô tả', { name: 'Tên Sạch', description: 'xin chào BadWord ơi' }, 'badword'],
        ['từ cấm wordlist trong mô tả', { name: 'Tên Sạch', description: 'nói Tư  Cầm đi' }, 'cam'],
      ]
      for (const [label, extra, leaked] of cases) {
        tick()
        const res = await postC(A, { ...pair, ...extra })
        expect(res.status, label).toBe(422)
        isProblem(res)
        const text = await res.text()
        expect((JSON.parse(text) as Problem).title, label).toBe(NOT_OK)
        expect(text.toLowerCase(), label).not.toContain(leaked)
      }
      expect(await countAllC()).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()

      tick() // đối chứng: nội dung sạch vẫn gửi được
      expect((await postC(A, { ...pair, name: 'Tư Vấn Cà Phê', description: 'ly cà phê buổi sáng' })).status).toBe(201)
    },
    120_000,
  )

  // ========================================================================== AC-CONTRIB-05
  it('AC-CONTRIB-05: chưa đăng nhập (không cookie, cookie lạ) -> 401; đã đăng nhập nhưng chưa đồng ý chính sách -> 403; cả hai problem+json và không tạo đề xuất', async () => {
    const A = await acct()
    const NoConsent = await acct(null, { consent: false })
    await env.DB.batch([...A.stmts, ...NoConsent.stmts])
    const body = { a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Chạy Deadline' }

    // UUID có đồng ý nhưng không có phiên
    await expectProblem(await postC(A, body, { cookie: null }), 401)
    tick()
    await expectProblem(await postC(A, body, { cookie: b64u(crypto.getRandomValues(new Uint8Array(32))) }), 401)
    tick()
    await expectProblem(await postC(null, body), 401)
    tick()
    await expectProblem(await postC(NoConsent, body), 403)
    expect(await countAllC()).toBe(0)
  })

  it('AC-CONTRIB-05: tài khoản đã gửi 5 đề xuất trong ngày GMT+7 (đủ trạng thái) -> đề xuất thứ 6 là 429 problem+json có Retry-After tới 00:00 GMT+7 hôm sau; tài khoản khác không bị ảnh hưởng', async () => {
    const A = await acct()
    const B = await acct()
    const now = Date.now()
    const used = await stmtsOf([
      { account: A.id, a: 'Cay', b: 'Cười', name: 'Một', at: now - 5000 },
      { account: A.id, a: 'Cay', b: 'Toang', name: 'Hai', at: now - 4000 },
      { account: A.id, a: 'Cười', b: 'Deadline', name: 'Ba', at: now - 3000, status: 'rejected' },
      { account: A.id, a: 'Toang', b: 'Stonks', name: 'Bốn', at: now - 2000, status: 'rejected' },
      { account: A.id, a: 'Hết Cứu', b: 'Khét Lẹt', name: 'Năm', at: now - 1000, status: 'approved' },
    ])
    await env.DB.batch([...A.stmts, ...B.stmts, ...used])

    const res = await postC(A, { a: 'Deadline', b: 'Cà Phê', name: 'Đề Xuất Thứ Sáu' })
    await expectProblem(res, 429)
    const retry = Number(res.headers.get('Retry-After'))
    expect(Number.isInteger(retry)).toBe(true)
    expect(Math.abs(retry - secondsToNextMidnightGmt7(Date.now()))).toBeLessThanOrEqual(2)
    expect(await countC(A.id)).toBe(5)

    expect((await postC(B, { a: 'Deadline', b: 'Cà Phê', name: 'Đề Xuất Của B' })).status).toBe(201)
  })

  it('AC-CONTRIB-05: hạn 5 đề xuất tính theo ngày GMT+7: 5 đề xuất lúc 23:59 hôm qua không tính, 5 đề xuất đúng 00:00 hôm nay thì tính', async () => {
    const A = await acct()
    const B = await acct()
    const midnight = startOfTodayGmt7(Date.now())
    const mk = async (acc: Acct, at: number, tag: string) =>
      stmtsOf(
        (
          [
            ['Cay', 'Cười'],
            ['Cay', 'Toang'],
            ['Cười', 'Deadline'],
            ['Toang', 'Stonks'],
            ['Hết Cứu', 'Khét Lẹt'],
          ] as const
        ).map(([a, b], i) => ({ account: acc.id, a, b, name: `${tag} ${i}`, at: at + i })),
      )
    await env.DB.batch([...A.stmts, ...B.stmts, ...(await mk(A, midnight - 60_000, 'Hôm Qua')), ...(await mk(B, midnight, 'Hôm Nay'))])

    const yesterday = await postC(A, { a: 'Deadline', b: 'Cà Phê', name: 'Hôm Nay Của A' })
    expect(yesterday.status).toBe(201)
    const today = await postC(B, { a: 'Deadline', b: 'Cà Phê', name: 'Hôm Nay Của B' })
    await expectProblem(today, 429)
    expect(today.headers.get('Retry-After')).not.toBeNull()
  })

  it(
    'AC-CONTRIB-05: cùng IP băm gửi quá 10 yêu cầu/phút -> 429 problem+json có Retry-After; sang phút sau lại gửi được',
    async () => {
      const accounts = await Promise.all(Array.from({ length: 12 }, () => acct()))
      await env.DB.batch(accounts.flatMap((a) => a.stmts))
      const ip = '198.51.100.9'
      for (let i = 0; i < 10; i++) {
        const res = await postC(accounts[i]!, { a: 'Deadline', b: 'Cà Phê', name: `Meme Cùng IP ${i}` }, { ip })
        expect(res.status, `yêu cầu ${i + 1}`).toBe(201)
      }
      const eleventh = await postC(accounts[10]!, { a: 'Deadline', b: 'Cà Phê', name: 'Meme Cùng IP 10' }, { ip })
      await expectProblem(eleventh, 429)
      expect(Number(eleventh.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
      expect(await countC(accounts[10]!.id)).toBe(0)

      tick()
      expect((await postC(accounts[11]!, { a: 'Deadline', b: 'Cà Phê', name: 'Meme Cùng IP 11' }, { ip })).status).toBe(201)
    },
    120_000,
  )

  // ========================================================================== AC-CONTRIB-06
  it(
    'AC-CONTRIB-06: A xem đúng 3 đề xuất của mình, mới nhất trước, đủ trường (cặp, tên, biểu tượng, mô tả, trạng thái, lý do từ chối, thời điểm), phân trang; bản admin đã sửa hiện bản đã sửa; xem theo mã của B trả 404',
    async () => {
      const A = await acct('Bún Chả')
      const B = await acct()
      const C = await acct()
      const t = Date.now()
      const rows: CRow[] = [
        { account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Cũ Nhất Đã Duyệt', emoji: '☕', description: 'Uống để thức tới sáng', image_url: 'https://example.com/a.png', status: 'approved', at: t - 3 * 3_600_000 },
        { account: A.id, a: 'Cay', b: 'Cà Phê', name: 'Ở Giữa Chờ Duyệt', at: t - 2 * 3_600_000 },
        { account: A.id, a: 'Toang', b: 'Cà Phê', name: 'Mới Nhất Bị Loại', status: 'rejected', reason: 'Trùng ý với Stonks', at: t - 3_600_000 },
        { account: B.id, a: 'Cười', b: 'Cà Phê', name: 'Của Người Khác', at: t - 1000 },
      ]
      const made = await Promise.all(rows.map(crow))
      const [approvedId, pendingId, rejectedId, otherId] = made.map((m) => m.id) as [string, string, string, string]
      await env.DB.batch([...A.stmts, ...B.stmts, ...C.stmts, ...made.map((m) => m.stmt)])

      // admin sửa đề xuất đang chờ của A: A thấy bản đã sửa
      const edit = await adminEdit(pendingId, { name: 'Tên Đã Được Sửa', emoji: '🫖' })
      expect(edit.status).toBe(200)

      const res = await getMine(A)
      expect(res.status).toBe(200)
      const page = await json<Page<Contribution>>(res)
      expect(page.total).toBe(3)
      expect(page.items.map((i) => i.id)).toEqual([rejectedId, pendingId, approvedId]) // mới nhất trước
      const by = new Map(page.items.map((i) => [i.id, i]))
      for (const item of page.items) expect(Object.keys(item).sort()).toEqual(CONTRIB_KEYS)
      expect(by.get(rejectedId)).toMatchObject({ name: 'Mới Nhất Bị Loại', status: 'rejected', reject_reason: 'Trùng ý với Stonks', created_at: iso(t - 3_600_000) })
      expect(by.get(pendingId)).toMatchObject({ name: 'Tên Đã Được Sửa', emoji: '🫖', status: 'pending', reject_reason: null })
      expect(by.get(approvedId)).toMatchObject({
        name: 'Cũ Nhất Đã Duyệt',
        emoji: '☕',
        description: 'Uống để thức tới sáng',
        image_url: 'https://example.com/a.png',
        status: 'approved',
        reject_reason: null,
      })
      expect([by.get(approvedId)!.a.name, by.get(approvedId)!.b.name].sort()).toEqual(['Cà Phê', 'Deadline'])
      expect(JSON.stringify(page)).not.toContain('Của Người Khác')

      // phân trang
      const p1 = await json<Page<Contribution>>(await getMine(A, '?page=1&size=2'))
      const p2 = await json<Page<Contribution>>(await getMine(A, '?page=2&size=2'))
      expect(p1.items.map((i) => i.id)).toEqual([rejectedId, pendingId])
      expect(p2.items.map((i) => i.id)).toEqual([approvedId])

      // xem một đề xuất theo mã
      const mine = await getOne(A, approvedId)
      expect(mine.status).toBe(200)
      expect(await json<Contribution>(mine)).toEqual(by.get(approvedId))
      const theirs = await getOne(A, otherId)
      const missing = await getOne(A, crypto.randomUUID())
      const theirsBody = await expectProblem(theirs, 404)
      const missingBody = await expectProblem(missing, 404)
      expect(theirsBody.title).toBe(missingBody.title) // không lộ khác biệt giữa "của người khác" và "không tồn tại"

      // danh sách rỗng, và không có phiên thì 401
      expect(await json<Page<Contribution>>(await getMine(C))).toMatchObject({ total: 0, items: [] })
      await expectProblem(await getMine(null), 401)
      await expectProblem(await getOne(null, approvedId), 401)
    },
    120_000,
  )

  // ========================================================================== AC-CONTRIB-07
  it(
    'AC-CONTRIB-07: 25 đề xuất chờ duyệt: danh sách phân trang cũ nhất trước (size tối đa 100), lọc theo trạng thái, mỗi dòng cặp/tên/biểu tượng/mô tả/link dạng chữ/nickname/thời điểm, không có mã tài khoản hay UUID',
    async () => {
      const A = await acct('Bún Chả')
      const B = await acct()
      const pairs: Array<[string, string]> = []
      for (let i = 0; i < ELEMENT_NAMES.length; i++) for (let j = i + 1; j < ELEMENT_NAMES.length; j++) pairs.push([ELEMENT_NAMES[i]!, ELEMENT_NAMES[j]!])
      const t = Date.now()
      const rows: CRow[] = Array.from({ length: 25 }, (_, i) => ({
        account: i % 2 === 0 ? A.id : B.id,
        a: pairs[Math.floor(i / 2)]![0],
        b: pairs[Math.floor(i / 2)]![1],
        name: `Đề xuất ${String(i).padStart(2, '0')}`,
        emoji: i === 0 ? '☕' : null,
        description: i === 0 ? 'Uống để thức tới sáng' : null,
        image_url: i === 0 ? 'https://example.com/a.png' : null,
        at: t - (25 - i) * 60_000,
      }))
      rows.push({ account: A.id, a: 'Hết Cứu', b: 'Khét Lẹt', name: 'Đã Được Duyệt', status: 'approved', at: t - 3_600_000 })
      await env.DB.batch([...A.stmts, ...B.stmts, ...(await stmtsOf(rows))])

      const all = await json<Page<AdminContribution>>(await adminList('?status=pending'))
      expect(all).toMatchObject({ page: 1, size: 50, total: 25 })
      expect(all.items.map((i) => i.name)).toEqual(Array.from({ length: 25 }, (_, i) => `Đề xuất ${String(i).padStart(2, '0')}`))
      const first = all.items[0]!
      expect(Object.keys(first).sort()).toEqual(ADMIN_KEYS)
      expect(first).toMatchObject({
        emoji: '☕',
        description: 'Uống để thức tới sáng',
        image_url: 'https://example.com/a.png',
        status: 'pending',
        nickname: 'Bún Chả',
        element_id: null,
        decided_at: null,
        created_at: iso(t - 25 * 60_000),
      })
      expect(all.items[1]!.nickname).toBe(ANON)
      expect([first.a.name, first.b.name]).toEqual(expect.arrayContaining([pairs[0]![0]]))
      const text = JSON.stringify(all)
      for (const secret of [A.id, B.id, A.player, B.player, A.cookie, B.cookie]) expect(text).not.toContain(secret)

      const p1 = await json<Page<AdminContribution>>(await adminList('?status=pending&page=1&size=10'))
      const p3 = await json<Page<AdminContribution>>(await adminList('?status=pending&page=3&size=10'))
      expect(p1).toMatchObject({ page: 1, size: 10, total: 25 })
      expect(p1.items.map((i) => i.name)).toEqual(all.items.slice(0, 10).map((i) => i.name))
      expect(p3.items.map((i) => i.name)).toEqual(all.items.slice(20).map((i) => i.name))
      expect((await json<Page<AdminContribution>>(await adminList('?status=pending&size=100'))).items).toHaveLength(25)

      const approved = await json<Page<AdminContribution>>(await adminList('?status=approved'))
      expect(approved.total).toBe(1)
      expect(approved.items[0]).toMatchObject({ name: 'Đã Được Duyệt', status: 'approved', element_id: await elementId('Đã Được Duyệt'), image_hint: HINT })
      expect(approved.items[0]!.decided_at).not.toBeNull()
      expect(await json<Page<AdminContribution>>(await adminList('?status=rejected'))).toMatchObject({ total: 0, items: [] })

      for (const bad of ['?status=pending&size=101', '?status=pending&page=0', '?status=pending&size=0', '?status=lạ', '?status=pending&page=abc']) {
        const res = await adminList(bad)
        expect(res.status, bad).toBe(400)
        isProblem(res)
      }
    },
    120_000,
  )

  it(
    'AC-CONTRIB-07: sửa tên, biểu tượng, mô tả, link ảnh -> 200 và ghi 1 dòng audit edit_contribution (trước/sau, dấu vân token); null xóa trường tùy chọn; sửa không lọc từ cấm',
    async () => {
      const A = await acct('Bún Chả')
      const [row] = await Promise.all([
        crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Tên Cũ', emoji: '🔥', description: 'mô tả cũ', image_url: 'https://example.com/old.png' }),
      ])
      await env.DB.batch([...A.stmts, row.stmt, termStmt('badword', 'admin')])
      const fp = hex(await sha256(TOKEN)).slice(0, 8)

      const res = await adminEdit(row.id, { name: 'Tên Mới Sửa', emoji: '☕', description: 'mô tả mới', image_url: 'https://example.com/new.png' })
      expect(res.status).toBe(200)
      const body = await json<AdminContribution>(res)
      expect(body).toMatchObject({ id: row.id, name: 'Tên Mới Sửa', emoji: '☕', description: 'mô tả mới', image_url: 'https://example.com/new.png', status: 'pending', nickname: 'Bún Chả' })
      expect(Object.keys(body).sort()).toEqual(ADMIN_KEYS)

      let changes = await changeRows()
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ action: 'edit_contribution', target_kind: 'contribution', target_id: row.id, token_fp: fp })
      expect(JSON.parse(changes[0]!.before_json as string)).toMatchObject({ name: 'Tên Cũ', emoji: '🔥', description: 'mô tả cũ', image_url: 'https://example.com/old.png' })
      expect(JSON.parse(changes[0]!.after_json as string)).toMatchObject({ name: 'Tên Mới Sửa', emoji: '☕', description: 'mô tả mới', image_url: 'https://example.com/new.png' })
      const audit = await json<Page<AuditItem>>(await AD('/audit'))
      expect(audit.items[0]).toMatchObject({ action: 'edit_contribution', target_kind: 'contribution', target_id: row.id, token_fp: fp })
      expect(audit.items[0]!.after).toMatchObject({ name: 'Tên Mới Sửa' })

      // null xóa trường tùy chọn; từ cấm không bị lọc ở phía admin
      const cleared = await adminEdit(row.id, { description: null, image_url: null, name: 'Có badword vẫn được' })
      expect(cleared.status).toBe(200)
      expect(await json<AdminContribution>(cleared)).toMatchObject({ description: null, image_url: null, name: 'Có badword vẫn được' })
      changes = await changeRows()
      expect(changes).toHaveLength(2)
      expect(JSON.parse(changes[1]!.after_json as string)).toMatchObject({ description: null, image_url: null })
    },
    120_000,
  )

  it(
    'AC-CONTRIB-07: sửa thành tên rỗng / quá dài / biểu tượng sai / link sai / thân rỗng / trường lạ -> 400; tên trùng phần tử đã có hoặc đề xuất đã duyệt -> 409; đề xuất đã duyệt -> 409; mã lạ -> 404; không ghi audit',
    async () => {
      const A = await acct()
      const pending = await crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Đang Chờ' })
      const approved = await crow({ account: A.id, a: 'Hết Cứu', b: 'Toang', name: 'Meme Đã Duyệt', status: 'approved' })
      await env.DB.batch([...A.stmts, pending.stmt, approved.stmt])

      const bad: Array<[string, unknown]> = [
        ['tên rỗng', { name: '' }],
        ['tên khoảng trắng', { name: '   ' }],
        ['tên 41 ký tự', { name: 'x'.repeat(41) }],
        ['mô tả 201 ký tự', { description: 'm'.repeat(201) }],
        ['biểu tượng sai', { emoji: 'abc' }],
        ['link http', { image_url: 'http://example.com/a.png' }],
        ['thân rỗng', {}],
        ['trường lạ', { name: 'Tên Ổn', status: 'approved' }],
        ['tên không phải chuỗi', { name: 5 }],
      ]
      for (const [label, body] of bad) {
        const res = await adminEdit(pending.id, body)
        expect(res.status, label).toBe(400)
        isProblem(res)
      }
      expect((await adminEdit(pending.id, '{"name": ')).status).toBe(400)
      for (const [label, name] of [['trùng phần tử', 'stonks'], ['trùng phần tử có dấu', 'Cà  Phê'], ['trùng đề xuất đã duyệt', 'MEME ĐÃ DUYỆT']] as const) {
        const res = await adminEdit(pending.id, { name })
        expect(res.status, label).toBe(409)
        isProblem(res)
      }
      const notPending = await adminEdit(approved.id, { name: 'Sửa Sau Khi Duyệt' })
      expect(notPending.status).toBe(409)
      isProblem(notPending)
      expect((await adminEdit(crypto.randomUUID(), { name: 'Không Có' })).status).toBe(404)
      expect((await adminEdit('khong-phai-uuid', { name: 'Không Có' })).status).toBe(400)

      expect(await changeRows()).toEqual([])
      expect((await q<{ name: string }>('SELECT name FROM contribution WHERE id = ?', pending.id))[0]!.name).toBe('Đang Chờ')
    },
    120_000,
  )

  it('AC-CONTRIB-07: thiếu token, token sai -> 401; trên host game /lau-meme/api/admin/... -> 404; không ghi audit', async () => {
    const A = await acct()
    const row = await crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Đang Chờ' })
    await env.DB.batch([...A.stmts, row.stmt])
    for (const auth of [null, `Bearer ${WRONG}`, `Basic ${btoa(`admin:${TOKEN}`)}`]) {
      expect((await adminList('?status=pending', { auth })).status, String(auth)).toBe(401)
      expect((await adminEdit(row.id, { name: 'Bị Sửa' }, { auth })).status).toBe(401)
      expect((await adminApprove(row.id, { image_hint: 'x' }, { auth })).status).toBe(401)
      expect((await adminReject(row.id, { reason: 'x' }, { auth })).status).toBe(401)
    }
    const onGame = await raw(`${GAME_API}/admin/contributions?status=pending`, {}, { Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': nextIp() })
    expect(onGame.status).toBe(404)
    expect(await changeRows()).toEqual([])
    expect((await q<{ status: string }>('SELECT status FROM contribution WHERE id = ?', row.id))[0]!.status).toBe('pending')
  })

  // ========================================================================== AC-CONTRIB-08
  it(
    'AC-CONTRIB-08: duyệt X (kèm gợi ý ảnh, tier 3) -> 200, trạng thái approved, element_id = ElementId(fold tên), tier lưu cho admin; Y cùng cặp tự bị từ chối "Cặp đã có công thức"; audit approve + reject; duyệt lại X và duyệt Y -> 409',
    async () => {
      const A = await acct('Bún Chả')
      const B = await acct()
      const t = Date.now()
      const x = await crow({
        account: A.id,
        a: 'Deadline',
        b: 'Cà Phê',
        name: 'Cà Phê Chạy Deadline',
        emoji: '☕',
        description: 'Uống để thức tới sáng',
        image_url: 'https://example.com/a.png',
        at: t - 5000,
      })
      const y = await crow({ account: B.id, a: 'Cà Phê', b: 'Deadline', name: 'Cà Phê Thức Đêm', at: t - 4000 })
      const z = await crow({ account: B.id, a: 'Cay', b: 'Cà Phê', name: 'Meme Khác Cặp', at: t - 3000 })
      await env.DB.batch([...A.stmts, ...B.stmts, x.stmt, y.stmt, z.stmt])
      const manifestBefore = await (await raw(`${GAME_API}/manifest`, {}, { 'CF-Connecting-IP': nextIp() })).text()
      const graphBefore = await (await raw(`${GAME_API}/graph/1`, {}, { 'CF-Connecting-IP': nextIp() })).text()
      const fp = hex(await sha256(TOKEN)).slice(0, 8)

      const res = await adminApprove(x.id, { image_hint: HINT, tier: 3 })
      expect(res.status).toBe(200)
      const body = await json<AdminContribution>(res)
      expect(Object.keys(body).sort()).toEqual(ADMIN_KEYS)
      const elementX = await elementId('Cà Phê Chạy Deadline')
      expect(body).toMatchObject({ id: x.id, status: 'approved', element_id: elementX, image_hint: HINT, tier: 3, nickname: 'Bún Chả', reject_reason: null })
      expect(Math.abs(Date.parse(body.decided_at!) - Date.now())).toBeLessThan(60_000)

      const rows = await q<{ id: string; status: string; reject_reason: string | null; element_id: string | null; image_hint: string | null }>(
        'SELECT id, status, reject_reason, element_id, image_hint FROM contribution WHERE id IN (?, ?, ?)',
        x.id,
        y.id,
        z.id,
      )
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.get(x.id)).toMatchObject({ status: 'approved', element_id: elementX, image_hint: HINT })
      expect(byId.get(y.id)).toMatchObject({ status: 'rejected', reject_reason: 'Cặp đã có công thức', element_id: null })
      expect(byId.get(z.id)).toMatchObject({ status: 'pending' })
      expect(await q('SELECT element_id, tier FROM element_tier')).toEqual([{ element_id: elementX, tier: 3 }])

      const changes = await changeRows()
      expect(changes.map((c) => `${c.action}:${c.target_id}`).sort()).toEqual([`approve_contribution:${x.id}`, `reject_contribution:${y.id}`].sort())
      expect(changes.every((c) => c.target_kind === 'contribution' && c.token_fp === fp)).toBe(true)
      const audit = await json<Page<AuditItem>>(await AD('/audit'))
      expect(audit.items.map((i) => `${i.action}:${i.target_id}`).sort()).toEqual([`approve_contribution:${x.id}`, `reject_contribution:${y.id}`].sort())

      // người gửi thấy ngay
      expect((await json<Page<Contribution>>(await getMine(A))).items[0]).toMatchObject({ id: x.id, status: 'approved' })
      expect((await json<Page<Contribution>>(await getMine(B))).items.find((i) => i.id === y.id)).toMatchObject({ status: 'rejected', reject_reason: 'Cặp đã có công thức' })

      // duyệt lại X, duyệt Y đã bị từ chối -> 409, không ghi thêm
      for (const id of [x.id, y.id]) {
        const again = await adminApprove(id, { image_hint: HINT })
        expect(again.status, id).toBe(409)
        isProblem(again)
      }
      expect(await changeRows()).toHaveLength(2)

      // không sửa graph đang phục vụ
      expect(await (await raw(`${GAME_API}/manifest`, {}, { 'CF-Connecting-IP': nextIp() })).text()).toBe(manifestBefore)
      expect(await (await raw(`${GAME_API}/graph/1`, {}, { 'CF-Connecting-IP': nextIp() })).text()).toBe(graphBefore)
    },
    180_000,
  )

  it('AC-CONTRIB-08: duyệt không kèm tier -> tier 1 và không ghi dòng tier; từ chối kèm lý do -> 200, rejected, audit reject_contribution; từ chối lần hai hoặc từ chối đề xuất đã duyệt -> 409', async () => {
    const A = await acct()
    const p = await crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Sẽ Được Duyệt' })
    const r = await crow({ account: A.id, a: 'Cay', b: 'Cà Phê', name: 'Sẽ Bị Loại' })
    await env.DB.batch([...A.stmts, p.stmt, r.stmt])

    const approved = await adminApprove(p.id, { image_hint: HINT })
    expect(approved.status).toBe(200)
    expect(await json<AdminContribution>(approved)).toMatchObject({ status: 'approved', tier: 1 })
    expect(await q('SELECT * FROM element_tier')).toEqual([])

    const rejected = await adminReject(r.id, { reason: 'Trùng ý với Stonks' })
    expect(rejected.status).toBe(200)
    expect(await json<AdminContribution>(rejected)).toMatchObject({ id: r.id, status: 'rejected', reject_reason: 'Trùng ý với Stonks', element_id: null })
    const changes = await changeRows()
    expect(changes.map((c) => c.action).sort()).toEqual(['approve_contribution', 'reject_contribution'])
    expect(JSON.stringify(changes.find((c) => c.action === 'reject_contribution'))).toContain('Trùng ý với Stonks')

    for (const [label, res] of [
      ['từ chối lần hai', await adminReject(r.id, { reason: 'Lại nữa' })],
      ['từ chối đề xuất đã duyệt', await adminReject(p.id, { reason: 'Muộn rồi' })],
    ] as const) {
      expect(res.status, label).toBe(409)
      isProblem(res)
    }
    expect(await changeRows()).toHaveLength(2)
    // đề xuất bị từ chối rồi thì cặp được gửi lại
  }, 120_000)

  it(
    'AC-CONTRIB-08: từ chối thiếu / rỗng / quá 200 ký tự lý do, duyệt thiếu gợi ý ảnh / tier ngoài 1-5 / trường lạ -> 400; mã lạ -> 404; không ghi audit, đề xuất vẫn chờ duyệt',
    async () => {
      const A = await acct()
      const p = await crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Vẫn Đang Chờ' })
      await env.DB.batch([...A.stmts, p.stmt])
      const badReject: unknown[] = [{}, { reason: '' }, { reason: '   ' }, { reason: 'l'.repeat(201) }, { reason: 5 }, { reason: 'ok', extra: 1 }, '{"reason":']
      for (const b of badReject) {
        const res = await adminReject(p.id, b)
        expect(res.status, str(b).slice(0, 40)).toBe(400)
        isProblem(res)
      }
      const badApprove: unknown[] = [
        {},
        { image_hint: '' },
        { image_hint: 'h'.repeat(301) },
        { image_hint: HINT, tier: 0 },
        { image_hint: HINT, tier: 6 },
        { image_hint: HINT, tier: '3' },
        { image_hint: HINT, tier: 2.5 },
        { image_hint: HINT, extra: true },
        { tier: 3 },
      ]
      for (const b of badApprove) {
        const res = await adminApprove(p.id, b)
        expect(res.status, str(b).slice(0, 40)).toBe(400)
        isProblem(res)
      }
      expect((await adminApprove(crypto.randomUUID(), { image_hint: HINT })).status).toBe(404)
      expect((await adminReject(crypto.randomUUID(), { reason: 'Không có' })).status).toBe(404)
      expect((await adminApprove('khong-phai-uuid', { image_hint: HINT })).status).toBe(400)
      expect(await changeRows()).toEqual([])
      expect(await q('SELECT * FROM element_tier')).toEqual([])
      expect((await q<{ status: string }>('SELECT status FROM contribution WHERE id = ?', p.id))[0]!.status).toBe('pending')

      // lý do dài đúng 200 ký tự được nhận
      expect((await adminReject(p.id, { reason: 'l'.repeat(200) })).status).toBe(200)
    },
    180_000,
  )

  it(
    'AC-CONTRIB-08: /pipeline/state.contributions chỉ có element_id, name, emoji, a, b, image_hint, approved_at của đề xuất đã duyệt (cũ nhất trước), không có mô tả, link ảnh, tài khoản, nickname; chờ duyệt không có; cha bị ẩn thì đề xuất vẫn ở kho',
    async () => {
      const A = await acct('Bún Chả')
      const t = Date.now()
      const rows: CRow[] = [
        { account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Chạy Deadline', emoji: '☕', description: 'Uống để thức tới sáng', image_url: 'https://example.com/a.png', status: 'approved', at: t - 20_000, decided: t - 10_000 },
        { account: A.id, a: 'Cay', b: 'Cà Phê', name: 'Meme Hai', status: 'approved', at: t - 19_000, decided: t - 9000, hint: 'một cái nồi sôi' },
        { account: A.id, a: 'Toang', b: 'Cà Phê', name: 'Vẫn Đang Chờ', description: 'bí mật chờ duyệt', at: t - 8000 },
      ]
      await env.DB.batch([...A.stmts, ...(await stmtsOf(rows)), blockStmt('element', await elementId('Deadline'), 'hidden')])

      const items = await stateContributions()
      expect(items.map((i) => i.name)).toEqual(['Cà Phê Chạy Deadline', 'Meme Hai'])
      for (const item of items) expect(Object.keys(item).sort()).toEqual(STATE_KEYS)
      const [dl, cp] = await idsOfPair('Deadline', 'Cà Phê')
      expect(items[0]).toMatchObject({ element_id: await elementId('Cà Phê Chạy Deadline'), emoji: '☕', image_hint: HINT, approved_at: iso(t - 10_000) })
      expect([items[0]!.a, items[0]!.b].sort()).toEqual([dl, cp])
      expect(items[1]).toMatchObject({ emoji: null, image_hint: 'một cái nồi sôi' })

      const text = JSON.stringify(await json(await getState()))
      for (const secret of ['Uống để thức tới sáng', 'example.com/a.png', 'bí mật chờ duyệt', 'Bún Chả', A.id, A.player]) expect(text).not.toContain(secret)
      expect(text).not.toMatch(/nickname|account|description|image_url/)
    },
    120_000,
  )

  // ========================================================================== AC-CONTRIB-09 (phía Worker)
  it('AC-CONTRIB-09: emoji người gửi hoặc admin đã sửa đi vào state; không có emoji thì null (pipeline dùng "🍲"); gợi ý ảnh do admin viết, không có link ảnh của người gửi', async () => {
    const A = await acct()
    const withEmoji = await crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Có Biểu Tượng', emoji: '☕', image_url: 'https://example.com/a.png' })
    const noEmoji = await crow({ account: A.id, a: 'Cay', b: 'Cà Phê', name: 'Không Biểu Tượng', image_url: 'https://example.com/b.png' })
    const edited = await crow({ account: A.id, a: 'Toang', b: 'Cà Phê', name: 'Admin Sửa Biểu Tượng', emoji: '🔥' })
    await env.DB.batch([...A.stmts, withEmoji.stmt, noEmoji.stmt, edited.stmt])

    expect((await adminEdit(edited.id, { emoji: '🫖' })).status).toBe(200)
    expect((await adminApprove(withEmoji.id, { image_hint: 'gợi ý một' })).status).toBe(200)
    expect((await adminApprove(noEmoji.id, { image_hint: 'gợi ý hai' })).status).toBe(200)
    expect((await adminApprove(edited.id, { image_hint: 'gợi ý ba' })).status).toBe(200)

    const items = await stateContributions()
    const by = new Map(items.map((i) => [i.name, i]))
    expect(by.get('Có Biểu Tượng')).toMatchObject({ emoji: '☕', image_hint: 'gợi ý một' })
    expect(by.get('Không Biểu Tượng')).toMatchObject({ emoji: null, image_hint: 'gợi ý hai' })
    expect(by.get('Admin Sửa Biểu Tượng')).toMatchObject({ emoji: '🫖', image_hint: 'gợi ý ba' })
    expect(JSON.stringify(items)).not.toContain('example.com')
  }, 120_000)

  // ========================================================================== AC-CONTRIB-10
  it(
    'AC-CONTRIB-10: đăng mẻ có phần tử đóng góp -> GET /creators/{version} = {element_id: nickname | null} chỉ cho phần tử đóng góp có trong mẻ, là bản chụp (đổi nickname thì hiện từ mẻ kế tiếp), không có mã tài khoản, Cache-Control max-age=300',
    async () => {
      const A = await acct('Bún Chả')
      const C = await acct() // không đặt nickname
      const rows: CRow[] = [
        { account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Chạy Deadline', status: 'approved' },
        { account: C.id, a: 'Cay', b: 'Cà Phê', name: 'Meme Ẩn Danh', status: 'approved' },
        { account: A.id, a: 'Toang', b: 'Cà Phê', name: 'Meme Chưa Vào Mẻ', status: 'approved' },
      ]
      await env.DB.batch([...A.stmts, ...C.stmts, ...(await stmtsOf(rows))])
      const extra: Def[] = [
        { a: 'Deadline', b: 'Cà Phê', result: 'Cà Phê Chạy Deadline', emoji: '☕', depth: 2 },
        { a: 'Cay', b: 'Cà Phê', result: 'Meme Ẩn Danh', emoji: '🍲', depth: 2 },
      ]
      await publish(2, extra)
      const [e1, e2, e3] = await Promise.all(['Cà Phê Chạy Deadline', 'Meme Ẩn Danh', 'Meme Chưa Vào Mẻ'].map(elementId))

      const res = await getCreators(2)
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
      expect(await json(res)).toEqual({ [e1!]: 'Bún Chả', [e2!]: null })
      const text = JSON.stringify(await json(await getCreators(2)))
      expect(text).not.toContain(A.id)
      expect(text).not.toContain(e3!)
      expect(text).not.toContain(await elementId('Stonks')) // phần tử lõi không có mục

      // đổi nickname: mẻ cũ giữ bản chụp, mẻ kế tiếp hiện tên mới
      await env.DB.prepare('UPDATE account SET nickname = ?, nickname_fold = ? WHERE id = ?').bind('Bún Riêu', 'bun rieu', A.id).run()
      expect(await json(await getCreators(2))).toEqual({ [e1!]: 'Bún Chả', [e2!]: null })
      await publish(3, extra)
      expect(await json(await getCreators(3))).toEqual({ [e1!]: 'Bún Riêu', [e2!]: null })

      // mẻ đăng trước khi có đề xuất: {}; version không có hoặc sai kiểu
      expect(await json(await getCreators(1))).toEqual({})
      await expectProblem(await getCreators(999), 404)
      await expectProblem(await getCreators('abc'), 400)
      await expectProblem(await getCreators(0), 400)
    },
    180_000,
  )

  // ========================================================================== AC-CONTRIB-11
  it(
    'AC-CONTRIB-11: A và B 5 meme (A đạt trước), C 2 meme + 4 bị từ chối, D chỉ chờ duyệt -> rows [A, B, C], D không có; có phiên thì me; không có id tài khoản',
    async () => {
      const A = await acct('Bếp A')
      const B = await acct() // không nickname
      const Cc = await acct('Bếp C')
      const D = await acct('Bếp D')
      const day = (d: number) => Date.UTC(2026, 9, d, 3, 0, 0)
      const rows: CRow[] = []
      const approved = async (acc: Acct, tag: string, decided: number[]) => {
        for (let i = 0; i < decided.length; i++) {
          rows.push({
            account: acc.id,
            a: await fakeId(`${tag}-${i}-a`),
            b: await fakeId(`${tag}-${i}-b`),
            raw: true,
            name: `Meme ${tag} ${i}`,
            status: 'approved',
            at: decided[i]! - 1000,
            decided: decided[i]!,
          })
        }
      }
      // B có các cái đầu sớm hơn A, nhưng cái thứ 5 của A (20/10) đến trước cái thứ 5 của B (21/10)
      await approved(A, 'A', [day(10), day(11), day(12), day(13), day(20)])
      await approved(B, 'B', [day(1), day(2), day(3), day(4), day(21)])
      await approved(Cc, 'C', [day(5), day(6)])
      for (let i = 0; i < 4; i++) {
        rows.push({ account: Cc.id, a: await fakeId(`C-rej-${i}-a`), b: await fakeId(`C-rej-${i}-b`), raw: true, name: `C bị loại ${i}`, status: 'rejected', at: day(7) + i })
      }
      for (let i = 0; i < 2; i++) {
        rows.push({ account: D.id, a: await fakeId(`D-${i}-a`), b: await fakeId(`D-${i}-b`), raw: true, name: `D chờ ${i}`, at: day(8) + i })
      }
      await env.DB.batch([...A.stmts, ...B.stmts, ...Cc.stmts, ...D.stmts, ...(await stmtsOf(rows))])

      const anon = await getBoard(null)
      expect(anon.status).toBe(200)
      const board = await json<Board>(anon)
      expect(board).toEqual({
        rows: [
          { rank: 1, nickname: 'Bếp A', approved: 5 },
          { rank: 2, nickname: ANON, approved: 5 },
          { rank: 3, nickname: 'Bếp C', approved: 2 },
        ],
        me: null,
      })
      const text = JSON.stringify(board)
      for (const secret of [A.id, B.id, Cc.id, D.id, A.player, 'Bếp D']) expect(text).not.toContain(secret)

      expect((await json<Board>(await getBoard(B))).me).toEqual({ rank: 2, nickname: ANON, approved: 5 })
      expect((await json<Board>(await getBoard(Cc))).me).toEqual({ rank: 3, nickname: 'Bếp C', approved: 2 })
      expect((await json<Board>(await getBoard(D))).me).toBeNull() // 0 đề xuất duyệt
    },
    120_000,
  )

  it('AC-CONTRIB-11: bảng rỗng khi chưa ai có đề xuất đã duyệt: rows [] và me null', async () => {
    const D = await acct('Bếp D')
    await env.DB.batch([...D.stmts, ...(await stmtsOf([{ account: D.id, a: 'Deadline', b: 'Cà Phê', name: 'Chỉ Chờ Duyệt' }]))])
    expect(await json<Board>(await getBoard(D))).toEqual({ rows: [], me: null })
    expect(await json<Board>(await getBoard(null))).toEqual({ rows: [], me: null })
  })

  it(
    'AC-CONTRIB-11: tối đa 20 dòng; tài khoản hạng 22 có phiên vẫn thấy hạng của mình trong me',
    async () => {
      const accounts = await Promise.all(Array.from({ length: 22 }, (_, i) => acct(`Thợ ${String(i + 1).padStart(2, '0')}`, i === 21 ? {} : { light: true })))
      const base = Date.UTC(2026, 9, 1, 3, 0, 0)
      const rows: CRow[] = []
      for (let i = 0; i < 22; i++) {
        rows.push({
          account: accounts[i]!.id,
          a: await fakeId(`T-${i}-a`),
          b: await fakeId(`T-${i}-b`),
          raw: true,
          name: `Meme Thợ ${i}`,
          status: 'approved',
          at: base + i * 1000,
          decided: base + i * 1000 + 500,
        })
      }
      await env.DB.batch([...accounts.flatMap((a) => a.stmts), ...(await stmtsOf(rows))])
      const board = await json<Board>(await getBoard(accounts[21]!))
      expect(board.rows).toHaveLength(20)
      expect(board.rows.map((r) => r.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
      expect(board.rows[0]).toEqual({ rank: 1, nickname: 'Thợ 01', approved: 1 })
      expect(board.me).toEqual({ rank: 22, nickname: 'Thợ 22', approved: 1 })
      expect((await json<Board>(await getBoard(null))).me).toBeNull()
    },
    120_000,
  )

  // ========================================================================== AC-CONTRIB-12
  it(
    'AC-CONTRIB-12: GET /me có đủ 3 đề xuất của A; DELETE /me xóa đề xuất chờ duyệt, bỏ gắn 2 đề xuất đã duyệt (vẫn ở /pipeline/state), mục của A trong /creators thành null, A rời Top cống hiến ngay',
    async () => {
      const A = await acct('Nick A')
      const B = await acct('Nick B')
      const t = Date.now()
      const p = await crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Đang Chờ Của A', emoji: '☕', description: 'mô tả chờ', image_url: 'https://example.com/p.png', at: t - 3000 })
      const x1 = await crow({ account: A.id, a: 'Cay', b: 'Cà Phê', name: 'Meme Một', description: 'mô tả một', image_url: 'https://example.com/1.png', status: 'approved', at: t - 5000 })
      const x2 = await crow({ account: A.id, a: 'Toang', b: 'Cà Phê', name: 'Meme Hai', emoji: '🍲', status: 'approved', at: t - 4000 })
      const y = await crow({ account: B.id, a: 'Hết Cứu', b: 'Toang', name: 'Meme Của B', status: 'approved', at: t - 2000 })
      await env.DB.batch([...A.stmts, ...B.stmts, p.stmt, x1.stmt, x2.stmt, y.stmt])
      await publish(2, [
        { a: 'Cay', b: 'Cà Phê', result: 'Meme Một', emoji: '🍲', depth: 2 },
        { a: 'Toang', b: 'Cà Phê', result: 'Meme Hai', emoji: '🍲', depth: 2 },
        { a: 'Hết Cứu', b: 'Toang', result: 'Meme Của B', emoji: '🍲', depth: 4 },
      ])
      const [e1, e2, eb] = await Promise.all(['Meme Một', 'Meme Hai', 'Meme Của B'].map(elementId))
      expect(await json(await getCreators(2))).toEqual({ [e1!]: 'Nick A', [e2!]: 'Nick A', [eb!]: 'Nick B' })
      expect((await json<Board>(await getBoard(null))).rows.map((r) => r.nickname)).toEqual(['Nick A', 'Nick B'])

      // xuất dữ liệu
      const exported = await G('/me', {}, A)
      expect(exported.status).toBe(200)
      const me = await json<{ account: { contributions: Contribution[] } | null }>(exported)
      const list = me.account!.contributions
      expect(list.map((c) => c.id).sort()).toEqual([p.id, x1.id, x2.id].sort())
      const by = new Map(list.map((c) => [c.id, c]))
      for (const c of list) expect(Object.keys(c).sort()).toEqual(CONTRIB_KEYS)
      expect(by.get(p.id)).toMatchObject({ name: 'Đang Chờ Của A', emoji: '☕', description: 'mô tả chờ', image_url: 'https://example.com/p.png', status: 'pending' })
      expect(by.get(x1.id)).toMatchObject({ name: 'Meme Một', description: 'mô tả một', image_url: 'https://example.com/1.png', status: 'approved' })
      expect(by.get(x2.id)).toMatchObject({ status: 'approved' })
      expect(JSON.stringify(list)).not.toContain('Meme Của B')

      // xóa tài khoản
      const del = await G('/me', { method: 'DELETE' }, A)
      expect(del.status).toBe(204)
      const cookie = del.headers.get('set-cookie') ?? ''
      expect(cookie).toContain(`${COOKIE}=`)
      expect(cookie.toLowerCase()).toContain('max-age=0')

      const left = await q<{ id: string; account_id: string | null; status: string }>('SELECT id, account_id, status FROM contribution ORDER BY created_at')
      expect(left.map((r) => r.id)).toEqual([x1.id, x2.id, y.id]) // đề xuất chờ duyệt đã bị xóa
      expect(left.map((r) => r.account_id)).toEqual([null, null, B.id])
      expect(await n('SELECT COUNT(*) AS n FROM account WHERE id = ?', A.id)).toBe(0)

      // meme đã duyệt ở lại game, nickname không còn trong bản chụp, rời bảng xếp hạng
      expect((await stateContributions()).map((c) => c.name).sort()).toEqual(['Meme Hai', 'Meme Một', 'Meme Của B'].sort())
      expect(await json(await getCreators(2))).toEqual({ [e1!]: null, [e2!]: null, [eb!]: 'Nick B' })
      expect((await json<Board>(await getBoard(null))).rows).toEqual([{ rank: 1, nickname: 'Nick B', approved: 1 }])
      expect(JSON.stringify(await json(await getCreators(2)))).not.toContain('Nick A')

      // phiên cũ không dùng được nữa
      await expectProblem(await getOne(A, x1.id), 401)
    },
    180_000,
  )

  // ========================================================================== AC-CONTRIB-TENANT
  it('AC-CONTRIB-TENANT: B không đọc được đề xuất của A (404 như mã không tồn tại, không 403), không thấy trong danh sách; gửi kèm UUID của A với phiên của B vẫn là đề xuất của B', async () => {
    const A = await acct('Bún Chả')
    const B = await acct()
    const secret = await crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Bí Mật Của A', description: 'chỉ A được xem' })
    await env.DB.batch([...A.stmts, ...B.stmts, secret.stmt])

    const stolen = await getOne(B, secret.id)
    const ghost = await getOne(B, crypto.randomUUID())
    const stolenBody = await expectProblem(stolen, 404)
    const ghostBody = await expectProblem(ghost, 404)
    expect(stolenBody.title).toBe(ghostBody.title)
    const list = await getMine(B)
    expect(JSON.stringify(await json(list))).not.toContain('Bí Mật Của A')

    tick()
    const forged = await postC(B, { a: 'Cay', b: 'Cà Phê', name: 'Giả Danh UUID' }, { player: A.player })
    if (forged.status === 201) {
      const id = (await json<Contribution>(forged)).id
      expect((await q<{ account_id: string }>('SELECT account_id FROM contribution WHERE id = ?', id))[0]!.account_id).toBe(B.id)
    } else {
      expect(forged.status).toBeGreaterThanOrEqual(400)
      expect(forged.status).toBeLessThan(500)
    }
    expect(await n('SELECT COUNT(*) AS n FROM contribution WHERE account_id = ? AND name = ?', A.id, 'Giả Danh UUID')).toBe(0)
    expect((await getOne(A, secret.id)).status).toBe(200) // A vẫn đọc được của mình
  })

  // ========================================================================== AC-CONTRIB-VALIDATION
  it(
    'AC-CONTRIB-VALIDATION: chuỗi khổng lồ (1 MB), tên phần tử 100 000 ký tự, link 100 000 ký tự, SQL injection và thẻ script trong tên, mã đường dẫn xấu -> không bao giờ 5xx, bảng còn nguyên',
    async () => {
      const A = await acct()
      await env.DB.batch(A.stmts)
      const ok = { a: 'Deadline', b: 'Cà Phê' }
      for (const [label, body] of [
        ['tên 1 MB', { ...ok, name: 'x'.repeat(1_000_000) }],
        ['phần tử a 100 000 ký tự', { a: 'x'.repeat(100_000), b: 'Cà Phê', name: 'Tên Tốt' }],
        ['link 100 000 ký tự', { ...ok, name: 'Tên Tốt', image_url: `https://${'a'.repeat(100_000)}` }],
        ['mô tả 1 MB', { ...ok, name: 'Tên Tốt', description: 'd'.repeat(1_000_000) }],
        ['a là ElementId thay vì tên', { a: await elementId('Deadline'), b: await elementId('Cà Phê'), name: 'Tên Tốt' }],
      ] as Array<[string, unknown]>) {
        tick()
        const res = await postC(A, body)
        expect([400, 413], label).toContain(res.status)
        isProblem(res)
      }
      expect(await countAllC()).toBe(0)

      for (const name of ["'); DROP TABLE contribution;--", '<script>alert(1)</script>', 'Robert"; DELETE FROM account;--']) {
        tick()
        const res = await postC(A, { ...ok, name })
        expect(res.status, name).toBeLessThan(500)
        expect([201, 400, 422], name).toContain(res.status)
        if (res.status === 201) {
          // nếu được nhận thì lưu nguyên văn, không biến dạng, và không đụng gì khác
          expect((await json<Contribution>(res)).name).toBe(name)
          await env.DB.prepare('DELETE FROM contribution WHERE account_id = ?').bind(A.id).run()
        }
      }
      expect(await n('SELECT COUNT(*) AS n FROM account WHERE id = ?', A.id)).toBe(1)

      for (const id of ['khong-phai-uuid', '..%2F..%2Fetc%2Fpasswd', 'A'.repeat(5000), '%3Cscript%3E']) {
        const res = await getOne(A, id)
        expect([400, 404], id.slice(0, 30)).toContain(res.status)
        isProblem(res)
        const admin = await adminEdit(id, { name: 'Tên Ổn' })
        expect([400, 404], id.slice(0, 30)).toContain(admin.status)
      }
      expect(await changeRows()).toEqual([])
    },
    180_000,
  )

  // ========================================================================== Hồi quy sau review PR #99
  it('AC-CONTRIB-05: chưa đăng nhập (không cookie) gửi thân sai (thiếu tên, Content-Type text/plain, không phải JSON) -> 401, không phải 400/415; không tạo đề xuất', async () => {
    const A = await acct()
    await env.DB.batch(A.stmts)
    await expectProblem(await postC(null, { a: 'Deadline', b: 'Cà Phê' }), 401)
    tick()
    const plain = await G(
      '/contributions',
      { method: 'POST', body: str({ a: 'Deadline', b: 'Cà Phê', name: 'Cà Phê Chạy Deadline' }), headers: { 'Content-Type': 'text/plain' } },
      null,
    )
    await expectProblem(plain, 401)
    tick()
    await expectProblem(await postC(null, 'đây không phải JSON {'), 401)
    expect(await countAllC()).toBe(0)
  })

  it(
    'AC-CONTRIB-05: tài khoản đã có 3 đề xuất hôm nay gửi song song 5 đề xuất hợp lệ cho 5 cặp trống -> tổng đúng 5 trong ngày; phần vượt hạn là 429 có Retry-After',
    async () => {
      const A = await acct()
      const now = Date.now()
      const used = await stmtsOf([
        { account: A.id, a: 'Cay', b: 'Stonks', name: 'Một', at: now - 3000 },
        { account: A.id, a: 'Cười', b: 'Stonks', name: 'Hai', at: now - 2000 },
        { account: A.id, a: 'Toang', b: 'Stonks', name: 'Ba', at: now - 1000 },
      ])
      await env.DB.batch([...A.stmts, ...used])
      const pairs: Array<[string, string]> = [
        ['Deadline', 'Cà Phê'],
        ['Cay', 'Cà Phê'],
        ['Toang', 'Cà Phê'],
        ['Cười', 'Cà Phê'],
        ['Hết Cứu', 'Toang'],
      ]
      const results = await Promise.all(pairs.map(([a, b], i) => postC(A, { a, b, name: `Song Song ${i}` })))
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 429, 429, 429])
      for (const r of results.filter((x) => x.status === 429)) {
        isProblem(r)
        expect(Number(r.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
      }
      expect(await countC(A.id)).toBe(5)
    },
    120_000,
  )

  it(
    'AC-CONTRIB-02: biểu tượng là một hình kèm nhiều dấu kết hợp ("☕" + U+0301 x3) -> 400 nêu emoji; VS16, chuỗi ZWJ, sắc da, keycap vẫn được nhận',
    async () => {
      const A = await acct()
      await env.DB.batch(A.stmts)
      const bad = await postC(A, { a: 'Deadline', b: 'Cà Phê', name: 'Biểu Tượng Rác', emoji: '☕́́́' })
      expect(bad.status).toBe(400)
      isProblem(bad)
      expect(JSON.stringify(await bad.json())).toContain('emoji')
      expect(await countAllC()).toBe(0)

      const good: Array<[string, string, string, string]> = [
        ['VS16', 'Deadline', 'Cà Phê', '☕️'],
        ['ZWJ', 'Cay', 'Cà Phê', '\u{1F468}‍\u{1F373}'],
        ['sắc da', 'Toang', 'Cà Phê', '\u{1F44D}\u{1F3FD}'],
        ['keycap', 'Cười', 'Cà Phê', '1️⃣'],
      ]
      for (const [label, a, b, emoji] of good) {
        tick()
        const res = await postC(A, { a, b, name: `Biểu Tượng ${label}`, emoji })
        expect(res.status, label).toBe(201)
        expect((await json<Contribution>(res)).emoji, label).toBe(emoji)
      }
      expect(await countAllC()).toBe(4)
    },
    120_000,
  )

  it('AC-CONTRIB-02: tên chứa ký tự điều khiển hoặc định dạng (xuống dòng, U+200B giữa "Cà" và "Phê") -> 400 nêu name, không tạo đề xuất', async () => {
    const A = await acct()
    await env.DB.batch(A.stmts)
    for (const name of ['Cà\nPhê', 'Cà​Phê']) {
      tick()
      const res = await postC(A, { a: 'Deadline', b: 'Cà Phê', name })
      expect(res.status, JSON.stringify(name)).toBe(400)
      isProblem(res)
      expect(JSON.stringify(await res.json())).toContain('name')
    }
    expect(await countAllC()).toBe(0)
  })

  it('AC-CONTRIB-08: duyệt và từ chối cùng một đề xuất chờ duyệt song song -> đúng một 200 và một 409; admin_change có đúng 1 dòng cho đề xuất đó', async () => {
    const A = await acct()
    const p = await crow({ account: A.id, a: 'Deadline', b: 'Cà Phê', name: 'Đua Duyệt Và Loại' })
    await env.DB.batch([...A.stmts, p.stmt])
    const [approve, reject] = await Promise.all([adminApprove(p.id, { image_hint: HINT }), adminReject(p.id, { reason: 'Không hợp' })])
    expect([approve.status, reject.status].sort()).toEqual([200, 409])
    isProblem(approve.status === 409 ? approve : reject)
    const changes = (await changeRows()).filter((c) => c.target_id === p.id)
    expect(changes).toHaveLength(1)
    const status = (await q<{ status: string }>('SELECT status FROM contribution WHERE id = ?', p.id))[0]!.status
    expect(changes[0]!.action).toBe(status === 'approved' ? 'approve_contribution' : 'reject_contribution')
    expect(await changeRows()).toHaveLength(1)
  })
})
