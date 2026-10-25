import { HttpError, ResponseError, json, problem, readJson } from '../../http'
import { elementId, fold } from '../../ids'
import { ANONYMOUS, playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { mustHave, peekSession, requireSession, sessionFrom, sessionStatement } from '../../session'
import { uuidv7 } from '../../uuid'
import { bad, choice, page, paging, sha256hex, totalOf } from '../admin/admin'
import { bannedKey } from '../disc/disc'
import { type ConsentRow, playConsentStatement, requirePlayConsent } from '../player/consent'

/**
 * Meme contributions (AC-CONTRIB-01..12, ADR 0013): a signed-in player proposes a new element made from an existing
 * pair; the admin edits, approves or rejects it. Approval only writes D1 - the pipeline reads approved rows from
 * /pipeline/state at the next batch. Never sent to an LLM before approval (open question 46).
 */
const SUBMIT_LIMIT: Limit = { scope: 'contrib', windowMs: 60_000, perPlayer: 10, perIp: 10 } // AC-PRIV-06
const PER_DAY = 5 // proposals per account per GMT+7 day, any status (AC-CONTRIB-05)
const TOP = 20
const MAX_NAME = 40
const MAX_DESCRIPTION = 200
const MAX_URL = 500
const MAX_HINT = 300
const MAX_REASON = 200
const PAIR_TAKEN = 'Cặp đã có công thức'
const NOT_OK = 'Nội dung không phù hợp'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000
const GMT7_MS = 7 * 3_600_000

const iso = (ms: number) => new Date(ms).toISOString()
const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[]
const conflict = (detail: string) => new HttpError(409, 'Xung đột', detail)
const notFound = () => new HttpError(404, 'Không tìm thấy đề xuất')

// ------------------------------------------------------------------------------------------------ rows

export type ContributionRow = {
  id: string
  a_id: string
  b_id: string
  a_name: string | null
  a_emoji: string | null
  b_name: string | null
  b_emoji: string | null
  name: string
  emoji: string | null
  description: string | null
  image_url: string | null
  status: 'pending' | 'approved' | 'rejected'
  reject_reason: string | null
  created_at: number
}
type AdminRow = ContributionRow & {
  image_hint: string | null
  tier: number | null
  element_id: string | null
  nickname: string | null
  decided_at: number | null
}

const starter = (id: string, name: string | null, emoji: string | null) => ({ id, name: name ?? '', emoji: emoji ?? '' })

/** A proposal as its author sees it (the admin-edited version when edited): no hint, tier or nickname. */
export function contribution(r: ContributionRow) {
  return {
    id: r.id,
    a: starter(r.a_id, r.a_name, r.a_emoji),
    b: starter(r.b_id, r.b_name, r.b_emoji),
    name: r.name,
    emoji: r.emoji,
    description: r.description,
    image_url: r.image_url,
    status: r.status,
    reject_reason: r.reject_reason,
    created_at: iso(r.created_at),
  }
}

/** The admin's view: adds the hint, tier, element id, the sender's nickname (never an account id) and decision time. */
function adminContribution(r: AdminRow) {
  return {
    ...contribution(r),
    image_hint: r.image_hint,
    tier: r.tier ?? 1,
    element_id: r.element_id,
    nickname: r.nickname ?? ANONYMOUS,
    decided_at: r.decided_at === null ? null : iso(r.decided_at),
  }
}

/** Every proposal of an account, newest first - for the data export (AC-CONTRIB-12). */
export function myContributionsStatement(db: D1Database, accountId: string): D1PreparedStatement {
  return db.prepare(`SELECT c.id, c.a_id, c.b_id, ea.name AS a_name, ea.emoji AS a_emoji, eb.name AS b_name, eb.emoji AS b_emoji,
         c.name, c.emoji, c.description, c.image_url, c.status, c.reject_reason, c.created_at
       FROM contribution c LEFT JOIN element ea ON ea.id = c.a_id LEFT JOIN element eb ON eb.id = c.b_id WHERE c.account_id = ? ORDER BY c.created_at DESC, c.id DESC`).bind(accountId)
}

// ------------------------------------------------------------------------------------------------ validation

type Fields = { name?: string; emoji?: string | null; description?: string | null; image_url?: string | null }

const graphemes = (text: string) => [...new Intl.Segmenter('vi', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u
// Marks an emoji sequence may carry: the text/emoji presentation selectors and the keycap; any other one would stack
// on the pictograph and still count as one grapheme (ZWJ, skin tones and tags are not marks).
const STRAY_MARK = /(?![\u{FE0E}\u{FE0F}\u{20E3}])\p{M}/u
const CONTROL = /[\p{Cc}\p{Cf}]/u

function name(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) bad(`name: chuỗi 1-${MAX_NAME} ký tự`)
  const trimmed = (value as string).trim()
  const length = [...trimmed].length
  if (length < 1 || length > MAX_NAME) bad(`name: chuỗi 1-${MAX_NAME} ký tự sau khi cắt khoảng trắng`)
  if (CONTROL.test(trimmed)) bad('name: không được chứa ký tự điều khiển')
  return trimmed
}

function emoji(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 16) bad('emoji: đúng 1 emoji')
  const parts = graphemes(value as string)
  if (parts.length !== 1 || !EMOJI.test(parts[0]!) || STRAY_MARK.test(parts[0]!)) bad('emoji: đúng 1 emoji')
  return value as string
}

function description(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 1000) bad(`description: tối đa ${MAX_DESCRIPTION} ký tự`)
  const trimmed = (value as string).trim()
  if ([...trimmed].length > MAX_DESCRIPTION) bad(`description: tối đa ${MAX_DESCRIPTION} ký tự`)
  return trimmed === '' ? null : trimmed
}

function imageUrl(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 1000) bad(`image_url: link https:// tối đa ${MAX_URL} ký tự`)
  const url = (value as string).trim()
  if (url === '') return null
  let ok = url.length <= MAX_URL && url.startsWith('https://')
  try {
    ok &&= new URL(url).protocol === 'https:'
  } catch {
    ok = false
  }
  if (!ok) bad(`image_url: link https:// tối đa ${MAX_URL} ký tự`)
  return url
}

/** The optional and editable fields present in `body`, checked the same way for the player and the admin. */
function fields(body: Record<string, unknown>): Fields {
  const out: Fields = {}
  if ('name' in body) out.name = name(body.name)
  if ('emoji' in body) out.emoji = emoji(body.emoji)
  if ('description' in body) out.description = description(body.description)
  if ('image_url' in body) out.image_url = imageUrl(body.image_url)
  return out
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) bad(`${k}: trường không được phép`)
}

function elementName(value: unknown, path: 'a' | 'b'): string {
  if (typeof value !== 'string' || value.length > 100 || value.trim() === '') bad(`${path}: tên phần tử 1-100 ký tự`)
  return value as string
}

function contributionId(raw: string | undefined): string {
  if (!UUID.test(raw ?? '')) bad('id: mã đề xuất không hợp lệ')
  return (raw as string).toLowerCase()
}

/** The name compared against existing elements and approved proposals: its fold, and its letters and digits only. */
function nameTaken(name: string, folds: string[]): boolean {
  const f = fold(name)
  const key = bannedKey(name)
  return folds.some((other) => other === f || (key !== '' && bannedKey(other) === key))
}

const nameFoldsStatements = (db: D1Database) => [
  db.prepare('SELECT name_fold FROM element'),
  db.prepare("SELECT name_fold FROM contribution WHERE status = 'approved'"),
]
const foldsOf = (...results: Array<D1Result | undefined>) => results.flatMap((r) => rows<{ name_fold: string }>(r).map((x) => x.name_fold))

/** The pair already makes something: a recipe in the catalog or an approved proposal. */
const pairTakenStatement = (db: D1Database, a: string, b: string) =>
  db.prepare(
    `SELECT EXISTS (SELECT 1 FROM recipe WHERE a_id = ?1 AND b_id = ?2)
         OR EXISTS (SELECT 1 FROM contribution WHERE a_id = ?1 AND b_id = ?2 AND status = 'approved') AS taken`,
  ).bind(a, b)

const bannedStatement = (db: D1Database) => db.prepare('SELECT DISTINCT term_fold FROM banned_term')

/** The banned-term filter on fold of each text; a match says nothing about which term matched (AC-CONTRIB-04). */
function assertClean(banned: D1Result | undefined, texts: Array<string | null | undefined>): void {
  const keys = texts.map((t) => bannedKey(t ?? ''))
  for (const { term_fold } of rows<{ term_fold: string }>(banned)) {
    const term = bannedKey(term_fold)
    if (term !== '' && keys.some((k) => k.includes(term))) throw new HttpError(422, NOT_OK)
  }
}

const isUnique = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message)

// ------------------------------------------------------------------------------------------------ player API

function secondsToNextMidnightGmt7(now: number): number {
  const day = Math.floor((now + GMT7_MS) / DAY_MS)
  return Math.max(1, Math.ceil(((day + 1) * DAY_MS - GMT7_MS - now) / 1000))
}
const startOfDayGmt7 = (now: number) => Math.floor((now + GMT7_MS) / DAY_MS) * DAY_MS - GMT7_MS

function dayFull(now: number): never {
  const retryAfter = String(secondsToNextMidnightGmt7(now))
  throw new ResponseError(problem(429, 'Đã đủ đề xuất hôm nay', `Mỗi ngày gửi tối đa ${PER_DAY} đề xuất.`, {}, { 'Retry-After': retryAfter }))
}

/**
 * POST /api/contributions - three D1 round trips: the IP counter + session renewal, then every read, then the insert
 * (the unique index makes a double submit a 409). The filter runs on fold of name and description; a match says
 * nothing about which term matched (AC-CONTRIB-04).
 */
export async function createContribution(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const db = env.DB

  // The IP counter runs before the session lookup, so forged or replayed cookies are throttled too; both run before
  // the body is read, so a signed-out client gets 401 whatever it sent (AC-CONTRIB-05).
  const byIp = await rateCounters(req, env, SUBMIT_LIMIT, '', 'ip')
  const lookup = await sessionStatement(req, env)
  const checked = await db.batch([...byIp.statements, ...(lookup ? [lookup.statement] : [])])
  const limited = byIp.verdict(checked)
  if (limited) return limited
  const account = mustHave(lookup && sessionFrom(lookup.token, checked[byIp.statements.length])).accountId

  if (!(req.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'Cần Content-Type application/json')
  const body = await readJson(req)
  onlyKeys(body, ['a', 'b', 'name', 'emoji', 'description', 'image_url'])
  const [a, b] = [elementName(body.a, 'a'), elementName(body.b, 'b')]
  if (!('name' in body)) bad('name: bắt buộc')
  const f = fields(body) as Required<Fields>

  const now = Date.now()
  const [aId, bId] = [await elementId(a), await elementId(b)]
  const [lo, hi] = [aId, bId].sort() as [string, string]
  const [consent, today, active, banned, elementFolds, approvedFolds, pair] = await db.batch([
    playConsentStatement(db, player),
    db.prepare('SELECT COUNT(*) AS n FROM contribution WHERE account_id = ? AND created_at >= ?').bind(account, startOfDayGmt7(now)),
    // active in the current version and not hidden/blocked
    db
      .prepare(
        `SELECT json_extract(e.value, '$[0]') AS id FROM json_each((SELECT server_json FROM batch_content
           WHERE version = CAST((SELECT value FROM app_meta WHERE key = 'current_version') AS INTEGER)), '$.elements') e
         WHERE json_extract(e.value, '$[0]') IN (?1, ?2)
           AND NOT EXISTS (SELECT 1 FROM block bl WHERE bl.kind = 'element' AND bl.target_id = json_extract(e.value, '$[0]'))`,
      )
      .bind(aId, bId),
    bannedStatement(db),
    ...nameFoldsStatements(db),
    pairTakenStatement(db, lo, hi),
  ])
  requirePlayConsent(env, consent?.results[0] as ConsentRow | undefined)
  if ((rows<{ n: number }>(today)[0]?.n ?? 0) >= PER_DAY) dayFull(now)
  assertClean(banned, [f.name, f.description])
  const found = new Set(rows<{ id: string }>(active).map((r) => r.id))
  if (!found.has(aId)) bad('a: không có phần tử đang hoạt động với tên này')
  if (!found.has(bId)) bad('b: không có phần tử đang hoạt động với tên này')
  if (rows<{ taken: number }>(pair)[0]?.taken) throw conflict(PAIR_TAKEN)
  if (nameTaken(f.name, foldsOf(elementFolds, approvedFolds))) throw conflict('Tên trùng với phần tử đã có')

  const id = uuidv7(now)
  let written: D1Result[]
  try {
    written = await db.batch([
      // The daily count is checked again inside the insert, so parallel submits cannot pass it together.
      db
        .prepare(
          `INSERT INTO contribution (id, account_id, a_id, b_id, name, name_fold, emoji, description, image_url, status,
             created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?10
           WHERE (SELECT COUNT(*) FROM contribution WHERE account_id = ?2 AND created_at >= ?11) < ?12`,
        )
        .bind(id, account, lo, hi, f.name, fold(f.name), f.emoji ?? null, f.description ?? null, f.image_url ?? null, now, startOfDayGmt7(now), PER_DAY),
      db.prepare(`SELECT c.id, c.a_id, c.b_id, ea.name AS a_name, ea.emoji AS a_emoji, eb.name AS b_name, eb.emoji AS b_emoji,
         c.name, c.emoji, c.description, c.image_url, c.status, c.reject_reason, c.created_at
       FROM contribution c LEFT JOIN element ea ON ea.id = c.a_id LEFT JOIN element eb ON eb.id = c.b_id WHERE c.id = ?`).bind(id),
    ])
  } catch (err) {
    if (isUnique(err)) throw conflict('Bạn đã có đề xuất chờ duyệt cho cặp này')
    throw err
  }
  const created = rows<ContributionRow>(written[1])[0]
  if (!created) dayFull(now)
  return json(contribution(created!), { status: 201 })
}

/** GET /api/contributions/{id} - another account's proposal is a 404 like a missing one (AC-CONTRIB-06, TENANT). */
export async function getContribution(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const session = await requireSession(req, env)
  const id = contributionId(params[0])
  const row = await env.DB.prepare(`SELECT c.id, c.a_id, c.b_id, ea.name AS a_name, ea.emoji AS a_emoji, eb.name AS b_name, eb.emoji AS b_emoji,
         c.name, c.emoji, c.description, c.image_url, c.status, c.reject_reason, c.created_at
       FROM contribution c LEFT JOIN element ea ON ea.id = c.a_id LEFT JOIN element eb ON eb.id = c.b_id WHERE c.id = ? AND c.account_id = ?`)
    .bind(id, session.accountId)
    .first<ContributionRow>()
  if (!row) throw notFound()
  return json(contribution(row))
}

/** GET /api/me/contributions - newest first. */
export async function listMyContributions(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env)
  const p = paging(new URL(req.url).searchParams)
  const db = env.DB
  const [items, total] = await db.batch([
    db
      .prepare(`SELECT c.id, c.a_id, c.b_id, ea.name AS a_name, ea.emoji AS a_emoji, eb.name AS b_name, eb.emoji AS b_emoji,
         c.name, c.emoji, c.description, c.image_url, c.status, c.reject_reason, c.created_at
       FROM contribution c LEFT JOIN element ea ON ea.id = c.a_id LEFT JOIN element eb ON eb.id = c.b_id WHERE c.account_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`)
      .bind(session.accountId, p.size, p.offset),
    db.prepare('SELECT COUNT(*) AS n FROM contribution WHERE account_id = ?').bind(session.accountId),
  ])
  return page(p, totalOf(total), rows<ContributionRow>(items).map(contribution))
}

/**
 * GET /api/contributors/leaderboard - approved proposals of existing accounts, most first; a tie goes to who reached
 * that count first (the decision time of their Nth approval). The session is only peeked (AC-CONTRIB-11).
 */
export async function getContributorLeaderboard(req: Request, env: Env): Promise<Response> {
  const session = await peekSession(req, env)
  const me = session?.accountId ?? ''
  const { results } = await env.DB.prepare(
    `WITH ranked AS (
       SELECT c.account_id, COUNT(*) AS approved,
              ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, MAX(c.decided_at), c.account_id) AS rank
       FROM contribution c JOIN account a ON a.id = c.account_id
       WHERE c.status = 'approved' GROUP BY c.account_id)
     SELECT r.rank, a.nickname, r.approved, r.account_id = ?1 AS mine
     FROM ranked r JOIN account a ON a.id = r.account_id
     WHERE r.rank <= ?2 OR r.account_id = ?1 ORDER BY r.rank`,
  )
    .bind(me, TOP)
    .all<{ rank: number; nickname: string | null; approved: number; mine: number }>()
  const row = (r: (typeof results)[number]) => ({ rank: r.rank, nickname: r.nickname ?? ANONYMOUS, approved: r.approved })
  const mine = results.find((r) => r.mine)
  return json({ rows: results.filter((r) => r.rank <= TOP).map(row), me: mine ? row(mine) : null })
}

/** GET /api/creators/{version} - the snapshot written when the batch was published (ADR 0013, AC-CONTRIB-10). */
export async function getCreators(_req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  if (!/^[1-9]\d{0,14}$/.test(params[0] ?? '')) throw new HttpError(400, 'Version không hợp lệ')
  const row = await env.DB.prepare('SELECT creators_json FROM batch_content WHERE version = ?')
    .bind(Number(params[0]))
    .first<{ creators_json: string | null }>()
  if (!row) throw new HttpError(404, 'Không có mẻ này')
  return new Response(row.creators_json ?? '{}', {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  })
}

// ------------------------------------------------------------------------------------------------ admin API

async function loadAdminRow(db: D1Database, id: string): Promise<AdminRow> {
  const row = await db.prepare(`SELECT c.id, c.a_id, c.b_id, ea.name AS a_name, ea.emoji AS a_emoji, eb.name AS b_name, eb.emoji AS b_emoji,
         c.name, c.emoji, c.description, c.image_url, c.status, c.reject_reason, c.created_at, c.image_hint, c.element_id, c.decided_at, acc.nickname, t.tier
       FROM contribution c LEFT JOIN element ea ON ea.id = c.a_id LEFT JOIN element eb ON eb.id = c.b_id
       LEFT JOIN account acc ON acc.id = c.account_id LEFT JOIN element_tier t ON t.element_id = c.element_id WHERE c.id = ?`).bind(id).first<AdminRow>()
  if (!row) throw notFound()
  return row
}

/**
 * One audit row, written only while the proposal is still pending - it goes right before its guarded UPDATE in the same
 * batch, so a decision that lost a race leaves no audit row (AC-ADMIN-09).
 */
const changeStatement = (
  db: D1Database,
  action: 'edit_contribution' | 'approve_contribution' | 'reject_contribution',
  id: string,
  before: unknown,
  after: unknown,
  reason: string | null,
  fp: string,
  now: number,
) =>
  db
    .prepare(
      `INSERT INTO admin_change (id, action, target_kind, target_id, before_json, after_json, reason, token_fp, created_at)
       SELECT ?1, ?2, 'contribution', ?3, ?4, ?5, ?6, ?7, ?8
       WHERE EXISTS (SELECT 1 FROM contribution WHERE id = ?3 AND status = 'pending')`,
    )
    .bind(uuidv7(now), action, id, JSON.stringify(before), JSON.stringify(after), reason, fp, now)

/** The guarded UPDATE of a batch changed nothing: another decision got there first. */
function assertChanged(result: D1Result | undefined): void {
  if (!result?.meta.changes) throw conflict('Đề xuất không còn chờ duyệt')
}

const tokenFp = async (env: Env) => (await sha256hex(env.ADMIN_TOKEN ?? '')).slice(0, 8)

/** GET /api/admin/contributions - oldest first, filtered by status (AC-CONTRIB-07). */
export async function adminListContributions(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams
  const p = paging(params)
  const status = choice(params, 'status', ['pending', 'approved', 'rejected'] as const)
  const db = env.DB
  const [items, total] = await db.batch([
    db
      .prepare(`SELECT c.id, c.a_id, c.b_id, ea.name AS a_name, ea.emoji AS a_emoji, eb.name AS b_name, eb.emoji AS b_emoji,
         c.name, c.emoji, c.description, c.image_url, c.status, c.reject_reason, c.created_at, c.image_hint, c.element_id, c.decided_at, acc.nickname, t.tier
       FROM contribution c LEFT JOIN element ea ON ea.id = c.a_id LEFT JOIN element eb ON eb.id = c.b_id
       LEFT JOIN account acc ON acc.id = c.account_id LEFT JOIN element_tier t ON t.element_id = c.element_id WHERE ?1 IS NULL OR c.status = ?1 ORDER BY c.created_at, c.id LIMIT ?2 OFFSET ?3`)
      .bind(status, p.size, p.offset),
    db.prepare('SELECT COUNT(*) AS n FROM contribution WHERE ?1 IS NULL OR status = ?1').bind(status),
  ])
  return page(p, totalOf(total), rows<AdminRow>(items).map(adminContribution))
}

/**
 * PATCH /api/admin/contributions/{id} - pending only; same checks as a submission except the banned-term filter
 * (the admin answers for it; the pipeline keeps a matching name out of the graph); `null` clears an optional field; one
 * audit row with the changed fields.
 */
export async function adminEditContribution(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = contributionId(params[0])
  const body = await readJson(req)
  onlyKeys(body, ['name', 'emoji', 'description', 'image_url'])
  if (Object.keys(body).length === 0) bad('body: cần ít nhất một trường')
  const f = fields(body)
  const db = env.DB
  const [found, elementFolds, approvedFolds] = await db.batch([
    db.prepare(`SELECT c.id, c.a_id, c.b_id, ea.name AS a_name, ea.emoji AS a_emoji, eb.name AS b_name, eb.emoji AS b_emoji,
         c.name, c.emoji, c.description, c.image_url, c.status, c.reject_reason, c.created_at, c.image_hint, c.element_id, c.decided_at, acc.nickname, t.tier
       FROM contribution c LEFT JOIN element ea ON ea.id = c.a_id LEFT JOIN element eb ON eb.id = c.b_id
       LEFT JOIN account acc ON acc.id = c.account_id LEFT JOIN element_tier t ON t.element_id = c.element_id WHERE c.id = ?`).bind(id),
    ...nameFoldsStatements(db),
  ])
  const row = rows<AdminRow>(found)[0]
  if (!row) throw notFound()
  if (row.status !== 'pending') throw conflict('Chỉ sửa được đề xuất chờ duyệt')
  if (f.name !== undefined && nameTaken(f.name, foldsOf(elementFolds, approvedFolds))) throw conflict('Tên trùng với phần tử đã có')

  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(f) as Array<[keyof Fields, string | null]>) {
    if (row[k] === v) continue
    before[k] = row[k]
    after[k] = v
  }
  if (Object.keys(after).length === 0) return json(adminContribution(row))
  const next = { ...row, ...f }
  const now = Date.now()
  const written = await db.batch([
    changeStatement(db, 'edit_contribution', id, before, after, null, await tokenFp(env), now),
    db
      .prepare(
        `UPDATE contribution SET name = ?, name_fold = ?, emoji = ?, description = ?, image_url = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(next.name, fold(next.name), next.emoji, next.description, next.image_url, now, id),
  ])
  assertChanged(written[1])
  return json(adminContribution(await loadAdminRow(db, id)))
}

/**
 * POST /api/admin/contributions/{id}/approve - one D1 batch (ADR 0013): the proposal becomes the element of
 * ElementId(fold(name)), a tier other than 1 gets its row, other pending proposals of the pair are rejected, and
 * each change gets its audit row. The graph being served is not touched.
 */
export async function adminApproveContribution(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = contributionId(params[0])
  const body = await readJson(req)
  onlyKeys(body, ['image_hint', 'tier'])
  const hint = body.image_hint
  if (typeof hint !== 'string' || hint.trim() === '' || [...hint].length > MAX_HINT) bad(`image_hint: chuỗi 1-${MAX_HINT} ký tự`)
  const tier = body.tier ?? 1
  if (typeof tier !== 'number' || !Number.isInteger(tier) || tier < 1 || tier > 5) bad('tier: số nguyên 1-5')
  const db = env.DB
  const row = await loadAdminRow(db, id)
  if (row.status !== 'pending') throw conflict('Đề xuất không còn chờ duyệt')
  const [pair, elementFolds, approvedFolds, others] = await db.batch([
    pairTakenStatement(db, row.a_id, row.b_id),
    ...nameFoldsStatements(db),
    db
      .prepare("SELECT id FROM contribution WHERE a_id = ? AND b_id = ? AND status = 'pending' AND id <> ? ORDER BY created_at, id")
      .bind(row.a_id, row.b_id, id),
  ])
  if (rows<{ taken: number }>(pair)[0]?.taken) throw conflict(PAIR_TAKEN)
  if (nameTaken(row.name, foldsOf(elementFolds, approvedFolds))) throw conflict('Tên trùng với phần tử đã có')
  const imageHint = (hint as string).trim()

  const now = Date.now()
  const fp = await tokenFp(env)
  const element = await elementId(row.name)
  const writes = [
    changeStatement(db, 'approve_contribution', id, { status: 'pending' }, { status: 'approved', element_id: element, tier, image_hint: imageHint }, null, fp, now),
    db
      .prepare(
        `UPDATE contribution SET status = 'approved', element_id = ?, image_hint = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(element, imageHint, now, now, id),
  ]
  if (tier !== 1)
    writes.push(
      db
        .prepare(
          `INSERT INTO element_tier (element_id, tier, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (element_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
        )
        .bind(element, tier, now),
    )
  for (const { id: other } of rows<{ id: string }>(others))
    writes.push(
      changeStatement(db, 'reject_contribution', other, { status: 'pending' }, { status: 'rejected', reject_reason: PAIR_TAKEN }, PAIR_TAKEN, fp, now),
      db
        .prepare(
          `UPDATE contribution SET status = 'rejected', reject_reason = ?, decided_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(PAIR_TAKEN, now, now, other),
    )
  let written: D1Result[]
  try {
    written = await db.batch(writes)
  } catch (err) {
    if (isUnique(err)) throw conflict('Cặp hoặc tên đã có đề xuất được duyệt')
    throw err
  }
  assertChanged(written[1])
  return json(adminContribution(await loadAdminRow(db, id)))
}

/** POST /api/admin/contributions/{id}/reject - a reason of 1-200 characters, pending only. */
export async function adminRejectContribution(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = contributionId(params[0])
  const body = await readJson(req)
  onlyKeys(body, ['reason'])
  const raw = body.reason
  const reason = typeof raw === 'string' ? raw.trim() : ''
  if (reason === '' || [...reason].length > MAX_REASON) bad(`reason: chuỗi 1-${MAX_REASON} ký tự`)
  const db = env.DB
  const row = await loadAdminRow(db, id)
  if (row.status !== 'pending') throw conflict('Đề xuất không còn chờ duyệt')
  const now = Date.now()
  const written = await db.batch([
    changeStatement(db, 'reject_contribution', id, { status: 'pending' }, { status: 'rejected', reject_reason: reason }, reason, await tokenFp(env), now),
    db
      .prepare(
        `UPDATE contribution SET status = 'rejected', reject_reason = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(reason, now, now, id),
  ])
  assertChanged(written[1])
  return json(adminContribution(await loadAdminRow(db, id)))
}

