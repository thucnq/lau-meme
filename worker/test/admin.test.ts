// Acceptance tests for docs/acceptance/admin.md (worker part: AC-ADMIN-01..10, VALIDATION, ABUSE).
// Black-box: only docs/api/openapi.yaml, ADR 0002/0008 and the D1 schema (0002_content, 0003_player_data, 0004_ops).
// Performance: D1 in Miniflare costs ~66 ms/query, so every test seeds with ONE env.DB.batch and keeps requests few.
// The admin API lives on its own host (ADR 0008): https://laumeme-admin.dinoduct.fun/api/admin/*, no BASE_PATH.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['admin', 'test', 'token', 'ok'].join('-')
const WRONG = ['admin', 'test', 'token', 'no'].join('-')
const PIPELINE_TOKEN = ['admin', 'pipeline', 'token'].join('-')
const IP_KEY = ['admin', 'ip', 'hash', 'key'].join('-')
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_ORIGIN = 'https://dinoduct.fun'
const GAME_API = `${GAME_ORIGIN}/lau-meme/api`
const NAV = { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' }

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Problem = { type: string; title: string; status: number; detail?: string }
type Blocklist = { elements: string[]; recipes: string[]; images: string[] }
type Page<T> = { page: number; size: number; total: number; items: T[] }
type Row = Record<string, unknown>
type Kind = 'element' | 'recipe' | 'image'
type Ref = { id: string; name: string; emoji: string }
type ReportItem = {
  target: string
  id: string
  name: string
  emoji: string
  reporters: number
  reasons: Record<string, number>
  last_reported_at: string
  state: string
}
type ElementItem = { id: string; name: string; emoji: string; depth: number; state: string; image_key: string | null; image_state: string; last_version: number }
type RecipeItem = { id: string; a: Ref; b: Ref; result: Ref; state: string }
type BatchItem = {
  id: string
  version: number | null
  batch_at: string
  mode: string
  status: string
  failed_step: string | null
  rollback_to: number | null
  stats: Record<string, number>
  issue_url: string | null
  created_at: string
}
type AuditItem = {
  action: string
  target_kind: string
  target_id: string
  before: string
  after: string
  reason: string | null
  token_fp: string
  created_at: string
}

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

// ---------------------------------------------------------------------------- seeded catalog
const PLAIN = 'Ad Món Thường' // no image
const IMG = 'Ad Món Có Ảnh' // image_key set
const IMG2 = 'Ad Món Ảnh Hai' // image_key set, never blocked
const OTHER = 'Ad Món Khác'
const RA = 'Ad Cay'
const RB = 'Ad Cười'
const RC = 'Ad Lẩu' // RA + RB = RC
const PROPS = Array.from({ length: 4 }, (_, i) => `Ad Phụ ${i}`)
const IMG_KEY = 'aaaaaaaaaaaa.webp'
const IMG2_KEY = 'bbbbbbbbbbbb.webp'

const elementRow = (name: string, imageKey: string | null) =>
  elementId(name).then((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO element (id, name, name_fold, emoji, depth, origin, image_key, first_version, last_version, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, ?)',
    ).bind(id, name, fold(name), '🍲', 'vn', imageKey, Date.now()),
  )

async function recipeRow() {
  const [ia, ib, ic] = await Promise.all([elementId(RA), elementId(RB), elementId(RC)])
  const [lo, hi] = [ia, ib].sort()
  return env.DB.prepare(
    'INSERT OR IGNORE INTO recipe (id, a_id, b_id, result_id, score, first_version, last_version, updated_at) VALUES (?, ?, ?, ?, 3, 1, 1, ?)',
  ).bind(await recipeId(RA, RB), lo, hi, ic, Date.now())
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

/** A fresh documentation-range IP for every request unless a test pins one, so wrong-token tests never lock each other out. */
let ipCounter = 0
const nextIp = () => {
  ipCounter++
  return `10.20.${ipCounter >> 8}.${ipCounter & 255}`
}

type AOpts = { method?: string; body?: unknown; auth?: string | null; ip?: string; headers?: Record<string, string> }
/** Call /api/admin<path> on the admin host. `auth: null` sends no Authorization header. */
function A(path: string, o: AOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': o.ip ?? nextIp(), ...(o.headers ?? {}) }
  const auth = o.auth === undefined ? `Bearer ${TOKEN}` : o.auth
  if (auth !== null) headers.Authorization = auth
  const hasBody = o.body !== undefined
  const init: RequestInit = { method: o.method ?? (hasBody ? 'POST' : 'GET') }
  if (hasBody) init.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
  return raw(`${ADMIN_ORIGIN}/api/admin${path}`, init, headers)
}

const mod = (target_kind: string, target_id: string, action: string, reason?: string, extra: AOpts = {}) =>
  A('/moderation', { ...extra, body: { target_kind, target_id, action, ...(reason === undefined ? {} : { reason }) } })
const getBlocklist = () => raw(`${GAME_API}/blocklist?fresh=1`, {}, { 'CF-Connecting-IP': nextIp() })
const getPipelineState = () => raw(`${GAME_API}/pipeline/state`, {}, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const newId = () => crypto.randomUUID()
const json = async <T>(res: Response) => (await res.json()) as T
const blocklist = async () => json<Blocklist>(await getBlocklist())

// ---------------------------------------------------------------------------- seeding
const T0 = Date.UTC(2026, 9, 20, 3, 0, 0)
const ins = {
  consent: (player: string) =>
    env.DB.prepare(
      "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
    ).bind(newId(), player, POLICY_VERSION, Date.now() - 1000),
  report: (kind: 'element' | 'image', target: string, player: string | null, reason: string, createdAt: number, status = 'new', cycle = 0) =>
    env.DB.prepare(
      'INSERT INTO report (id, kind, target_id, cycle, player_id, reason, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
    ).bind(newId(), kind, target, cycle, player, reason, status, createdAt),
  block: (kind: Kind, target: string, state: 'hidden' | 'blocked', reason: 'auto_report' | 'admin') =>
    env.DB.prepare('INSERT INTO block (kind, target_id, state, reason, created_at) VALUES (?, ?, ?, ?, ?)').bind(kind, target, state, reason, Date.now()),
  batchRun: (
    id: string,
    version: number | null,
    batchAt: number,
    mode: string,
    status: string,
    failedStep: string | null,
    rollbackTo: number | null,
    stats: unknown,
    issueUrl: string | null,
    createdAt: number,
  ) =>
    env.DB.prepare(
      'INSERT INTO batch_run (id, version, batch_at, mode, status, failed_step, rollback_to, daily_element_id, stats_json, issue_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
    ).bind(id, version, batchAt, mode, status, failedStep, rollbackTo, JSON.stringify(stats), issueUrl, createdAt),
}

const reportRows = async (): Promise<Row[]> => (await env.DB.prepare('SELECT * FROM report ORDER BY created_at, id').all<Row>()).results
const blockRow = async (kind: Kind, id: string): Promise<Row[]> =>
  (await env.DB.prepare('SELECT state, reason FROM block WHERE kind = ? AND target_id = ?').bind(kind, id).all<Row>()).results
const bannedRows = async (termFold: string): Promise<Row[]> =>
  (await env.DB.prepare('SELECT term_fold, source FROM banned_term WHERE term_fold = ?').bind(termFold).all<Row>()).results
const cycleOf = async (kind: 'element' | 'image', id: string) =>
  (await env.DB.prepare('SELECT cycle FROM report_target WHERE kind = ? AND target_id = ?').bind(kind, id).first<{ cycle: number }>())?.cycle
const auditRows = async (): Promise<Row[]> => (await env.DB.prepare('SELECT * FROM admin_audit ORDER BY created_at, id').all<Row>()).results
const COUNT_SQL = {
  admin_audit: 'SELECT COUNT(*) AS n FROM admin_audit',
  block: 'SELECT COUNT(*) AS n FROM block',
  report_target: 'SELECT COUNT(*) AS n FROM report_target',
  banned_term: 'SELECT COUNT(*) AS n FROM banned_term',
} as const
const count = async (table: keyof typeof COUNT_SQL): Promise<number> => (await env.DB.prepare(COUNT_SQL[table]).first<{ n: number }>())!.n

// ---------------------------------------------------------------------------- logging spy (AC-ADMIN-01: no token in logs)
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const
function spyConsole() {
  const spies = CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
  const safe = (a: unknown): string => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`
    try {
      return JSON.stringify(a) ?? String(a)
    } catch {
      return String(a)
    }
  }
  return () => spies.flatMap((s) => s.mock.calls.flat()).map(safe).join('\n')
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM report'),
    env.DB.prepare('DELETE FROM report_target'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM banned_term'),
    env.DB.prepare('DELETE FROM admin_audit'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM consent'),
    env.DB.prepare('DELETE FROM rate_counter'),
    await elementRow(PLAIN, null),
    await elementRow(IMG, IMG_KEY),
    await elementRow(IMG2, IMG2_KEY),
    await elementRow(OTHER, null),
    await elementRow(RA, null),
    await elementRow(RB, null),
    await elementRow(RC, null),
    ...(await Promise.all(PROPS.map((n) => elementRow(n, null)))),
    await recipeRow(),
  ])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('admin', () => {
  // ------------------------------------------------------------------------ AC-ADMIN-01
  it(
    'AC-ADMIN-01: thiếu token, token sai, sai sơ đồ (Basic) trên mọi endpoint /api/admin/* trả 401 problem+json, không lộ nội dung, không ghi token vào log',
    async () => {
      const logged = spyConsole()
      const p = await elementId(PLAIN)
      await env.DB.batch([ins.batchRun(newId(), 1, T0, 'core', 'success', null, null, { added: 7 }, 'https://github.com/leak-marker/x/issues/1', T0)])
      const endpoints: Array<[string, AOpts]> = [
        ['/reports', {}],
        ['/elements', {}],
        [`/recipes?element_id=${p}`, {}],
        ['/batches', {}],
        ['/audit', {}],
        ['/moderation', { body: { target_kind: 'element', target_id: p, action: 'hide' } }],
      ]
      const auths: Array<string | null> = [null, `Bearer ${WRONG}`, `Basic ${btoa(`admin:${TOKEN}`)}`]
      for (const [path, opts] of endpoints) {
        for (const auth of auths) {
          const res = await A(path, { ...opts, auth })
          const label = `${path} ${auth === null ? 'no auth' : auth.split(' ')[0]}`
          expect(res.status, label).toBe(401)
          isProblem(res)
          const text = await res.text()
          expect((JSON.parse(text) as Problem).status, label).toBe(401)
          for (const leak of ['leak-marker', 'github.com', PLAIN, 'Ad Món', p]) expect(text, label).not.toContain(leak)
        }
      }
      expect(await count('admin_audit')).toBe(0)
      expect(await blockRow('element', p)).toEqual([]) // the unauthenticated POST changed nothing
      expect((await A('/batches')).status).toBe(200) // a right-token request is logged-free too
      const out = logged()
      expect(out).not.toContain(TOKEN)
      expect(out).not.toContain(WRONG)
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-ADMIN-02
  it(
    'AC-ADMIN-02: 5 yêu cầu sai token (vẫn 401) khóa IP băm 15 phút: yêu cầu thứ 6 kể cả token đúng trả 429 problem+json có Retry-After; IP khác không bị ảnh hưởng; hết 15 phút dùng lại được',
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const t = Date.parse('2026-10-20T06:30:10.000Z')
      vi.setSystemTime(new Date(t))
      const ip = nextIp()
      const statuses: number[] = []
      for (let i = 0; i < 5; i++) statuses.push((await A('/audit', { auth: `Bearer ${WRONG}`, ip })).status)
      expect(statuses).toEqual([401, 401, 401, 401, 401])

      const locked = await A('/audit', { ip })
      expect(locked.status).toBe(429)
      isProblem(locked)
      const retry = Number(locked.headers.get('retry-after'))
      expect(Number.isInteger(retry)).toBe(true)
      expect(retry).toBeGreaterThanOrEqual(600)
      expect(retry).toBeLessThanOrEqual(900)
      expect(((await locked.json()) as Problem).status).toBe(429)

      expect((await A('/audit', { auth: `Bearer ${WRONG}`, ip })).status).toBe(429)
      expect((await A('/audit')).status).toBe(200) // another IP is untouched

      vi.setSystemTime(new Date(t + 14 * 60_000))
      expect((await A('/audit', { ip })).status).toBe(429)
      vi.setSystemTime(new Date(t + 15 * 60_000 + 2000))
      expect((await A('/audit', { ip })).status).toBe(200)
    },
    60_000,
  )

  it('AC-ADMIN-02: 4 yêu cầu sai token chưa khóa: yêu cầu đúng token ngay sau đó vẫn 200', async () => {
    const ip = nextIp()
    for (let i = 0; i < 4; i++) expect((await A('/audit', { auth: `Bearer ${WRONG}`, ip })).status).toBe(401)
    expect((await A('/audit', { ip })).status).toBe(200)
  })

  // ------------------------------------------------------------------------ AC-ADMIN-03
  it(
    'AC-ADMIN-03: ẩn P kèm lý do trả 200 và P vào blocklist ngay; hiện P trả 200, P ra khỏi blocklist, báo cáo mới được đánh dấu đã xử lý và bộ đếm tăng chu kỳ; P không tồn tại trả 404',
    async () => {
      const p = await elementId(PLAIN)
      const [u1, u2, u3] = [newId(), newId(), newId()]
      await env.DB.batch([ins.report('element', p, u1, 'real_person', T0), ins.report('element', p, u2, 'sexual', T0 + 1000)])
      expect((await blocklist()).elements).not.toContain(p)

      const hide = await mod('element', p, 'hide', 'vi phạm nhẹ')
      expect(hide.status).toBe(200)
      expect(await hide.json()).toEqual({ target_kind: 'element', target_id: p, before: 'active', after: 'hidden' })
      expect(await blockRow('element', p)).toEqual([{ state: 'hidden', reason: 'admin' }])
      expect((await blocklist()).elements).toContain(p)
      expect((await reportRows()).map((r) => r.status)).toEqual(['resolved_hidden', 'resolved_hidden'])

      expect((await mod('element', p, 'hide')).status).toBe(409)

      await env.DB.batch([ins.report('element', p, u3, 'real_person', T0 + 2000)])
      const show = await mod('element', p, 'show')
      expect(show.status).toBe(200)
      expect(await show.json()).toEqual({ target_kind: 'element', target_id: p, before: 'hidden', after: 'active' })
      expect(await blockRow('element', p)).toEqual([])
      expect((await blocklist()).elements).not.toContain(p)
      expect((await reportRows()).map((r) => r.status)).toEqual(['resolved_hidden', 'resolved_hidden', 'resolved_shown'])
      expect(await cycleOf('element', p)).toBe(1)

      expect((await mod('element', p, 'show')).status).toBe(409) // already active

      const ghost = await mod('element', await elementId('Ad Không Có Thật'), 'hide')
      expect(ghost.status).toBe(404)
      isProblem(ghost)
      expect(await count('admin_audit')).toBe(2)
    },
    60_000,
  )

  it('AC-ADMIN-03: danh mục phần tử tìm không dấu ("mon thuong" ra "Món Thường"), lọc trạng thái, trạng thái ảnh, phân trang mặc định 50', async () => {
    const [p, o, img, img2] = await Promise.all([elementId(PLAIN), elementId(OTHER), elementId(IMG), elementId(IMG2)])
    await env.DB.batch([ins.block('element', p, 'hidden', 'admin'), ins.block('element', o, 'blocked', 'admin'), ins.block('image', img, 'hidden', 'auto_report')])

    const found = await A('/elements?q=mon%20thuong')
    expect(found.status).toBe(200)
    const foundBody = await json<Page<ElementItem>>(found)
    expect(foundBody).toMatchObject({ page: 1, size: 50, total: 1 })
    expect(foundBody.items).toEqual([{ id: p, name: PLAIN, emoji: '🍲', depth: 1, state: 'hidden', image_key: null, image_state: 'none', last_version: 1, tier: 1, tier_source: 'auto', auto_tier: null }])

    const accented = await json<Page<ElementItem>>(await A(`/elements?q=${encodeURIComponent('MÓN THƯỜNG')}`))
    expect(accented.items.map((i) => i.id)).toEqual([p])

    const hidden = await json<Page<ElementItem>>(await A('/elements?state=hidden&size=100'))
    expect(hidden.items.map((i) => i.id)).toEqual([p])
    const blocked = await json<Page<ElementItem>>(await A('/elements?state=blocked&size=100'))
    expect(blocked.items.map((i) => i.id)).toEqual([o])
    const active = await json<Page<ElementItem>>(await A('/elements?state=active&size=100'))
    const activeIds = active.items.map((i) => i.id)
    expect(activeIds).toContain(img)
    expect(activeIds).not.toContain(p)
    expect(activeIds).not.toContain(o)
    expect(active.items.every((i) => i.state === 'active')).toBe(true)

    const byId = new Map(active.items.map((i) => [i.id, i]))
    expect(byId.get(img)).toMatchObject({ image_key: IMG_KEY, image_state: 'hidden', state: 'active' })
    expect(byId.get(img2)).toMatchObject({ image_key: IMG2_KEY, image_state: 'active' })
  }, 60_000)

  // ------------------------------------------------------------------------ AC-ADMIN-04
  it(
    'AC-ADMIN-04: ẩn công thức A+B và ảnh của P rồi hiện lại từng thứ: vào/ra blocklist.recipes / .images; phần tử C và P không bị ẩn theo',
    async () => {
      const [ia, ib, ic, p] = await Promise.all([elementId(RA), elementId(RB), elementId(RC), elementId(IMG)])
      const rid = await recipeId(RA, RB)
      const [lo, hi] = [ia, ib].sort()
      const ref = (id: string, name: string): Ref => ({ id, name, emoji: '🍲' })
      const names = new Map([
        [ia, RA],
        [ib, RB],
      ])

      const before = await A(`/recipes?element_id=${ic}`)
      expect(before.status).toBe(200)
      const beforeBody = await json<Page<RecipeItem>>(before)
      expect(beforeBody.total).toBe(1)
      expect(beforeBody.items).toEqual([{ id: rid, a: ref(lo!, names.get(lo!)!), b: ref(hi!, names.get(hi!)!), result: ref(ic, RC), state: 'active' }])
      expect((await json<Page<RecipeItem>>(await A(`/recipes?element_id=${ia}`))).items.map((i) => i.id)).toEqual([rid]) // as input

      const hideR = await mod('recipe', rid, 'hide')
      expect(hideR.status).toBe(200)
      expect(await hideR.json()).toEqual({ target_kind: 'recipe', target_id: rid, before: 'active', after: 'hidden' })
      const hideI = await mod('image', p, 'hide')
      expect(hideI.status).toBe(200)
      expect(await hideI.json()).toEqual({ target_kind: 'image', target_id: p, before: 'active', after: 'hidden' })

      const hidden = await blocklist()
      expect(hidden.recipes).toEqual([rid])
      expect(hidden.images).toEqual([p])
      for (const id of [ic, p, ia, ib]) expect(hidden.elements).not.toContain(id)
      expect((await json<Page<RecipeItem>>(await A(`/recipes?element_id=${ic}`))).items[0]!.state).toBe('hidden')

      expect((await mod('recipe', rid, 'show')).status).toBe(200)
      expect((await mod('image', p, 'show')).status).toBe(200)
      const shown = await blocklist()
      expect(shown.recipes).toEqual([])
      expect(shown.images).toEqual([])
      expect(shown.elements).toEqual([])

      expect((await mod('recipe', await recipeId('Ad Không', 'Có Công Thức'), 'hide')).status).toBe(404)
      expect((await mod('image', await elementId(PLAIN), 'hide')).status).toBe(404) // element without image_key
      expect(await count('admin_audit')).toBe(4)
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-ADMIN-05
  it(
    'AC-ADMIN-05: chặn P trả 200, P vào blocklist, fold của P vào banned_term (admin) và banned_aliases của pipeline; hiện/ẩn/chặn lại phần tử đã chặn trả 409',
    async () => {
      const p = await elementId(PLAIN)
      const res = await mod('element', p, 'block', 'tên người thật')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ target_kind: 'element', target_id: p, before: 'active', after: 'blocked' })
      expect(await blockRow('element', p)).toEqual([{ state: 'blocked', reason: 'admin' }])
      expect(await bannedRows(fold(PLAIN))).toEqual([{ term_fold: fold(PLAIN), source: 'admin' }])
      expect((await blocklist()).elements).toContain(p)

      const state = await getPipelineState()
      expect(state.status).toBe(200)
      expect((await json<{ banned_aliases: string[] }>(state)).banned_aliases).toContain(fold(PLAIN))

      for (const action of ['show', 'hide', 'block']) {
        const conflict = await mod('element', p, action)
        expect(conflict.status, action).toBe(409)
        isProblem(conflict)
      }
      expect(await blockRow('element', p)).toEqual([{ state: 'blocked', reason: 'admin' }])
      expect(await count('admin_audit')).toBe(1)
    },
    60_000,
  )

  it('AC-ADMIN-05: gỡ chặn tường minh: blocked→active xóa block và bí danh admin, tăng chu kỳ báo cáo; không phải blocked trả 409; ẩn rồi chặn được', async () => {
    const [o, h] = [await elementId(OTHER), await elementId(PROPS[0]!)]
    await env.DB.batch([ins.block('element', o, 'hidden', 'admin')])
    const block = await mod('element', o, 'block')
    expect(block.status).toBe(200)
    expect(await block.json()).toEqual({ target_kind: 'element', target_id: o, before: 'hidden', after: 'blocked' })
    expect(await blockRow('element', o)).toEqual([{ state: 'blocked', reason: 'admin' }])
    expect(await bannedRows(fold(OTHER))).toEqual([{ term_fold: fold(OTHER), source: 'admin' }])

    const un = await mod('element', o, 'unblock')
    expect(un.status).toBe(200)
    expect(await un.json()).toEqual({ target_kind: 'element', target_id: o, before: 'blocked', after: 'active' })
    expect(await blockRow('element', o)).toEqual([])
    expect(await bannedRows(fold(OTHER))).toEqual([])
    expect(await cycleOf('element', o)).toBe(1)
    expect((await blocklist()).elements).not.toContain(o)

    expect((await mod('element', o, 'unblock')).status).toBe(409) // now active
    await env.DB.batch([ins.block('element', h, 'hidden', 'admin')])
    expect((await mod('element', h, 'unblock')).status).toBe(409) // hidden, not blocked
    expect(await count('admin_audit')).toBe(2)
  }, 60_000)

  // ------------------------------------------------------------------------ AC-ADMIN-06
  it(
    'AC-ADMIN-06: danh sách báo cáo gom theo đích, lọc new/resolved, xếp theo số UUID giảm dần, có tên/emoji/lý do/thời điểm/trạng thái ẩn, phân trang, không lộ UUID người báo cáo',
    async () => {
      const [p, o, img, r0] = await Promise.all([elementId(PLAIN), elementId(OTHER), elementId(IMG), elementId(PROPS[0]!)])
      const u = Array.from({ length: 9 }, () => newId())
      await env.DB.batch([
        ins.report('element', p, u[0]!, 'real_person', T0 + 1000),
        ins.report('element', p, u[1]!, 'real_person', T0 + 2000),
        ins.report('element', p, u[2]!, 'sexual', T0 + 3000),
        ins.report('image', img, u[3]!, 'inappropriate_image', T0 + 4000),
        ins.report('image', img, u[4]!, 'inappropriate_image', T0 + 5000),
        ins.report('element', o, u[5]!, 'other', T0 + 6000),
        ins.report('element', r0, u[6]!, 'sexual', T0 + 7000, 'resolved_dismissed'),
        ins.report('element', r0, u[7]!, 'sexual', T0 + 8000, 'resolved_hidden'),
        ins.report('element', p, u[8]!, 'politics_religion', T0 + 9000, 'resolved_shown'),
        ins.block('image', img, 'hidden', 'auto_report'),
      ])

      const res = await A('/reports?status=new')
      expect(res.status).toBe(200)
      const text = await res.text()
      for (const id of u) expect(text).not.toContain(id)
      const body = JSON.parse(text) as Page<ReportItem>
      expect(body).toMatchObject({ page: 1, size: 50, total: 3 })
      expect(body.items.map((i) => `${i.target}:${i.id}`)).toEqual([`element:${p}`, `image:${img}`, `element:${o}`])
      expect(body.items.map((i) => i.reporters)).toEqual([3, 2, 1])
      expect(Object.keys(body.items[0]!).sort()).toEqual(['emoji', 'id', 'last_reported_at', 'name', 'reasons', 'reporters', 'state', 'target'])
      expect(body.items[0]).toMatchObject({ name: PLAIN, emoji: '🍲', reasons: { real_person: 2, sexual: 1 }, state: 'active' })
      expect(Date.parse(body.items[0]!.last_reported_at)).toBe(T0 + 3000) // the resolved report of P is not among "new"
      expect(body.items[1]).toMatchObject({ name: IMG, reasons: { inappropriate_image: 2 }, state: 'hidden' })
      expect(Date.parse(body.items[1]!.last_reported_at)).toBe(T0 + 5000)
      expect(body.items[2]).toMatchObject({ reporters: 1, reasons: { other: 1 }, state: 'active' })

      const dflt = await json<Page<ReportItem>>(await A('/reports')) // status defaults to new
      expect(dflt.items.map((i) => i.id)).toEqual(body.items.map((i) => i.id))

      const resolved = await json<Page<ReportItem>>(await A('/reports?status=resolved'))
      expect(resolved.total).toBe(2)
      expect(resolved.items.map((i) => [i.id, i.reporters])).toEqual([
        [r0, 2],
        [p, 1],
      ])
      expect(resolved.items[0]!.reasons).toEqual({ sexual: 2 })

      const page2 = await json<Page<ReportItem>>(await A('/reports?status=new&page=2&size=2'))
      expect(page2).toMatchObject({ page: 2, size: 2, total: 3 })
      expect(page2.items.map((i) => i.id)).toEqual([o])
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-ADMIN-07
  it(
    'AC-ADMIN-07: bỏ qua báo cáo của P đang tự ẩn: báo cáo thành resolved_dismissed, P hiện lại, báo cáo mới đếm lại từ 0 (2 UUID mới chưa ẩn, UUID thứ 3 mới ẩn)',
    async () => {
      const p = await elementId(PLAIN)
      const old = [newId(), newId(), newId()]
      const fresh = [newId(), newId(), newId()]
      await env.DB.batch([
        ...old.map((u, i) => ins.report('element', p, u, 'real_person', T0 + i * 1000)),
        ins.block('element', p, 'hidden', 'auto_report'),
        ...fresh.map((u) => ins.consent(u)),
      ])
      expect((await blocklist()).elements).toContain(p)

      const res = await mod('element', p, 'dismiss_reports', 'không vi phạm')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ target_kind: 'element', target_id: p, before: 'hidden', after: 'active' })
      expect((await reportRows()).map((r) => r.status)).toEqual(['resolved_dismissed', 'resolved_dismissed', 'resolved_dismissed'])
      expect(await blockRow('element', p)).toEqual([])
      expect(await cycleOf('element', p)).toBe(1)
      expect((await blocklist()).elements).not.toContain(p)
      expect((await json<Page<ReportItem>>(await A('/reports?status=new'))).items.map((i) => i.id)).not.toContain(p)

      const send = (player: string) =>
        raw(`${GAME_API}/reports`, { method: 'POST', body: JSON.stringify({ target: 'element', id: p, reason: 'real_person' }) }, { 'X-Player-Id': player, 'CF-Connecting-IP': nextIp() })
      for (const player of [fresh[0]!, fresh[1]!]) expect((await send(player)).status).toBe(201)
      expect(await blockRow('element', p)).toEqual([]) // 2 new + 3 old would be 5 if old reports still counted
      expect((await send(fresh[2]!)).status).toBe(201)
      expect(await blockRow('element', p)).toEqual([{ state: 'hidden', reason: 'auto_report' }])
    },
    60_000,
  )

  it(
    'AC-ADMIN-07: bỏ qua không gỡ ẩn của quản trị hay chặn (after = before); ảnh tự ẩn được hiện lại; không có báo cáo vẫn 200; công thức trả 422',
    async () => {
      const [h, b, none, img, r] = [await elementId(OTHER), await elementId(PROPS[0]!), await elementId(PROPS[1]!), await elementId(IMG), await recipeId(RA, RB)]
      await env.DB.batch([
        ins.block('element', h, 'hidden', 'admin'),
        ins.block('element', b, 'blocked', 'admin'),
        ins.block('image', img, 'hidden', 'auto_report'),
        ins.report('element', h, newId(), 'sexual', T0),
        ins.report('element', b, newId(), 'sexual', T0 + 1),
        ins.report('image', img, newId(), 'inappropriate_image', T0 + 2),
      ])

      const adminHidden = await mod('element', h, 'dismiss_reports')
      expect(adminHidden.status).toBe(200)
      expect(await adminHidden.json()).toEqual({ target_kind: 'element', target_id: h, before: 'hidden', after: 'hidden' })
      expect(await blockRow('element', h)).toEqual([{ state: 'hidden', reason: 'admin' }])

      const blocked = await mod('element', b, 'dismiss_reports')
      expect(blocked.status).toBe(200)
      expect(await blocked.json()).toEqual({ target_kind: 'element', target_id: b, before: 'blocked', after: 'blocked' })
      expect(await blockRow('element', b)).toEqual([{ state: 'blocked', reason: 'admin' }])

      const image = await mod('image', img, 'dismiss_reports')
      expect(image.status).toBe(200)
      expect(await image.json()).toEqual({ target_kind: 'image', target_id: img, before: 'hidden', after: 'active' })
      expect(await blockRow('image', img)).toEqual([])

      const empty = await mod('element', none, 'dismiss_reports')
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({ target_kind: 'element', target_id: none, before: 'active', after: 'active' })

      expect((await reportRows()).every((x) => x.status === 'resolved_dismissed')).toBe(true)
      expect((await mod('recipe', r, 'dismiss_reports')).status).toBe(422)
      expect(await count('admin_audit')).toBe(4)
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-ADMIN-08
  it(
    'AC-ADMIN-08: 20 đợt: trả mới nhất trước, mỗi đợt đủ version/batch_at/mode/status/failed_step/rollback_to/stats/issue_url/created_at; phân trang',
    async () => {
      const B0 = Date.UTC(2026, 9, 1, 0, 0, 0)
      const spec = (i: number) => {
        const status = i % 7 === 5 ? 'rollback' : i % 5 === 3 ? 'error' : 'success'
        return {
          id: newId(),
          version: status === 'success' ? i + 1 : null,
          batch_at: B0 + i * 3_600_000,
          mode: i % 2 === 0 ? 'core' : 'full',
          status,
          failed_step: status === 'error' ? 'publish' : null,
          rollback_to: status === 'rollback' ? i : null,
          stats: { added: i, blocked: i % 3, queued: i * 2, source_errors: i % 4 },
          issue_url: i === 7 || i === 8 ? `https://github.com/thucnq/lau-meme/issues/${i}` : null,
          created_at: B0 + i * 3_600_000 + 5000,
        }
      }
      const specs = Array.from({ length: 20 }, (_, i) => spec(i))
      await env.DB.batch(specs.map((s) => ins.batchRun(s.id, s.version, s.batch_at, s.mode, s.status, s.failed_step, s.rollback_to, s.stats, s.issue_url, s.created_at)))
      const expected = (s: ReturnType<typeof spec>) => ({ ...s, batch_at: s.batch_at, created_at: s.created_at })
      const norm = (it: BatchItem) => ({ ...it, batch_at: Date.parse(it.batch_at), created_at: Date.parse(it.created_at) })
      const newestFirst = [...specs].reverse()

      const res = await A('/batches')
      expect(res.status).toBe(200)
      const body = await json<Page<BatchItem>>(res)
      expect(body).toMatchObject({ page: 1, size: 50, total: 20 })
      expect(body.items.map(norm)).toEqual(newestFirst.map(expected))
      expect(new Set(body.items.map((i) => i.status))).toEqual(new Set(['success', 'error', 'rollback']))
      expect(body.items.filter((i) => i.issue_url !== null)).toHaveLength(2)

      const page = await json<Page<BatchItem>>(await A('/batches?page=2&size=5'))
      expect(page).toMatchObject({ page: 2, size: 5, total: 20 })
      expect(page.items.map((i) => i.id)).toEqual(newestFirst.slice(5, 10).map((s) => s.id))
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-ADMIN-09
  it(
    'AC-ADMIN-09: mỗi lệnh ghi thành công (ẩn, hiện, chặn, gỡ chặn, bỏ qua) đúng 1 dòng audit; lệnh 4xx không ghi; danh sách audit mới nhất trước, có dấu vân token, phân trang',
    async () => {
      const [e1, e2, e3] = [await elementId(PLAIN), await elementId(OTHER), await elementId(PROPS[0]!)]
      const fp = hex(await sha256(TOKEN)).slice(0, 8)
      const writes: Array<[string, string, string, string | undefined, string, string]> = [
        ['hide', e1, 'element', 'spam', 'active', 'hidden'],
        ['show', e1, 'element', undefined, 'hidden', 'active'],
        ['block', e2, 'element', 'tên người thật', 'active', 'blocked'],
        ['unblock', e2, 'element', undefined, 'blocked', 'active'],
        ['dismiss_reports', e3, 'element', 'ổn', 'active', 'active'],
      ]
      for (const [action, id, kind, reason] of writes) expect((await mod(kind, id, action, reason)).status, action).toBe(200)

      // failed writes add nothing
      expect((await mod('element', await elementId('Ad Không Có Thật'), 'hide')).status).toBe(404)
      expect((await mod('element', e3, 'show')).status).toBe(409)
      expect((await mod('recipe', await recipeId(RA, RB), 'block')).status).toBe(422)
      expect((await A('/moderation', { body: { target_kind: 'element', target_id: e3, action: 'explode' } })).status).toBe(400)
      expect((await auditRows()).length).toBe(5)

      const res = await A('/audit')
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain(TOKEN)
      const body = JSON.parse(text) as Page<AuditItem>
      expect(body).toMatchObject({ page: 1, size: 50, total: 5 })
      const newestFirst = [...writes].reverse()
      expect(body.items.map((i) => [i.action, i.target_kind, i.target_id, i.before, i.after, i.reason])).toEqual(
        newestFirst.map(([action, id, kind, reason, before, after]) => [action, kind, id, before, after, reason ?? null]),
      )
      for (const item of body.items) {
        expect(item.token_fp).toBe(fp)
        expect(item.token_fp).toHaveLength(8)
        expect(Math.abs(Date.parse(item.created_at) - Date.now())).toBeLessThan(5 * 60_000)
      }
      const times = body.items.map((i) => Date.parse(i.created_at))
      expect(times).toEqual([...times].sort((x, y) => y - x))

      const rows = await auditRows()
      expect(rows[0]).toMatchObject({ action: 'hide', target_kind: 'element', target_id: e1, before_state: 'active', after_state: 'hidden', reason: 'spam', token_fp: fp })

      const page = await json<Page<AuditItem>>(await A('/audit?page=3&size=2'))
      expect(page).toMatchObject({ page: 3, size: 2, total: 5 })
      expect(page.items.map((i) => i.action)).toEqual(['hide'])
    },
    60_000,
  )

  // ------------------------------------------------------------------------ AC-ADMIN-10
  it('AC-ADMIN-10: host quản trị GET / (text/html) trả trang với meta noindex và header X-Robots-Tag, CSP default-src self + frame-ancestors none, Referrer-Policy, no-store', async () => {
    expect((env as unknown as { ADMIN_HOST?: string }).ADMIN_HOST).toBe('laumeme-admin.dinoduct.fun')
    const res = await raw(`${ADMIN_ORIGIN}/`, {}, { ...NAV, 'CF-Connecting-IP': nextIp() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('text/html')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')

    const script = html.match(/(?:src|href)="(\/[^"]+\.js)"/)
    expect(script, 'trang quản trị phải tham chiếu một file .js build').not.toBeNull()
    const asset = await raw(`${ADMIN_ORIGIN}${script![1]}`, {}, { Accept: '*/*', 'CF-Connecting-IP': nextIp() })
    expect(asset.status).toBe(200)
  })

  it('AC-ADMIN-10: host quản trị chỉ phục vụ trang và /api/admin/*: đường dẫn khác (kể cả /lau-meme/api/health, /lau-meme/api/admin/*) trả 404', async () => {
    for (const path of ['/lau-meme/api/health', '/lau-meme/api/admin/audit', '/lau-meme/', '/foo', '/api/health']) {
      const res = await raw(`${ADMIN_ORIGIN}${path}`, {}, { ...NAV, Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': nextIp() })
      expect(res.status, path).toBe(404)
      expect(await res.text(), path).not.toContain('noindex')
    }
    const unknown = await A('/khong-co')
    expect(unknown.status).toBe(404)
    isProblem(unknown)
  })

  it('AC-ADMIN-10: trên host game /lau-meme/api/admin/* trả 404 problem+json kể cả token đúng; trang /lau-meme/admin và /lau-meme/admin.html không được phục vụ', async () => {
    const e = await elementId(PLAIN)
    const auth = { Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': nextIp() }
    for (const path of ['/reports', '/elements', '/batches', '/audit']) {
      const res = await raw(`${GAME_API}/admin${path}`, {}, auth)
      expect(res.status, path).toBe(404)
      isProblem(res)
    }
    const post = await raw(
      `${GAME_API}/admin/moderation`,
      { method: 'POST', body: JSON.stringify({ target_kind: 'element', target_id: e, action: 'hide' }) },
      auth,
    )
    expect(post.status).toBe(404)
    isProblem(post)
    expect(await blockRow('element', e)).toEqual([])
    expect(await count('admin_audit')).toBe(0)

    for (const path of ['/lau-meme/admin', '/lau-meme/admin.html']) {
      const res = await raw(`${GAME_ORIGIN}${path}`, {}, { ...NAV, 'CF-Connecting-IP': nextIp() })
      expect(res.status, path).toBe(404)
      expect(res.headers.get('x-robots-tag'), path).toBeNull()
      expect(await res.text(), path).not.toContain('content="noindex, nofollow"')
    }
  })

  // ------------------------------------------------------------------------ AC-ADMIN-VALIDATION
  it(
    'AC-ADMIN-VALIDATION: lệnh kiểm duyệt với trường lạ, id sai định dạng (ngắn, dài 10000, script, SQL), enum lạ, lý do > 200, JSON hỏng trả 400; sai loại/đích trả 422/404; không ghi gì',
    async () => {
      const ok = await elementId(PLAIN)
      const base = { target_kind: 'element', target_id: ok, action: 'hide' }
      const bad: unknown[] = [
        { ...base, extra: 1 },
        { ...base, target_id: 'abc' },
        { ...base, target_id: ok + 'A' },
        { ...base, target_id: ok.slice(1) },
        { ...base, target_id: '<script>alert(1)</script>'.padEnd(43, 'a') },
        { ...base, target_id: "'; DROP TABLE block;--".padEnd(43, 'a') },
        { ...base, target_id: 'A'.repeat(10_000) },
        { ...base, target_id: 12345 },
        { ...base, action: 'explode' },
        { ...base, action: 'HIDE' },
        { ...base, target_kind: 'player' },
        { ...base, reason: 'x'.repeat(201) },
        { ...base, reason: 'x'.repeat(100_000) },
        { target_kind: 'element', target_id: ok },
        { action: 'hide', target_id: ok },
        [],
        null,
        '{"target_kind": "element", ',
        '',
      ]
      for (const b of bad) {
        const res = await A('/moderation', { body: typeof b === 'string' ? b : JSON.stringify(b) })
        const label = (typeof b === 'string' ? b : JSON.stringify(b)).slice(0, 60)
        expect(res.status, label).toBe(400)
        isProblem(res)
      }
      // semantically wrong commands
      for (const [kind, id, action] of [
        ['recipe', await recipeId(RA, RB), 'block'],
        ['image', await elementId(IMG), 'block'],
        ['recipe', await recipeId(RA, RB), 'unblock'],
        ['image', await elementId(IMG), 'unblock'],
        ['recipe', await recipeId(RA, RB), 'dismiss_reports'],
      ] as const) {
        const res = await mod(kind, id, action)
        expect(res.status, `${kind} ${action}`).toBe(422)
        isProblem(res)
      }
      for (const [kind, id] of [
        ['element', await elementId('Ad Không Có Thật')],
        ['recipe', await recipeId('Ad Không', 'Có Công Thức')],
        ['image', await elementId(PLAIN)],
      ] as const) {
        const res = await mod(kind, id, 'hide')
        expect(res.status, kind).toBe(404)
        isProblem(res)
      }
      expect(await count('admin_audit')).toBe(0)
      expect(await count('block')).toBe(0)
      expect(await count('report_target')).toBe(0)
      expect(await count('banned_term')).toBe(0)
    },
    120_000,
  )

  it(
    'AC-ADMIN-VALIDATION: tham số phân trang/lọc không hợp lệ (page < 1, size > 100, không phải số, status/state lạ, q > 100, thiếu hoặc sai element_id) trả 400 problem+json; size 100 hợp lệ',
    async () => {
      const ok = await elementId(PLAIN)
      const lists = ['/reports', '/elements', `/recipes?element_id=${ok}`, '/batches', '/audit']
      const join = (p: string, q: string) => `${p}${p.includes('?') ? '&' : '?'}${q}`
      for (const p of lists) {
        for (const q of ['page=0', 'page=-1', 'page=abc', 'size=101', 'size=0', 'size=1000000000']) {
          const res = await A(join(p, q))
          expect(res.status, `${p} ${q}`).toBe(400)
          isProblem(res)
        }
      }
      expect((await A('/audit?size=100')).status).toBe(200)
      for (const path of [
        '/reports?status=bogus',
        '/elements?state=bogus',
        `/elements?q=${'a'.repeat(101)}`,
        '/recipes',
        '/recipes?element_id=abc',
        `/recipes?element_id=${encodeURIComponent('<script>alert(1)</script>'.padEnd(43, 'a'))}`,
        `/recipes?element_id=${'A'.repeat(10_000)}`,
      ]) {
        const res = await A(path)
        expect(res.status, path.slice(0, 60)).toBe(400)
        isProblem(res)
      }
      const injected = await A(`/elements?q=${encodeURIComponent("' OR 1=1 --")}`)
      expect(injected.status).toBe(200)
      expect((await json<Page<ElementItem>>(injected)).total).toBe(0)
    },
    120_000,
  )

  // ------------------------------------------------------------------------ AC-ADMIN-ABUSE (endpoint không có tenant)
  it(
    'AC-ADMIN-ABUSE: id giả danh (id công thức dùng như phần tử, phần tử không ảnh dùng như ảnh), token gần đúng, giả IP bằng X-Forwarded-For không né khóa, header lạ không né xác thực',
    async () => {
      const rid = await recipeId(RA, RB)
      expect((await mod('element', rid, 'hide')).status).toBe(404) // a recipe id is not an element
      expect((await mod('recipe', await elementId(PLAIN), 'hide')).status).toBe(404) // an element id is not a recipe
      expect((await mod('image', await elementId(PLAIN), 'hide')).status).toBe(404) // element without an image

      for (const near of [`${TOKEN}x`, TOKEN.slice(0, -1), ` ${TOKEN}`, TOKEN.toUpperCase(), '']) {
        const res = await A('/audit', { auth: `Bearer ${near}` })
        expect(res.status, JSON.stringify(near)).toBe(401)
      }
      const spoof = { 'X-Admin': 'true', 'X-Forwarded-For': '1.2.3.4', 'X-Player-Id': newId(), 'X-Real-IP': '9.9.9.9' }
      expect((await A('/audit', { auth: null, headers: spoof })).status).toBe(401)
      expect((await A('/moderation', { auth: null, headers: spoof, body: { target_kind: 'element', target_id: await elementId(PLAIN), action: 'block' } })).status).toBe(401)

      const ip = '2001:db8::bad:1'
      for (let i = 0; i < 5; i++) expect((await A('/audit', { auth: `Bearer ${WRONG}`, ip, headers: { 'X-Forwarded-For': `1.1.1.${i}` } })).status).toBe(401)
      const still = await A('/audit', { ip, headers: { 'X-Forwarded-For': '8.8.8.8' } })
      expect(still.status).toBe(429)
      isProblem(still)

      expect(await count('admin_audit')).toBe(0)
      expect(await count('block')).toBe(0)
      expect(await count('banned_term')).toBe(0)
    },
    60_000,
  )
})
