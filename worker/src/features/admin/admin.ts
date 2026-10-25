import { hasBearer } from '../../auth'
import { HttpError, json, problem, readJson } from '../../http'
import { fold } from '../../ids'
import { ipHash } from '../../ratelimit'
import { uuidv7 } from '../../uuid'
import { ID43 } from '../../validate'

/**
 * Trang quản trị tối giản (AC-ADMIN-01..09). Served only on env.ADMIN_HOST (ADR 0008); index.ts routes by host.
 * "Ẩn" = block row state 'hidden' (reversible), "Chặn" = state 'blocked' + the element's fold in banned_term.
 */
type Handler = (req: Request, env: Env, ctx: ExecutionContext, params: string[]) => Promise<Response>

const LOCK_AFTER = 5 // failed tokens per IP hash…
const FAIL_WINDOW_MS = 60_000 // …within one minute…
const LOCK_MS = 15 * 60_000 // …lock that IP hash for 15 minutes, right token included (AC-ADMIN-02)

const enc = new TextEncoder()

export async function sha256hex(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const bad = (detail: string): never => {
  throw new HttpError(400, 'Dữ liệu không hợp lệ', detail)
}

/**
 * Bearer ADMIN_TOKEN in constant time, behind a per-IP-hash lockout. Buckets live in rate_counter (purged by the
 * daily cron): `admin-fail:i:<hash>` counts failures in a window opened by the first one, `admin-lock:i:<hash>`
 * holds the lock. The token is never logged or stored; audit rows keep only its fingerprint.
 */
export function adminOnly(handler: Handler): Handler {
  return async (req, env, ctx, params) => {
    const db = env.DB
    const now = Date.now()
    const ip = await ipHash(req, env)
    const who = (await sha256hex(ip ?? 'no-ip')).slice(0, 16) // requests without CF-Connecting-IP share one bucket
    const failBucket = `admin-fail:i:${who}`
    const lockBucket = `admin-lock:i:${who}`
    const [lock, ok] = await Promise.all([
      db.prepare('SELECT expires_at FROM rate_counter WHERE bucket = ? AND expires_at > ?').bind(lockBucket, now).first<{ expires_at: number }>(),
      hasBearer(req, env.ADMIN_TOKEN),
    ])
    if (lock) {
      const retryAfter = Math.max(1, Math.ceil((lock.expires_at - now) / 1000))
      return problem(429, 'Thử sai quá nhiều lần', `Thử lại sau ${retryAfter} giây.`, {}, { 'Retry-After': String(retryAfter) })
    }
    if (ok) return handler(req, env, ctx, params)
    await db.batch([
      db
        .prepare(
          `INSERT INTO rate_counter (bucket, count, expires_at) VALUES (?1, 1, ?2)
           ON CONFLICT (bucket) DO UPDATE SET
             count = CASE WHEN expires_at <= ?3 THEN 1 ELSE count + 1 END,
             expires_at = CASE WHEN expires_at <= ?3 THEN ?2 ELSE expires_at END`,
        )
        .bind(failBucket, now + FAIL_WINDOW_MS, now),
      db
        .prepare(
          `INSERT INTO rate_counter (bucket, count, expires_at)
           SELECT ?1, 1, ?2 WHERE (SELECT count FROM rate_counter WHERE bucket = ?3 AND expires_at > ?4) >= ?5
           ON CONFLICT (bucket) DO UPDATE SET count = 1, expires_at = excluded.expires_at`,
        )
        .bind(lockBucket, now + LOCK_MS, failBucket, now, LOCK_AFTER),
    ])
    return problem(401, 'Thiếu hoặc sai token')
  }
}

// ------------------------------------------------------------------------------------------------ query params

export type Paging = { page: number; size: number; offset: number }

export function paging(params: URLSearchParams): Paging {
  const num = (name: string, fallback: number, max: number): number => {
    const raw = params.get(name)
    if (raw === null) return fallback
    const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN
    if (!(n >= 1 && n <= max)) bad(`${name}: số nguyên 1–${max}`)
    return n
  }
  const page = num('page', 1, 1_000_000)
  const size = num('size', 50, 100)
  return { page, size, offset: (page - 1) * size }
}

export function choice<T extends string>(params: URLSearchParams, name: string, options: readonly T[]): T | null {
  const raw = params.get(name)
  if (raw === null) return null
  if (!options.includes(raw as T)) bad(`${name}: phải là một trong ${options.join(', ')}`)
  return raw as T
}

export const page = (p: Paging, total: number, items: unknown[]) => json({ page: p.page, size: p.size, total, items })
const iso = (ms: number) => new Date(ms).toISOString()
export const totalOf = (r: D1Result | undefined) => (r?.results[0] as { n: number } | undefined)?.n ?? 0

// ------------------------------------------------------------------------------------------------ lists

/** GET /api/admin/reports - reports grouped per target, most distinct reporters first, no reporter ids (AC-ADMIN-06). */
export async function listReports(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams
  const p = paging(params)
  const open = (choice(params, 'status', ['new', 'resolved'] as const) ?? 'new') === 'new' ? 1 : 0
  const db = env.DB
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT r.kind, r.target_id, e.name, e.emoji,
                COUNT(DISTINCT COALESCE(r.player_id, r.id)) AS reporters, MAX(r.created_at) AS last_at,
                (SELECT b.state FROM block b WHERE b.kind = r.kind AND b.target_id = r.target_id) AS state,
                (SELECT json_group_object(x.reason, x.n) FROM (
                   SELECT r2.reason, COUNT(*) AS n FROM report r2
                   WHERE r2.kind = r.kind AND r2.target_id = r.target_id AND (r2.status = 'new') = ?1
                   GROUP BY r2.reason) x) AS reasons
         FROM report r JOIN element e ON e.id = r.target_id
         WHERE (r.status = 'new') = ?1
         GROUP BY r.kind, r.target_id
         ORDER BY reporters DESC, last_at DESC, r.kind, r.target_id
         LIMIT ?2 OFFSET ?3`,
      )
      .bind(open, p.size, p.offset),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM report r JOIN element e ON e.id = r.target_id
         WHERE (r.status = 'new') = ?1 GROUP BY r.kind, r.target_id)`,
      )
      .bind(open),
  ])
  type Row = { kind: string; target_id: string; name: string; emoji: string; reporters: number; last_at: number; state: string | null; reasons: string }
  const items = ((rows?.results ?? []) as Row[]).map((r) => ({
    target: r.kind,
    id: r.target_id,
    name: r.name,
    emoji: r.emoji,
    reporters: r.reporters,
    reasons: JSON.parse(r.reasons) as Record<string, number>,
    last_reported_at: iso(r.last_at),
    state: r.state ?? 'active',
  }))
  return page(p, totalOf(total), items)
}

/** GET /api/admin/elements - catalog, accent-insensitive search on the folded name, state filter. */
export async function listElements(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams
  const p = paging(params)
  const q = params.get('q') ?? ''
  if (q.length > 100) bad('q: tối đa 100 ký tự')
  const state = choice(params, 'state', ['active', 'hidden', 'blocked'] as const) ?? ''
  const tier = Number(choice(params, 'tier', ['1', '2', '3', '4', '5'] as const) ?? 0)
  const db = env.DB
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT e.id, e.name, e.emoji, e.depth, e.image_key, e.last_version, COALESCE(be.state, 'active') AS state,
                CASE WHEN e.image_key IS NULL THEN 'none' WHEN bi.target_id IS NULL THEN 'active' ELSE 'hidden' END AS image_state,
                COALESCE(t.tier, e.auto_tier, 1) AS tier, CASE WHEN t.tier IS NULL THEN 'auto' ELSE 'admin' END AS tier_source,
                e.auto_tier, e.image_source
         FROM element e
         LEFT JOIN block be ON be.kind = 'element' AND be.target_id = e.id
         LEFT JOIN block bi ON bi.kind = 'image' AND bi.target_id = e.id
         LEFT JOIN element_tier t ON t.element_id = e.id
         WHERE (?1 = '' OR instr(e.name_fold, ?1) > 0) AND (?2 = '' OR COALESCE(be.state, 'active') = ?2)
           AND (?5 = 0 OR COALESCE(t.tier, e.auto_tier, 1) = ?5)
         ORDER BY e.name_fold, e.id LIMIT ?3 OFFSET ?4`,
      )
      .bind(fold(q), state, p.size, p.offset, tier),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM element e
         LEFT JOIN block be ON be.kind = 'element' AND be.target_id = e.id
         LEFT JOIN element_tier t ON t.element_id = e.id
         WHERE (?1 = '' OR instr(e.name_fold, ?1) > 0) AND (?2 = '' OR COALESCE(be.state, 'active') = ?2)
           AND (?3 = 0 OR COALESCE(t.tier, e.auto_tier, 1) = ?3)`,
      )
      .bind(fold(q), state, tier),
  ])
  type Row = {
    id: string
    name: string
    emoji: string
    depth: number
    image_key: string | null
    last_version: number
    state: string
    image_state: string
    tier: number
    tier_source: 'auto' | 'admin'
    auto_tier: number | null
    image_source: 'ai' | 'admin' | null
  }
  const items = ((rows?.results ?? []) as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    depth: r.depth,
    state: r.state,
    image_key: r.image_key,
    image_state: r.image_state,
    last_version: r.last_version,
    tier: r.tier,
    tier_source: r.tier_source,
    auto_tier: r.auto_tier,
    image_source: r.image_source,
  }))
  return page(p, totalOf(total), items)
}

/** GET /api/admin/recipes?element_id= - recipes with the element as an input or the result. */
export async function listRecipes(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams
  const p = paging(params)
  const id = params.get('element_id')
  if (id === null || !ID43.test(id)) bad('element_id: id phần tử không hợp lệ')
  const db = env.DB
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT r.id, r.a_id, ea.name AS a_name, ea.emoji AS a_emoji, r.b_id, eb.name AS b_name, eb.emoji AS b_emoji,
                r.result_id, ec.name AS c_name, ec.emoji AS c_emoji,
                CASE WHEN bl.target_id IS NULL THEN 'active' ELSE 'hidden' END AS state
         FROM recipe r
         JOIN element ea ON ea.id = r.a_id JOIN element eb ON eb.id = r.b_id JOIN element ec ON ec.id = r.result_id
         LEFT JOIN block bl ON bl.kind = 'recipe' AND bl.target_id = r.id
         WHERE r.a_id = ?1 OR r.b_id = ?1 OR r.result_id = ?1
         ORDER BY r.id LIMIT ?2 OFFSET ?3`,
      )
      .bind(id, p.size, p.offset),
    db.prepare('SELECT COUNT(*) AS n FROM recipe r WHERE r.a_id = ?1 OR r.b_id = ?1 OR r.result_id = ?1').bind(id),
  ])
  type Row = Record<'id' | 'a_id' | 'a_name' | 'a_emoji' | 'b_id' | 'b_name' | 'b_emoji' | 'result_id' | 'c_name' | 'c_emoji' | 'state', string>
  const items = ((rows?.results ?? []) as Row[]).map((r) => ({
    id: r.id,
    a: { id: r.a_id, name: r.a_name, emoji: r.a_emoji },
    b: { id: r.b_id, name: r.b_name, emoji: r.b_emoji },
    result: { id: r.result_id, name: r.c_name, emoji: r.c_emoji },
    state: r.state,
  }))
  return page(p, totalOf(total), items)
}

/** GET /api/admin/batches - batch log, newest first (AC-ADMIN-08), plus the crawl summary of every batch (AC-ADMIN-11). */
export async function listBatches(req: Request, env: Env): Promise<Response> {
  const p = paging(new URL(req.url).searchParams)
  const db = env.DB
  const [rows, total, totals, latest] = await db.batch([
    db
      .prepare(
        `SELECT id, version, batch_at, mode, status, failed_step, rollback_to, stats_json, issue_url, created_at
         FROM batch_run ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(p.size, p.offset),
    db.prepare('SELECT COUNT(*) AS n FROM batch_run'),
    // successful full batches only: a failed or rolled back batch added nothing
    db.prepare(
      `SELECT COALESCE(SUM(json_extract(stats_json, '$.crawled')), 0) AS crawled_total,
              COALESCE(SUM(json_extract(stats_json, '$.added')), 0) AS added_total
       FROM batch_run WHERE mode = 'full' AND status = 'success'`,
    ),
    db.prepare(
      `SELECT json_extract(stats_json, '$.queue_size') AS queue_size, json_extract(stats_json, '$.without_image') AS without_image
       FROM batch_run WHERE mode = 'full' AND status = 'success' ORDER BY created_at DESC, id DESC LIMIT 1`,
    ),
  ])
  const sums = totals?.results[0] as { crawled_total: number; added_total: number } | undefined
  const last = latest?.results[0] as { queue_size: number | null; without_image: number | null } | undefined
  const summary = {
    crawled_total: sums?.crawled_total ?? 0,
    added_total: sums?.added_total ?? 0,
    queue_size: last?.queue_size ?? null,
    without_image: last?.without_image ?? null,
  }
  type Row = {
    id: string
    version: number | null
    batch_at: number
    mode: string
    status: string
    failed_step: string | null
    rollback_to: number | null
    stats_json: string
    issue_url: string | null
    created_at: number
  }
  const items = ((rows?.results ?? []) as Row[]).map((r) => ({
    id: r.id,
    version: r.version,
    batch_at: iso(r.batch_at),
    mode: r.mode,
    status: r.status,
    failed_step: r.failed_step,
    rollback_to: r.rollback_to,
    stats: JSON.parse(r.stats_json) as unknown,
    issue_url: r.issue_url,
    created_at: iso(r.created_at),
  }))
  return json({ page: p.page, size: p.size, total: totalOf(total), items, summary })
}

/** GET /api/admin/audit - newest first (AC-ADMIN-09). */
export async function listAudit(req: Request, env: Env): Promise<Response> {
  const p = paging(new URL(req.url).searchParams)
  const db = env.DB
  // admin_audit (moderation states), admin_change (tier, contributions; ADR 0013) and admin_image_change (drawings;
  // ADR 0016) read as one log
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT id, action, target_kind, target_id, before_state, after_state, 0 AS structured, reason, token_fp, created_at
         FROM admin_audit
         UNION ALL
         SELECT id, action, target_kind, target_id, before_json, after_json, 1, reason, token_fp, created_at
         FROM admin_change
         UNION ALL
         SELECT id, 'set_image', 'element', element_id, json_object('image_key', before_key), json_object('image_key', after_key),
                1, NULL, token_fp, created_at
         FROM admin_image_change
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(p.size, p.offset),
    db.prepare(
      'SELECT (SELECT COUNT(*) FROM admin_audit) + (SELECT COUNT(*) FROM admin_change) + (SELECT COUNT(*) FROM admin_image_change) AS n',
    ),
  ])
  type Row = {
    action: string
    target_kind: string
    target_id: string
    before_state: string
    after_state: string
    structured: number
    reason: string | null
    token_fp: string
    created_at: number
  }
  const state = (r: Row, text: string): unknown => (r.structured ? JSON.parse(text) : text)
  const items = ((rows?.results ?? []) as Row[]).map((r) => ({
    action: r.action,
    target_kind: r.target_kind,
    target_id: r.target_id,
    before: state(r, r.before_state),
    after: state(r, r.after_state),
    reason: r.reason,
    token_fp: r.token_fp,
    created_at: iso(r.created_at),
  }))
  return page(p, totalOf(total), items)
}

// ------------------------------------------------------------------------------------------------ moderation

const KINDS = ['element', 'recipe', 'image'] as const
const ACTIONS = ['hide', 'show', 'block', 'unblock', 'dismiss_reports'] as const
type Kind = (typeof KINDS)[number]
type Action = (typeof ACTIONS)[number]
type State = 'active' | 'hidden' | 'blocked'

function parseModeration(body: Record<string, unknown>) {
  for (const k of Object.keys(body)) if (!['target_kind', 'target_id', 'action', 'reason'].includes(k)) bad(`${k}: trường không được phép`)
  const { target_kind: kind, target_id: id, action, reason } = body
  if (typeof kind !== 'string' || !KINDS.includes(kind as Kind)) bad(`target_kind: phải là một trong ${KINDS.join(', ')}`)
  if (typeof id !== 'string' || !ID43.test(id)) bad('target_id: id không hợp lệ')
  if (typeof action !== 'string' || !ACTIONS.includes(action as Action)) bad(`action: phải là một trong ${ACTIONS.join(', ')}`)
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) bad('reason: chuỗi tối đa 200 ký tự')
  return { kind: kind as Kind, id: id as string, action: action as Action, reason: (reason as string | undefined) ?? null }
}

const conflict = (before: State, action: Action) =>
  new HttpError(409, 'Xung đột trạng thái', `Không thể ${action} khi đích đang ở trạng thái ${before}.`)

/**
 * POST /api/admin/moderation - reads target + block row in one round trip, then the state change and its single
 * audit row in one transactional batch; a 4xx never reaches the batch, so it writes no audit (AC-ADMIN-09).
 */
export async function moderate(req: Request, env: Env): Promise<Response> {
  const { kind, id, action, reason } = parseModeration(await readJson(req))
  if ((action === 'block' || action === 'unblock') && kind !== 'element') throw new HttpError(422, 'Dữ liệu không hợp lệ', `${action}: chỉ áp dụng cho phần tử`)
  if (action === 'dismiss_reports' && kind === 'recipe') throw new HttpError(422, 'Dữ liệu không hợp lệ', 'dismiss_reports: công thức không có báo cáo')

  const db = env.DB
  const target = {
    recipe: () => db.prepare('SELECT NULL AS name_fold FROM recipe WHERE id = ?').bind(id),
    element: () => db.prepare('SELECT name_fold FROM element WHERE id = ?').bind(id),
    image: () => db.prepare('SELECT name_fold FROM element WHERE id = ? AND image_key IS NOT NULL').bind(id),
  }[kind]()
  const [found, current] = await db.batch([target, db.prepare('SELECT state, reason FROM block WHERE kind = ? AND target_id = ?').bind(kind, id)])
  const row = found?.results[0] as { name_fold: string | null } | undefined
  if (!row) return problem(404, 'Không tìm thấy đích')
  const blockRow = current?.results[0] as { state: 'hidden' | 'blocked'; reason: string } | undefined
  const before: State = blockRow?.state ?? 'active'

  const now = Date.now()
  const resolve = (status: string) =>
    db
      .prepare("UPDATE report SET status = ?, resolved_at = ? WHERE kind = ? AND target_id = ? AND status = 'new'")
      .bind(status, now, kind, id)
  // a new counting cycle: reports made before this command no longer count toward the automatic hide
  const newCycle = () =>
    db
      .prepare('INSERT INTO report_target (kind, target_id, cycle) VALUES (?, ?, 1) ON CONFLICT (kind, target_id) DO UPDATE SET cycle = cycle + 1')
      .bind(kind, id)
  const unblockRow = () => db.prepare('DELETE FROM block WHERE kind = ? AND target_id = ?').bind(kind, id)
  const hasReports = kind !== 'recipe'

  let after: State
  const writes: D1PreparedStatement[] = []
  switch (action) {
    case 'hide':
      if (before !== 'active') throw conflict(before, action)
      after = 'hidden'
      writes.push(db.prepare("INSERT INTO block (kind, target_id, state, reason, created_at) VALUES (?, ?, 'hidden', 'admin', ?)").bind(kind, id, now))
      if (hasReports) writes.push(resolve('resolved_hidden'))
      break
    case 'show':
      if (before !== 'hidden') throw conflict(before, action) // a blocked element needs an explicit unblock (AC-ADMIN-05)
      after = 'active'
      writes.push(unblockRow())
      if (hasReports) writes.push(resolve('resolved_shown'), newCycle())
      break
    case 'block':
      if (before === 'blocked') throw conflict(before, action)
      after = 'blocked'
      writes.push(
        db
          .prepare(
            `INSERT INTO block (kind, target_id, state, reason, created_at) VALUES ('element', ?, 'blocked', 'admin', ?)
             ON CONFLICT (kind, target_id) DO UPDATE SET state = 'blocked', reason = 'admin', created_at = excluded.created_at`,
          )
          .bind(id, now),
        // the folded name joins the alias list: pipeline never recreates it (AC-MOD-10), nicknames reject it (AC-DISC-03)
        db.prepare("INSERT OR IGNORE INTO banned_term (term_fold, source, created_at) VALUES (?, 'admin', ?)").bind(row.name_fold, now),
        resolve('resolved_hidden'),
      )
      break
    case 'unblock':
      if (before !== 'blocked') throw conflict(before, action)
      after = 'active'
      writes.push(
        unblockRow(),
        db.prepare("DELETE FROM banned_term WHERE term_fold = ? AND source = 'admin'").bind(row.name_fold),
        resolve('resolved_shown'),
        newCycle(),
      )
      break
    case 'dismiss_reports': {
      // only an automatic hide comes off; an admin hide or a block stays as it is
      const autoHidden = blockRow?.state === 'hidden' && blockRow.reason === 'auto_report'
      after = autoHidden ? 'active' : before
      if (autoHidden) writes.push(unblockRow())
      writes.push(resolve('resolved_dismissed'), newCycle())
      break
    }
  }
  const fp = (await sha256hex(env.ADMIN_TOKEN ?? '')).slice(0, 8)
  writes.push(
    db
      .prepare(
        `INSERT INTO admin_audit (id, action, target_kind, target_id, before_state, after_state, reason, token_fp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(uuidv7(now), action, kind, id, before, after, reason, fp, now),
  )
  await db.batch(writes)
  return json({ target_kind: kind, target_id: id, before, after })
}

// ------------------------------------------------------------------------------------------------ tier

/**
 * PUT /api/admin/elements/{id}/tier - AC-ADMIN-12: the element must be in the catalog; the tier row and its single
 * admin_change row go in one batch. The graph shows it from the next batch (open question 53, ADR 0013).
 */
export async function setElementTier(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = params[0] ?? ''
  if (!ID43.test(id)) bad('id: id phần tử không hợp lệ')
  const body = await readJson(req)
  for (const k of Object.keys(body)) if (k !== 'tier') bad(`${k}: trường không được phép`)
  const tier = body.tier
  const auto = tier === 'auto'
  if (!auto && (typeof tier !== 'number' || !Number.isInteger(tier) || tier < 1 || tier > 5)) bad('tier: số nguyên 1-5 hoặc "auto"')

  const db = env.DB
  const [found] = await db.batch([
    db
      .prepare(
        `SELECT e.auto_tier, t.tier, e.image_key IS NOT NULL AND bi.target_id IS NULL AS has_image
         FROM element e
         LEFT JOIN element_tier t ON t.element_id = e.id
         LEFT JOIN block bi ON bi.kind = 'image' AND bi.target_id = e.id
         WHERE e.id = ?`,
      )
      .bind(id),
  ])
  const row = found?.results[0] as { auto_tier: number | null; tier: number | null; has_image: number } | undefined
  if (!row) return problem(404, 'Không tìm thấy phần tử')
  // AC-TIER-04 (open question 69): Vàng/Đỏ only with a usable image
  if (!auto && (tier as number) >= 4 && !row.has_image) return problem(409, 'Món Vàng/Đỏ cần có ảnh trước')
  const autoTier = row.auto_tier ?? 1
  const before = { tier: row.tier ?? autoTier, source: row.tier === null ? 'auto' : 'admin' }
  const after = auto ? { tier: autoTier, source: 'auto' } : { tier: tier as number, source: 'admin' }
  const now = Date.now()
  const fp = (await sha256hex(env.ADMIN_TOKEN ?? '')).slice(0, 8)
  await db.batch([
    auto
      ? db.prepare('DELETE FROM element_tier WHERE element_id = ?').bind(id)
      : db
          .prepare(
            `INSERT INTO element_tier (element_id, tier, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (element_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
          )
          .bind(id, after.tier, now),
    db
      .prepare(
        `INSERT INTO admin_change (id, action, target_kind, target_id, before_json, after_json, reason, token_fp, created_at)
         VALUES (?, 'set_tier', 'element', ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(uuidv7(now), id, JSON.stringify(before), JSON.stringify(after), fp, now),
  ])
  return json({ element_id: id, before: before.tier, after: after.tier, before_source: before.source, after_source: after.source })
}
