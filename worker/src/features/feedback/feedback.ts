import { HttpError, json, readJson } from '../../http'
import { elementId, recipeId } from '../../ids'
import { playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { fail, oneOf } from '../../validate'
import { playConsentStatement, requirePlayConsent, type ConsentRow } from '../player/consent'

/** Ngon / Nhạt (AC-FEEDBACK-01..03): one vote per UUID per unordered pair, replaced on a new answer. */
const VOTE_LIMIT: Limit = { scope: 'vote', windowMs: 60_000, perPlayer: 60, perIp: 240 } // AC-FEEDBACK-03
const VALUES = ['ngon', 'nhat'] as const
const MAX_NAME = 100

type ServerContent = { recipes: Array<[id: string, a: string, b: string, result: string]> }
type VoteRow = { recipe_id: string; value: string; updated_at: number }

const first = <T>(r: D1Result | undefined) => r?.results[0] as T | undefined

/** A missing or malformed name is a 400; only a well-formed but false recipe or value is a 422. */
function name(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_NAME)
    throw new HttpError(400, 'Dữ liệu không hợp lệ', `${key}: chuỗi 1–${MAX_NAME} ký tự`)
  return value
}

/** PUT /api/votes - counters, consent and the current batch in one round trip, then an upsert. */
export async function putVote(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const body = await readJson(req)
  for (const k of Object.keys(body))
    if (!['a', 'b', 'value'].includes(k)) throw new HttpError(400, 'Dữ liệu không hợp lệ', `${k}: trường không được phép`)
  const [a, b] = [name(body, 'a'), name(body, 'b')]
  if (typeof body.value !== 'string' || body.value.length > 10) throw new HttpError(400, 'Dữ liệu không hợp lệ', 'value: chuỗi tối đa 10 ký tự')
  const value = oneOf(body.value, 'value', VALUES)
  const [aId, bId, rid] = await Promise.all([elementId(a), elementId(b), recipeId(a, b)])

  const db = env.DB
  const limit = await rateCounters(req, env, VOTE_LIMIT, player)
  const reads = await db.batch([
    ...limit.statements,
    playConsentStatement(db, player),
    db.prepare(
      `SELECT c.server_json FROM batch_content c
       WHERE c.version = (SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'current_version')`,
    ),
  ])
  const over = limit.verdict(reads)
  if (over) return over
  const [consent, current] = reads.slice(limit.statements.length)
  requirePlayConsent(env, first<ConsentRow>(consent))
  const batch = first<{ server_json: string }>(current)
  const recipe = batch && (JSON.parse(batch.server_json) as ServerContent).recipes.find(([id]) => id === rid)
  if (!recipe) fail('không phải công thức đang hoạt động')
  const blocked = await db
    .prepare(
      `SELECT 1 AS x FROM block WHERE (kind = 'element' AND target_id IN (?, ?, ?)) OR (kind = 'recipe' AND target_id = ?)
       LIMIT 1`,
    )
    .bind(aId, bId, recipe[3], rid)
    .first()
  if (blocked) fail('không phải công thức đang hoạt động')

  const row = await db
    .prepare(
      `INSERT INTO vote (recipe_id, player_id, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (recipe_id, player_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       RETURNING recipe_id, value, updated_at`,
    )
    .bind(rid, player, value, Date.now())
    .first<VoteRow>()
  if (!row) throw new Error('vote row missing after upsert')
  return json({ recipe_id: row.recipe_id, value: row.value, updated_at: new Date(row.updated_at).toISOString() })
}
