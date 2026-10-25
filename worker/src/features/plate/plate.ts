import { HttpError, ResponseError, json, problem } from '../../http'
import { elementId, recipeId } from '../../ids'
import { playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { mustHave, sessionCookie, sessionFrom, sessionStatement, type Session } from '../../session'
import { playConsentStatement, requirePlayConsent, type ConsentRow } from '../player/consent'

/**
 * Đĩa nhúng of a signed-in account (AC-SYNC-01..10, ADR 0015): the union of what every browser of the account made.
 * The account comes only from the session cookie, never from X-Player-Id (AC-SYNC-05). An element is accepted only
 * with the pair that makes it, so the plate cannot unlock names nobody combined (ADR 0002).
 */
const PLATE_LIMIT: Limit = { scope: 'plate', windowMs: 60_000, perPlayer: 120, perIp: 0 } // open question 68
const MAX_BODY_BYTES = 64 * 1024
const MAX_MERGE = 500
const MAX_NAME = 100
const FIELDS = ['a', 'b', 'result'] as const

type Combination = { a: string; b: string; result: string }
type Checked = { resultId: string; rid: string }

const enc = new TextEncoder()
const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[]
const bad = (detail: string): never => {
  throw new HttpError(400, 'Dữ liệu không hợp lệ', detail)
}

/** A body over 64 KB, broken JSON or any shape off the contract is a 400 (AC-SYNC-04); never echoes the input. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (enc.encode(text).length > MAX_BODY_BYTES) bad('Thân yêu cầu quá 64 KB')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    bad('JSON không hợp lệ')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) bad('Thân yêu cầu phải là object JSON')
  return data as Record<string, unknown>
}

function combination(value: unknown, path: string): Combination {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(`${path}: phải là object`)
  const o = value as Record<string, unknown>
  for (const k of Object.keys(o)) if (!(FIELDS as readonly string[]).includes(k)) bad(`${path}: trường không được phép`)
  for (const k of FIELDS) {
    const v = o[k]
    if (typeof v !== 'string' || v.trim() === '' || v.length > MAX_NAME) bad(`${path}.${k}: chuỗi 1-${MAX_NAME} ký tự`)
  }
  return o as Combination
}

const check = async (c: Combination): Promise<Checked> => {
  const [resultId, rid] = await Promise.all([elementId(c.result), recipeId(c.a, c.b)])
  return { resultId, rid }
}

/**
 * Indices (into `checked`) of real recipes: in the catalog with last_version among the retained versions (14,
 * AC-GRAPH-05), and neither the recipe nor any of its three elements blocked (AC-REPORT-09).
 */
function validStatement(db: D1Database, checked: Checked[]): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CAST(j.key AS INTEGER) AS i FROM json_each(?) j
       JOIN recipe r ON r.id = json_extract(j.value, '$[1]') AND r.result_id = json_extract(j.value, '$[0]')
       WHERE r.last_version >= (SELECT MIN(version) FROM batch_content)
         AND NOT EXISTS (
           SELECT 1 FROM block bl
           WHERE (bl.kind = 'element' AND bl.target_id IN (r.a_id, r.b_id, r.result_id))
              OR (bl.kind = 'recipe' AND bl.target_id = r.id))`,
    )
    .bind(JSON.stringify(checked.map((c) => [c.resultId, c.rid])))
}

/** Session and play consent in one round trip: 401 before 403 (AC-SYNC-05, AC-PRIV-02). */
async function signedIn(req: Request, env: Env, needsConsent: boolean): Promise<Session> {
  const player = playerId(req)
  const lookup = await sessionStatement(req, env)
  if (!lookup) return mustHave(null)
  const [session, consent] = await env.DB.batch([lookup.statement, playConsentStatement(env.DB, player)])
  const s = mustHave(sessionFrom(lookup.token, session))
  if (needsConsent) requirePlayConsent(env, rows<ConsentRow>(consent)[0])
  return s
}

/** The write counter (120/min per account, POST and merge together) with the reads, in one round trip. */
async function limitedReads(req: Request, env: Env, session: Session, reads: D1PreparedStatement[]): Promise<D1Result[]> {
  const limit = await rateCounters(req, env, PLATE_LIMIT, session.accountId, 'player')
  const results = await env.DB.batch([...limit.statements, ...reads])
  const over = limit.verdict(results)
  if (over) throw new ResponseError(over)
  return results.slice(limit.statements.length)
}

/** Inserts the accepted elements (first found_at wins) and returns the plate size. */
async function write(env: Env, session: Session, ids: string[]): Promise<number> {
  const db = env.DB
  const [, count] = await db.batch([
    db
      .prepare(
        `INSERT INTO account_element (account_id, element_id, found_at)
         SELECT ?, value, ? FROM json_each(?) WHERE true
         ON CONFLICT (account_id, element_id) DO NOTHING`,
      )
      .bind(session.accountId, Date.now(), JSON.stringify([...new Set(ids)])),
    db.prepare('SELECT COUNT(*) AS n FROM account_element WHERE account_id = ?').bind(session.accountId),
  ])
  return rows<{ n: number }>(count)[0]?.n ?? 0
}

const renewed = (env: Env, session: Session) => ({ 'Set-Cookie': sessionCookie(env, session.token) })

/** GET /api/me/plate - the whole plate, starters excluded, blocked or retired elements included (AC-SYNC-02/08). */
export async function getMyPlate(req: Request, env: Env): Promise<Response> {
  const session = await signedIn(req, env, false)
  const items = await env.DB.prepare('SELECT element_id, found_at FROM account_element WHERE account_id = ? ORDER BY found_at, element_id')
    .bind(session.accountId)
    .all<{ element_id: string; found_at: number }>()
  return json(
    { items: items.results.map((r) => ({ element_id: r.element_id, found_at: new Date(r.found_at).toISOString() })) },
    { headers: renewed(env, session) },
  )
}

/** POST /api/me/plate - one element just made; 404 unknown result, 422 a pair that does not make it (AC-SYNC-01/04). */
export async function addToMyPlate(req: Request, env: Env): Promise<Response> {
  const body = combination(await readBody(req), 'body')
  const session = await signedIn(req, env, true)
  const checked = await check(body)
  const [exists, valid] = await limitedReads(req, env, session, [
    env.DB.prepare('SELECT 1 AS x FROM element WHERE id = ?').bind(checked.resultId),
    validStatement(env.DB, [checked]),
  ])
  if (rows(exists).length === 0) return problem(404, 'Không có món này')
  // the same title whatever the pair makes instead (AC-SYNC-04)
  if (rows(valid).length === 0) return problem(422, 'Không phải công thức của món này')
  const count = await write(env, session, [checked.resultId])
  return json({ count }, { headers: renewed(env, session) })
}

/** POST /api/me/plate/merge - up to 500 elements at once; invalid ones only show up as indices (AC-SYNC-03/06/09). */
export async function mergeMyPlate(req: Request, env: Env): Promise<Response> {
  const body = await readBody(req)
  for (const k of Object.keys(body)) if (k !== 'items') bad('body: trường không được phép')
  const items = body.items
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_MERGE) bad(`items: mảng 1-${MAX_MERGE} mục`)
  const combos = (items as unknown[]).map((c, i) => combination(c, `items[${i}]`))
  const session = await signedIn(req, env, true)
  const checked = await Promise.all(combos.map(check))
  const [valid] = await limitedReads(req, env, session, [validStatement(env.DB, checked)])
  const ok = new Set(rows<{ i: number }>(valid).map((r) => r.i))
  const skipped = checked.flatMap((_, i) => (ok.has(i) ? [] : [i]))
  const count = await write(env, session, checked.filter((_, i) => ok.has(i)).map((c) => c.resultId))
  return json({ count, skipped }, { headers: renewed(env, session) })
}
