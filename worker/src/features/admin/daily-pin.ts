import { json, problem, readJson } from '../../http'
import { fold } from '../../ids'
import { uuidv7 } from '../../uuid'
import { ID43 } from '../../validate'
import { bad, sha256hex } from './admin'

/**
 * Món đặc biệt chỉ định cho mẻ kế tiếp (AC-DAILY-19, ADR 0019). At most one `daily_pin` row; every set gets a new id
 * so a batch that read the old one deletes only that (publishBatch). Every 4xx happens before the write batch, so it
 * leaves no audit (AC-ADMIN-09).
 */
const MAX_HINT = 200

type PinRow = { id: string; element_id: string; hint: string; created_at: number; name: string | null; emoji: string | null }
type Pin = { element_id: string; name: string; emoji: string; hint: string; created_at: string }

const PIN_SQL =
  'SELECT p.id, p.element_id, p.hint, p.created_at, e.name, e.emoji FROM daily_pin p LEFT JOIN element e ON e.id = p.element_id'

const toPin = (r: PinRow): Pin => ({
  element_id: r.element_id,
  name: r.name ?? '',
  emoji: r.emoji ?? '',
  hint: r.hint,
  created_at: new Date(r.created_at).toISOString(),
})
const auditState = (r: PinRow | null) => JSON.stringify(r ? { element_id: r.element_id, hint: r.hint } : null)

const WORD = '[\\p{L}\\p{N}_]'
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Same rule as the pipeline's `build_daily_block` (AC-DAILY-03): the folded name as a whole word of the folded hint. */
export function hintNamesDish(hint: string, name: string): boolean {
  return new RegExp(`(?<!${WORD})${escape(fold(name))}(?!${WORD})`, 'u').test(fold(hint))
}

/** GET /api/admin/daily-pin */
export async function getDailyPin(_req: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare(PIN_SQL).first<PinRow>()
  return json({ pin: row ? toPin(row) : null })
}

/** PUT /api/admin/daily-pin - any element in the catalog that is not hidden or blocked; depth and history do not matter. */
export async function setDailyPin(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  for (const k of Object.keys(body)) if (k !== 'element_id' && k !== 'hint') bad(`${k}: trường không được phép`)
  const { element_id: id, hint: rawHint } = body
  if (typeof id !== 'string' || !ID43.test(id)) bad('element_id: id phần tử không hợp lệ')
  if (typeof rawHint !== 'string') bad(`hint: chuỗi 1-${MAX_HINT} ký tự`)
  const hint = (rawHint as string).trim()
  if (hint.length < 1 || hint.length > MAX_HINT) bad(`hint: chuỗi 1-${MAX_HINT} ký tự`)

  const db = env.DB
  const [element, block, current] = await db.batch([
    db.prepare('SELECT name, emoji FROM element WHERE id = ?').bind(id),
    db.prepare("SELECT state FROM block WHERE kind = 'element' AND target_id = ?").bind(id),
    db.prepare(PIN_SQL),
  ])
  const e = element?.results[0] as { name: string; emoji: string } | undefined
  if (!e) return problem(404, 'Không tìm thấy phần tử')
  if (block?.results.length) bad('Phần tử đang bị ẩn hoặc chặn, không chỉ định được')
  if (hintNamesDish(hint, e.name)) bad('Gợi ý không được chứa tên món')

  const before = (current?.results[0] as PinRow | undefined) ?? null
  const now = Date.now()
  const after: PinRow = { id: uuidv7(now), element_id: id as string, hint, created_at: now, name: e.name, emoji: e.emoji }
  const fp = (await sha256hex(env.ADMIN_TOKEN ?? '')).slice(0, 8)
  await db.batch([
    db
      .prepare(
        'INSERT INTO daily_pin (id, slot, element_id, hint, token_fp, created_at) VALUES (?, 1, ?, ?, ?, ?) ' +
          'ON CONFLICT (slot) DO UPDATE SET id = excluded.id, element_id = excluded.element_id, hint = excluded.hint, ' +
          'token_fp = excluded.token_fp, created_at = excluded.created_at',
      )
      .bind(after.id, after.element_id, hint, fp, now),
    db
      .prepare('INSERT INTO daily_pin_change (id, action, before_json, after_json, token_fp, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(uuidv7(now), 'set_daily_pin', auditState(before), auditState(after), fp, now),
  ])
  return json({ before: before ? toPin(before) : null, after: toPin(after) })
}

/** DELETE /api/admin/daily-pin - 204 either way; only an existing pin is audited. */
export async function clearDailyPin(_req: Request, env: Env): Promise<Response> {
  const db = env.DB
  const current = await db.prepare(PIN_SQL).first<PinRow>()
  if (current) {
    const now = Date.now()
    const fp = (await sha256hex(env.ADMIN_TOKEN ?? '')).slice(0, 8)
    await db.batch([
      db.prepare('DELETE FROM daily_pin WHERE id = ?').bind(current.id),
      db
        .prepare('INSERT INTO daily_pin_change (id, action, before_json, after_json, token_fp, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(uuidv7(now), 'clear_daily_pin', auditState(current), auditState(null), fp, now),
    ])
  }
  return new Response(null, { status: 204 })
}
