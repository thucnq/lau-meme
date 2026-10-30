import { HttpError, json, problem, readJson } from '../../http'
import { elementId, fold } from '../../ids'
import { uuidv7 } from '../../uuid'
import { ID43 } from '../../validate'
import { bad, choice, page, paging, sha256hex, totalOf } from './admin'

/**
 * "Bị chặn" (AC-ADMIN-13..15, ADR 0022): concepts the pipeline blocked at moderation, kept in rejected_concept by
 * publishBatch (AC-MOD-11), and the admin's edits of live elements (AC-ADMIN-16). Every 4xx happens before the write
 * batch, so a failed command writes no audit (AC-ADMIN-09); audit rows go to content_change.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STEPS = ['layer1', 'layer2'] as const
const STATUSES = ['blocked', 'unblocked', 'added', 'approved'] as const
const ADMIN_BLOCKED = 'Tên đang bị chặn vĩnh viễn, gỡ chặn tên trước'
const NAME_TAKEN = 'Tên trùng với phần tử, bí danh hoặc tên đã duyệt khác'

type Text = 'name' | 'emoji' | 'description' | 'daily_hint' | 'image_hint'
/** field → max length in characters (code points, like SQLite's length()); emoji and name need at least 1 */
const TEXT_MAX: Record<Text, number> = { name: 100, emoji: 16, description: 200, daily_hint: 200, image_hint: 300 }
const TEXTS = Object.keys(TEXT_MAX) as Text[]

const conflict = (detail: string) => new HttpError(409, 'Xung đột', detail)
const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[]
const len = (s: string) => [...s].length
const iso = (ms: number) => new Date(ms).toISOString()
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms))
const isUnique = (err: unknown) => err instanceof Error && /UNIQUE/i.test(err.message)
const tokenFp = async (env: Env) => (await sha256hex(env.ADMIN_TOKEN ?? '')).slice(0, 8)

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) bad(`${k}: trường không được phép`)
}

/** A text field of an edit body: `null` only where `nullable`; name and emoji are never empty. */
function text(body: Record<string, unknown>, key: Text, nullable: boolean): string | null {
  const v = body[key]
  if (v === null && nullable) return null
  const min = key === 'name' || key === 'emoji' ? 1 : 0
  if (typeof v !== 'string' || len(v) < min || len(v) > TEXT_MAX[key]) bad(`${key}: chuỗi ${min}-${TEXT_MAX[key]} ký tự`)
  if (key === 'name' && (v as string).trim() === '') bad('name: chuỗi 1-100 ký tự')
  return v as string
}

function rejectedId(raw: string | undefined): string {
  if (!UUID.test(raw ?? '')) bad('id: mã không hợp lệ')
  return (raw as string).toLowerCase()
}

function elementParam(raw: string | undefined): string {
  if (!ID43.test(raw ?? '')) bad('id: id phần tử không hợp lệ')
  return raw as string
}

const contentChange = (db: D1Database, action: string, kind: 'rejected' | 'element', id: string, before: unknown, after: unknown, fp: string, now: number) =>
  db
    .prepare(
      `INSERT INTO content_change (id, action, target_kind, target_id, before_json, after_json, token_fp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(uuidv7(now), action, kind, id, JSON.stringify(before), JSON.stringify(after), fp, now)

/**
 * Folds no other concept may take: catalog names, aliases and edited names of other elements, approved proposals and
 * "Duyệt luôn" rows. `self` is the element the name belongs to (if any), `row` the rejected row being edited.
 */
const takenStatement = (db: D1Database, f: string, self: string | null, row: string | null) =>
  db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM element WHERE name_fold = ?1 AND id IS NOT ?2)
           OR EXISTS (SELECT 1 FROM element_alias WHERE fold = ?1 AND element_id IS NOT ?2)
           OR EXISTS (SELECT 1 FROM element_edit WHERE name_fold = ?1 AND element_id IS NOT ?2)
           OR EXISTS (SELECT 1 FROM contribution WHERE name_fold = ?1 AND status = 'approved' AND element_id IS NOT ?2)
           OR EXISTS (SELECT 1 FROM rejected_concept WHERE name_fold = ?1 AND status = 'approved' AND element_id IS NOT ?2 AND id IS NOT ?3)
         AS taken`,
    )
    .bind(f, self, row)
const taken = (r: D1Result | undefined) => Boolean(rows<{ taken: number }>(r)[0]?.taken)

// ------------------------------------------------------------------------------------------------ rejected rows

type RejectedRow = {
  id: string
  name: string
  name_fold: string
  emoji: string | null
  description: string | null
  daily_hint: string | null
  image_hint: string | null
  source_name: string
  source_url: string | null
  context: string | null
  reasons_json: string
  step: string
  status: (typeof STATUSES)[number]
  seen_count: number
  first_batch_id: string
  last_batch_id: string
  first_seen_at: number
  last_seen_at: number
  edited_at: number | null
  decided_at: number | null
  element_id: string | null
  a_id: string | null
  b_id: string | null
  tier: number | null
}

const toRejected = (r: RejectedRow) => ({
  id: r.id,
  name: r.name,
  emoji: r.emoji,
  description: r.description,
  daily_hint: r.daily_hint,
  image_hint: r.image_hint,
  source_name: r.source_name,
  source_url: r.source_url,
  context: r.context,
  reasons: JSON.parse(r.reasons_json) as Array<{ code: string; label: string }>,
  step: r.step,
  status: r.status,
  seen_count: r.seen_count,
  first_batch_id: r.first_batch_id,
  last_batch_id: r.last_batch_id,
  first_seen_at: iso(r.first_seen_at),
  last_seen_at: iso(r.last_seen_at),
  edited_at: isoOrNull(r.edited_at),
  decided_at: isoOrNull(r.decided_at),
  element_id: r.element_id,
  a: r.a_id,
  b: r.b_id,
  tier: r.tier,
})

const rowStatement = (db: D1Database, id: string) => db.prepare('SELECT * FROM rejected_concept WHERE id = ?').bind(id)

async function loadRow(db: D1Database, id: string): Promise<RejectedRow> {
  const row = await rowStatement(db, id).first<RejectedRow>()
  if (!row) throw new HttpError(404, 'Không tìm thấy khái niệm bị chặn')
  return row
}

/** added / approved rows are read-only (AC-ADMIN-14) */
function editable(row: RejectedRow): void {
  if (row.status !== 'blocked' && row.status !== 'unblocked') throw conflict('Dòng đã thêm hoặc đã duyệt tay chỉ xem, không sửa được')
}

/** GET /api/admin/rejected - last seen first, 50 per page; `q` matches the fold, `reason` a reason code. */
export async function listRejected(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams
  const p = paging(params)
  const q = params.get('q') ?? ''
  if (q.length > 100) bad('q: tối đa 100 ký tự')
  const reason = params.get('reason') ?? ''
  if (reason.length > 50) bad('reason: tối đa 50 ký tự')
  const step = choice(params, 'step', STEPS) ?? ''
  const status = choice(params, 'status', STATUSES) ?? ''
  const db = env.DB
  const [items, total] = await db.batch([
    db
      .prepare(
        `SELECT * FROM rejected_concept
         WHERE (?1 = '' OR instr(name_fold, ?1) > 0)
           AND (?2 = '' OR EXISTS (SELECT 1 FROM json_each(reasons_json) WHERE json_extract(value, '$.code') = ?2))
           AND (?3 = '' OR step = ?3) AND (?4 = '' OR status = ?4)
         ORDER BY last_seen_at DESC, id DESC LIMIT ?5 OFFSET ?6`,
      )
      .bind(fold(q), reason, step, status, p.size, p.offset),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM rejected_concept
         WHERE (?1 = '' OR instr(name_fold, ?1) > 0)
           AND (?2 = '' OR EXISTS (SELECT 1 FROM json_each(reasons_json) WHERE json_extract(value, '$.code') = ?2))
           AND (?3 = '' OR step = ?3) AND (?4 = '' OR status = ?4)`,
      )
      .bind(fold(q), reason, step, status),
  ])
  return page(p, totalOf(total), rows<RejectedRow>(items).map(toRejected))
}

/** GET /api/admin/rejected/{id} */
export async function getRejected(_req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  return json(toRejected(await loadRow(env.DB, rejectedId(params[0]))))
}

/** PATCH /api/admin/rejected/{id} - blocked / unblocked rows only; one edit_rejected row with the changed fields. */
export async function editRejected(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = rejectedId(params[0])
  const body = await readJson(req)
  onlyKeys(body, TEXTS)
  if (Object.keys(body).length === 0) bad('Cần ít nhất một trường')
  const next: Partial<Record<Text, string | null>> = {}
  for (const key of TEXTS) if (key in body) next[key] = text(body, key, key !== 'name')
  const db = env.DB
  const row = await loadRow(db, id)
  editable(row)

  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const key of TEXTS) {
    if (!(key in next) || next[key] === row[key]) continue
    before[key] = row[key]
    after[key] = next[key]
  }
  if (Object.keys(after).length === 0) return json(toRejected(row))
  const name = (next.name ?? row.name) as string
  const nameFold = fold(name)
  if (nameFold !== row.name_fold) {
    const [other, rejectedTwin] = await db.batch([
      takenStatement(db, nameFold, null, id),
      db.prepare('SELECT 1 FROM rejected_concept WHERE name_fold = ? AND id <> ?').bind(nameFold, id),
    ])
    if (taken(other) || rejectedTwin?.results.length) throw conflict(NAME_TAKEN)
  }
  const now = Date.now()
  const merged = { ...row, ...next }
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE rejected_concept SET name = ?, name_fold = ?, emoji = ?, description = ?, daily_hint = ?, image_hint = ?,
             edited_at = ?, updated_at = ? WHERE id = ? AND status IN ('blocked', 'unblocked')`,
        )
        .bind(name, nameFold, merged.emoji, merged.description, merged.daily_hint, merged.image_hint, now, now, id),
      contentChange(db, 'edit_rejected', 'rejected', id, before, after, await tokenFp(env), now),
    ])
  } catch (err) {
    if (isUnique(err)) throw conflict(NAME_TAKEN)
    throw err
  }
  return json(toRejected(await loadRow(db, id)))
}

/** POST /api/admin/rejected/{id}/unblock - blocked → unblocked; the next full batch queues it (AC-PIPE-21). */
export async function unblockRejected(_req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = rejectedId(params[0])
  const db = env.DB
  const [found, adminBlocked] = await db.batch([
    rowStatement(db, id),
    db.prepare("SELECT 1 FROM banned_term WHERE source = 'admin' AND term_fold = (SELECT name_fold FROM rejected_concept WHERE id = ?)").bind(id),
  ])
  const row = rows<RejectedRow>(found)[0]
  if (!row) return problem(404, 'Không tìm thấy khái niệm bị chặn')
  if (row.status !== 'blocked') throw conflict('Chỉ bỏ chặn được dòng đang "Bị chặn"')
  if (adminBlocked?.results.length) throw conflict(ADMIN_BLOCKED)
  const now = Date.now()
  const [updated] = await db.batch([
    db.prepare("UPDATE rejected_concept SET status = 'unblocked', decided_at = ?, updated_at = ? WHERE id = ? AND status = 'blocked'").bind(now, now, id),
    contentChange(db, 'unblock_rejected', 'rejected', id, { status: 'blocked' }, { status: 'unblocked' }, await tokenFp(env), now),
  ])
  if (!updated?.meta.changes) throw conflict('Chỉ bỏ chặn được dòng đang "Bị chặn"')
  return json(toRejected(await loadRow(db, id)))
}

/**
 * POST /api/admin/rejected/{id}/approve - "Duyệt luôn" (AC-ADMIN-15): like approving a proposal, the next batch adds
 * A + B = the concept from /pipeline/state.manual_approvals without Gemini or moderation (open question 98).
 */
export async function approveRejected(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = rejectedId(params[0])
  const body = await readJson(req)
  onlyKeys(body, ['a', 'b', 'tier', ...TEXTS])
  for (const k of ['a', 'b'] as const) if (typeof body[k] !== 'string' || !ID43.test(body[k] as string)) bad(`${k}: id phần tử không hợp lệ`)
  if (body.a === body.b) bad('a, b: hai phần tử phải khác nhau')
  const [a, b] = [body.a as string, body.b as string].sort() as [string, string]
  const name = text(body, 'name', false) as string
  const emoji = text(body, 'emoji', false) as string
  const optional = (key: 'description' | 'daily_hint' | 'image_hint') => (body[key] === undefined ? null : text(body, key, false))
  const [description, dailyHint, imageHint] = [optional('description'), optional('daily_hint'), optional('image_hint')]
  const tier = body.tier ?? null
  if (tier !== null && (typeof tier !== 'number' || !Number.isInteger(tier) || tier < 1 || tier > 5)) bad('tier: số nguyên 1-5')

  const db = env.DB
  const nameFold = fold(name)
  const element = await elementId(name)
  const [found, inputs, pair, other, adminBlocked] = await db.batch([
    rowStatement(db, id),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM element e WHERE e.id IN (?1, ?2)
           AND NOT EXISTS (SELECT 1 FROM block bl WHERE bl.kind = 'element' AND bl.target_id = e.id)`,
      )
      .bind(a, b),
    db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM recipe WHERE a_id = ?1 AND b_id = ?2)
             OR EXISTS (SELECT 1 FROM contribution WHERE a_id = ?1 AND b_id = ?2 AND status = 'approved')
             OR EXISTS (SELECT 1 FROM rejected_concept WHERE a_id = ?1 AND b_id = ?2 AND status = 'approved') AS taken`,
      )
      .bind(a, b),
    takenStatement(db, nameFold, null, id),
    db.prepare("SELECT 1 FROM banned_term WHERE source = 'admin' AND term_fold = ?").bind(nameFold),
  ])
  const row = rows<RejectedRow>(found)[0]
  if (!row) return problem(404, 'Không tìm thấy khái niệm bị chặn')
  if (row.status !== 'blocked' && row.status !== 'unblocked') throw conflict('Dòng đã thêm hoặc đã duyệt tay')
  if (adminBlocked?.results.length) throw conflict(ADMIN_BLOCKED)
  if (totalOf(inputs) !== 2) throw conflict('A hoặc B không có trong graph hoặc đang bị ẩn/chặn')
  if (taken(pair)) throw conflict('Cặp đã có công thức')
  if (taken(other)) throw conflict(NAME_TAKEN)

  const now = Date.now()
  const writes = [
    db
      .prepare(
        `UPDATE rejected_concept SET status = 'approved', name = ?, name_fold = ?, emoji = ?, description = ?, daily_hint = ?,
           image_hint = ?, element_id = ?, a_id = ?, b_id = ?, tier = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('blocked', 'unblocked')`,
      )
      .bind(name, nameFold, emoji, description, dailyHint, imageHint, element, a, b, tier, now, now, id),
    contentChange(db, 'approve_rejected', 'rejected', id, { status: row.status }, { status: 'approved', a, b, element_id: element, ...(tier === null ? {} : { tier }) }, await tokenFp(env), now),
  ]
  if (tier !== null && tier !== 1)
    writes.push(
      db
        .prepare(
          `INSERT INTO element_tier (element_id, tier, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (element_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
        )
        .bind(element, tier, now),
    )
  let written: D1Result[]
  try {
    written = await db.batch(writes)
  } catch (err) {
    if (isUnique(err)) throw conflict('Cặp hoặc tên đã được duyệt')
    throw err
  }
  if (!written[0]?.meta.changes) throw conflict('Dòng đã thêm hoặc đã duyệt tay')
  return json(toRejected(await loadRow(db, id)))
}

// ------------------------------------------------------------------------------------------------ element edits

type Field = Text | 'origin'
const FIELDS: Field[] = [...TEXTS, 'origin']
type EditRow = Record<Field, string | null> & { rev: number; applied_rev: number }
type ElementRow = Record<Field, string | null> & {
  id: string
  state: string
  tier: number
  tier_source: 'auto' | 'admin'
  image_key: string | null
  image_source: 'ai' | 'admin' | null
}

const ELEMENT_SQL = `SELECT e.id, e.name, e.emoji, e.description, e.daily_hint, e.image_hint, e.origin, COALESCE(b.state, 'active') AS state,
    COALESCE(t.tier, e.auto_tier, 1) AS tier, CASE WHEN t.tier IS NULL THEN 'auto' ELSE 'admin' END AS tier_source,
    e.image_key, e.image_source
  FROM element e
  LEFT JOIN block b ON b.kind = 'element' AND b.target_id = e.id
  LEFT JOIN element_tier t ON t.element_id = e.id
  WHERE e.id = ?`

/** Only the overridden fields; null when nothing is overridden. */
function editOf(edit: EditRow | undefined): Partial<Record<Field, string>> | null {
  if (!edit) return null
  const out: Partial<Record<Field, string>> = {}
  for (const f of FIELDS) if (edit[f] !== null) out[f] = edit[f] as string
  return Object.keys(out).length ? out : null
}

async function loadElement(db: D1Database, id: string) {
  const [el, edit, aliases] = await db.batch([
    db.prepare(ELEMENT_SQL).bind(id),
    db.prepare('SELECT * FROM element_edit WHERE element_id = ?').bind(id),
    db.prepare('SELECT fold FROM element_alias WHERE element_id = ? ORDER BY created_at, fold').bind(id),
  ])
  const row = rows<ElementRow>(el)[0]
  if (!row) throw new HttpError(404, 'Không tìm thấy phần tử')
  return { row, edit: rows<EditRow>(edit)[0], aliases: rows<{ fold: string }>(aliases).map((r) => r.fold) }
}

const detail = ({ row, edit, aliases }: Awaited<ReturnType<typeof loadElement>>) => ({
  id: row.id,
  published: {
    name: row.name,
    emoji: row.emoji,
    description: row.description,
    daily_hint: row.daily_hint,
    image_hint: row.image_hint,
    origin: row.origin,
  },
  edit: editOf(edit),
  pending: edit !== undefined && edit.applied_rev < edit.rev,
  aliases,
  state: row.state,
  tier: row.tier,
  tier_source: row.tier_source,
  image_key: row.image_key,
  image_source: row.image_source,
})

/** GET /api/admin/elements/{id} */
export async function getElement(_req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  return json(detail(await loadElement(env.DB, elementParam(params[0]))))
}

/**
 * PATCH /api/admin/elements/{id} - AC-ADMIN-16: element_edit (rev + 1), the old folded name as an alias when the name
 * changes (the id stays, open question 94) and one edit_element row with the changed fields, in one batch. The
 * pipeline applies the edit from the next batch on and never overwrites it (open question 95).
 */
export async function editElement(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = elementParam(params[0])
  const body = await readJson(req)
  onlyKeys(body, FIELDS)
  if (Object.keys(body).length === 0) bad('Cần ít nhất một trường')
  const next: Partial<Record<Field, string | null>> = {}
  for (const key of TEXTS) if (key in body) next[key] = text(body, key, true)
  if ('origin' in body) {
    if (body.origin !== null && body.origin !== 'vn' && body.origin !== 'intl') bad('origin: vn, intl hoặc null')
    next.origin = body.origin as string | null
  }
  const db = env.DB
  const current = await loadElement(db, id)
  const { row, edit } = current
  const old = (f: Field) => edit?.[f] ?? null
  const effective = (f: Field, value: string | null) => value ?? row[f]

  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const f of FIELDS) {
    if (!(f in next) || next[f] === old(f)) continue
    before[f] = effective(f, old(f))
    after[f] = next[f]
  }
  if (Object.keys(after).length === 0) return json(detail(current))

  const oldFold = fold(effective('name', old('name')) as string)
  const newName = 'name' in next ? next.name! : old('name')
  const newFold = fold(effective('name', newName) as string)
  if (newFold !== oldFold && (await takenStatement(db, newFold, id, null).first<{ taken: number }>())?.taken) throw conflict(NAME_TAKEN)

  const now = Date.now()
  const merged = Object.fromEntries(FIELDS.map((f) => [f, f in next ? next[f]! : old(f)])) as Record<Field, string | null>
  const writes = [
    db
      .prepare(
        `INSERT INTO element_edit (element_id, name, name_fold, emoji, description, daily_hint, image_hint, origin, rev, applied_rev, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 0, ?9)
         ON CONFLICT (element_id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold, emoji = excluded.emoji,
           description = excluded.description, daily_hint = excluded.daily_hint, image_hint = excluded.image_hint,
           origin = excluded.origin, rev = element_edit.rev + 1, updated_at = excluded.updated_at`,
      )
      .bind(id, merged.name, merged.name === null ? null : fold(merged.name), merged.emoji, merged.description, merged.daily_hint, merged.image_hint, merged.origin, now),
    contentChange(db, 'edit_element', 'element', id, before, after, await tokenFp(env), now),
  ]
  if (newFold !== oldFold)
    writes.push(db.prepare('INSERT OR IGNORE INTO element_alias (fold, element_id, created_at) VALUES (?, ?, ?)').bind(oldFold, id, now))
  try {
    await db.batch(writes)
  } catch (err) {
    if (isUnique(err)) throw conflict(NAME_TAKEN)
    throw err
  }
  return json(detail(await loadElement(db, id)))
}
