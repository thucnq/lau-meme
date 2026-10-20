import { HttpError, json, problem, readJson } from '../../http'
import { elementId, fold, recipeId } from '../../ids'
import { ANONYMOUS, playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { ID43, fail, obj, oneOf } from '../../validate'
import { playConsentStatement, requirePlayConsent, type ConsentRow } from '../player/consent'

/** Công thức gia truyền (AC-DISC-05..12): first discoverer per element, checked against the current version. */
const DISCOVER_LIMIT: Limit = { scope: 'disc', windowMs: 60_000, perPlayer: 30, perIp: 60 } // open question #10
const MAX_IDS = 50
const MAX_NAME = 100

type ServerContent = { starters: string[]; recipes: Array<[id: string, a: string, b: string, result: string]> }
type DiscoveryRow = { element_id: string; nickname: string | null; discovered_at: number }

const first = <T>(r: D1Result | undefined) => r?.results[0] as T | undefined

const discovery = (r: DiscoveryRow) => ({
  element_id: r.element_id,
  nickname: r.nickname ?? ANONYMOUS,
  discovered_at: new Date(r.discovered_at).toISOString(),
})

const discoveryStatement = (db: D1Database, element: string) =>
  db
    .prepare(
      `SELECT d.element_id, p.nickname, d.discovered_at FROM discovery d LEFT JOIN player p ON p.id = d.player_id
       WHERE d.element_id = ?`,
    )
    .bind(element)

/** A missing or malformed field is a 400 (AC-DISC-12); only a well-formed but false recipe is a 422. */
function name(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_NAME)
    throw new HttpError(400, 'Dữ liệu không hợp lệ', `${key}: chuỗi 1–${MAX_NAME} ký tự`)
  return value
}

/** POST /api/discoveries — reads + counters in one round trip, then the insert race decides who is first. */
export async function createDiscovery(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const body = await readJson(req)
  for (const k of Object.keys(body))
    if (!['a', 'b', 'result'].includes(k)) throw new HttpError(400, 'Dữ liệu không hợp lệ', `${k}: trường không được phép`)
  const [a, b, result] = [name(body, 'a'), name(body, 'b'), name(body, 'result')]
  const [aId, bId, resultId, rid] = await Promise.all([elementId(a), elementId(b), elementId(result), recipeId(a, b)])

  const db = env.DB
  const limit = await rateCounters(req, env, DISCOVER_LIMIT, player)
  const reads = await db.batch([
    ...limit.statements,
    playConsentStatement(db, player),
    db.prepare(
      `SELECT c.version, c.server_json FROM batch_content c
       WHERE c.version = (SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'current_version')`,
    ),
    db
      .prepare(
        `SELECT 1 AS x FROM block WHERE (kind = 'element' AND target_id IN (?, ?, ?)) OR (kind = 'recipe' AND target_id = ?)
         LIMIT 1`,
      )
      .bind(aId, bId, resultId, rid),
  ])
  const over = limit.verdict(reads)
  if (over) return over
  const [consent, current, blocked] = reads.slice(limit.statements.length)
  requirePlayConsent(env, first<ConsentRow>(consent))
  const batch = first<{ version: number; server_json: string }>(current)
  if (!batch) return problem(503, 'Chưa có mẻ nào được đăng')

  const content = JSON.parse(batch.server_json) as ServerContent
  if (content.starters.includes(resultId)) fail('result: phần tử khởi đầu không có Công thức gia truyền')
  const recipe = content.recipes.find(([id]) => id === rid)
  if (!recipe || recipe[3] !== resultId || first(blocked)) fail('không phải công thức đang hoạt động của mẻ này')

  const now = Date.now()
  const [inserted, row] = await db.batch([
    db
      .prepare(
        `INSERT INTO discovery (element_id, player_id, a_id, b_id, version, discovered_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (element_id) DO NOTHING`,
      )
      .bind(resultId, player, aId, bId, batch.version, now),
    discoveryStatement(db, resultId),
  ])
  const firstTime = (inserted?.meta.changes ?? 0) === 1
  const stored = first<DiscoveryRow>(row)
  if (!stored) throw new Error('discovery row missing after insert')
  return json({ ...discovery(stored), first: firstTime }, { status: firstTime ? 201 : 200 })
}

/** GET /api/discoveries?ids=… — never a UUID nor the recipe used (it would give the answer away). */
export async function listDiscoveries(req: Request, env: Env): Promise<Response> {
  const raw = new URL(req.url).searchParams.get('ids') ?? ''
  const ids = raw.split(',')
  if (raw === '' || ids.length > MAX_IDS || !ids.every((id) => ID43.test(id)))
    return problem(400, 'Tham số ids không hợp lệ', `1–${MAX_IDS} id phần tử, cách nhau bằng dấu phẩy.`)
  const rows = await env.DB.prepare(
    `SELECT d.element_id, p.nickname, d.discovered_at FROM discovery d LEFT JOIN player p ON p.id = d.player_id
     WHERE d.element_id IN (SELECT value FROM json_each(?)) ORDER BY d.element_id`,
  )
    .bind(JSON.stringify(ids))
    .all<DiscoveryRow>()
  return json({ items: rows.results.map(discovery) }, { headers: { 'cache-control': 'public, max-age=60' } })
}

/** Letters and digits of the folded text: "A.b.c  Xyz" → "abcxyz" (AC-DISC-03, AC-MOD-06). */
export function bannedKey(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}]/gu, '')
}

/** PUT /api/pipeline/banned-terms/{source} — replaces one source's whole set (ADR 0005). Never logs the terms. */
export async function putBannedTerms(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const source = oneOf(params[0], 'source', ['wordlist', 'mod'] as const)
  const b = obj(await readJson(req), 'body', ['terms'])
  if (!Array.isArray(b.terms) || b.terms.length > 5000) throw new HttpError(400, 'Dữ liệu không hợp lệ', 'terms: mảng ≤ 5000')
  const terms = new Set<string>()
  for (const [i, t] of b.terms.entries()) {
    if (typeof t !== 'string' || t.length < 1 || t.length > 100) fail(`terms[${i}]: chuỗi 1–100 ký tự`)
    const folded = fold(t as string)
    if (folded !== '') terms.add(folded)
  }
  const db = env.DB
  const now = Date.now()
  await db.batch([
    db.prepare('DELETE FROM banned_term WHERE source = ?').bind(source),
    db
      .prepare('INSERT OR IGNORE INTO banned_term (term_fold, source, created_at) SELECT value, ?, ? FROM json_each(?)')
      .bind(source, now, JSON.stringify([...terms])),
  ])
  return new Response(null, { status: 204 })
}

