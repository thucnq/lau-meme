import { HttpError, json, problem, readJson } from '../../http'
import { elementId, recipeId } from '../../ids'
import { ANONYMOUS, optionalPlayerId, playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { dayGmt7 } from '../../uuid'
import { arr, fail, int, obj, str } from '../../validate'
import { versionParam } from '../content/content'
import { playConsentStatement, requirePlayConsent } from '../player/consent'

/** Món đặc biệt: submit a path, per-batch leaderboard, streaks by GMT+7 day (AC-DAILY-06..11, 13). */
const SUBMIT_LIMIT: Limit = {
  scope: 'daily',
  windowMs: 60_000,
  perPlayer: 10,
  perIp: 10,
} // open question #10
const MAX_STEPS = 200
const TOP = 20
const DAY_MS = 86_400_000

type Step = { a: string; b: string; result: string }
type BlockRow = { kind: string; target_id: string }
type StreakRow = {
  current: number
  longest: number
  last_day: string
  reached_at: number
}
type ServerContent = {
  starters: string[]
  daily_element_id: string
  recipes: Array<[id: string, a: string, b: string, result: string]>
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** A streak is still alive while its last day is today or yesterday (GMT+7); otherwise it reads as 0. */
function liveCurrent(row: StreakRow | null, now: number): number {
  if (!row) return 0
  return row.last_day >= addDays(dayGmt7(now), -1) ? row.current : 0
}

function nextStreak(prev: StreakRow | null, day: string, now: number): StreakRow {
  if (!prev) return { current: 1, longest: 1, last_day: day, reached_at: now }
  if (day <= prev.last_day) return prev // same day counts once (open question #4)
  const current = prev.last_day === addDays(day, -1) ? prev.current + 1 : 1
  return {
    current,
    longest: Math.max(prev.longest, current),
    last_day: day,
    reached_at: now,
  }
}

function parseBody(body: Record<string, unknown>): {
  steps: number
  path: Step[]
} {
  const b = obj(body, 'body', ['steps', 'path'])
  const steps = int(b.steps, 'steps', 1, MAX_STEPS)
  const path = arr(b.path, 'path', MAX_STEPS, 1).map((v, i) => {
    const s = obj(v, `path[${i}]`, ['a', 'b', 'result'])
    return {
      a: str(s.a, `path[${i}].a`, 100),
      b: str(s.b, `path[${i}].b`, 100),
      result: str(s.result, `path[${i}].result`, 100),
    }
  })
  return { steps, path }
}

/** Replays the path on the version's active recipes; the first broken step is the 422 (AC-DAILY-07). */
async function verifyPath(content: ServerContent, blocked: BlockRow[], steps: number, path: Step[]): Promise<void> {
  const off = new Set(blocked.map((r) => `${r.kind}:${r.target_id}`))
  const recipes = new Map(content.recipes.map(([id, a, b, result]) => [id, { a, b, result }]))
  const have = new Set(content.starters.filter((id) => !off.has(`element:${id}`)))
  let last = ''
  for (const [i, step] of path.entries()) {
    const [a, b, result, rid] = await Promise.all([
      elementId(step.a),
      elementId(step.b),
      elementId(step.result),
      recipeId(step.a, step.b),
    ])
    if (!have.has(a)) fail(`path[${i}].a: phần tử chưa có ở bước này`)
    if (!have.has(b)) fail(`path[${i}].b: phần tử chưa có ở bước này`)
    const recipe = recipes.get(rid)
    const active = recipe && !off.has(`recipe:${rid}`) && !off.has(`element:${recipe.result}`)
    if (!active || recipe.result !== result) fail(`path[${i}]: không phải công thức có thật của mẻ này`)
    have.add(result)
    last = result
  }
  if (last !== content.daily_element_id) fail('path: bước cuối không ra Món đặc biệt')
  if (steps < path.length) fail('steps: nhỏ hơn số bước của đường ghép')
}

const streakStatement = (db: D1Database, player: string) =>
  db.prepare('SELECT current, longest, last_day, reached_at FROM streak WHERE player_id = ?').bind(player)

/** Position in the batch: fewer steps first, ties by submission time (then insertion order). */
const rankStatement = (db: D1Database, version: number, player: string) =>
  db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM daily_result d, daily_result me
       WHERE me.version = ?1 AND me.player_id = ?2 AND d.version = ?1
         AND (d.steps < me.steps OR (d.steps = me.steps AND (d.submitted_at < me.submitted_at
              OR (d.submitted_at = me.submitted_at AND d.rowid < me.rowid))))`,
    )
    .bind(version, player)

const publishedStatement = (db: D1Database, version: number) =>
  db.prepare("SELECT 1 AS x FROM batch_run WHERE version = ? AND status = 'success'").bind(version)

const first = <T>(r: D1Result | undefined) => r?.results[0] as T | undefined

function dailyResult(
  version: number,
  stored: { steps: number; submitted_at: number },
  rank: number,
  streak: StreakRow | undefined,
  now: number,
) {
  return {
    version,
    steps: stored.steps,
    rank,
    streak: {
      current: liveCurrent(streak ?? null, now),
      longest: streak?.longest ?? 0,
    },
    submitted_at: new Date(stored.submitted_at).toISOString(),
  }
}

/**
 * POST /api/daily/{version}/results — two D1 round trips: counters + every read in one batch, then the
 * result row, the streak and the new rank in one transactional batch.
 */
export async function submitDailyResult(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: string[],
): Promise<Response> {
  const version = versionParam(params[0])
  const player = playerId(req)
  const { steps, path } = parseBody(await readJson(req))
  const db = env.DB
  const now = Date.now()
  const limit = await rateCounters(req, env, SUBMIT_LIMIT, player)
  const n = limit.statements.length
  const reads = await db.batch([
    ...limit.statements,
    playConsentStatement(db, player),
    db.prepare("SELECT value FROM app_meta WHERE key = 'current_version'"),
    publishedStatement(db, version),
    db
      .prepare('SELECT steps, submitted_at FROM daily_result WHERE version = ? AND player_id = ?')
      .bind(version, player),
    rankStatement(db, version, player),
    streakStatement(db, player),
    db.prepare('SELECT batch_at, server_json FROM batch_content WHERE version = ?').bind(version),
    db.prepare("SELECT kind, target_id FROM block WHERE kind IN ('element', 'recipe')"),
  ])
  const limited = limit.verdict(reads)
  if (limited) return limited
  const [consent, current, published, stored, rank, streakRow, batch, blocked] = reads.slice(n)
  requirePlayConsent(env, first(consent))

  if (version !== Number(first<{ value: string }>(current)?.value ?? NaN)) {
    if (first(published)) return problem(410, 'Mẻ này đã qua', 'Chỉ nhận kết quả cho mẻ hiện hành.')
    return problem(404, 'Không có mẻ này')
  }
  const prevStreak = first<StreakRow>(streakRow)
  const existing = first<{ steps: number; submitted_at: number }>(stored)
  if (existing) {
    const result = dailyResult(version, existing, first<{ rank: number }>(rank)?.rank ?? 1, prevStreak, now)
    return problem(409, 'Đã nộp kết quả cho mẻ này', undefined, { result })
  }
  const content = first<{ batch_at: number; server_json: string }>(batch)
  if (!content) throw new HttpError(404, 'Không có mẻ này')
  await verifyPath(
    JSON.parse(content.server_json) as ServerContent,
    (blocked?.results ?? []) as BlockRow[],
    steps,
    path,
  )

  const day = dayGmt7(content.batch_at)
  const streak = nextStreak(prevStreak ?? null, day, now)
  let written: D1Result[]
  try {
    written = await db.batch([
      db
        .prepare(
          'INSERT INTO daily_result (version, player_id, day, steps, path_json, submitted_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(version, player, day, steps, JSON.stringify(path), now),
      db
        .prepare(
          `INSERT INTO streak (player_id, current, longest, last_day, reached_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (player_id) DO UPDATE SET current = excluded.current, longest = excluded.longest,
             last_day = excluded.last_day, reached_at = excluded.reached_at, updated_at = excluded.updated_at`,
        )
        .bind(player, streak.current, streak.longest, streak.last_day, streak.reached_at, now),
      rankStatement(db, version, player),
    ])
  } catch (err) {
    // A concurrent submit for the same (version, player) won the primary key: answer like a resubmission.
    const [raced, racedRank, racedStreak] = await db.batch([
      db
        .prepare('SELECT steps, submitted_at FROM daily_result WHERE version = ? AND player_id = ?')
        .bind(version, player),
      rankStatement(db, version, player),
      streakStatement(db, player),
    ])
    const row = first<{ steps: number; submitted_at: number }>(raced)
    if (!row) throw err
    const result = dailyResult(
      version,
      row,
      first<{ rank: number }>(racedRank)?.rank ?? 1,
      first<StreakRow>(racedStreak),
      now,
    )
    return problem(409, 'Đã nộp kết quả cho mẻ này', undefined, { result })
  }
  const result = dailyResult(
    version,
    { steps, submitted_at: now },
    first<{ rank: number }>(written[2])?.rank ?? 1,
    streak,
    now,
  )
  return json(result, { status: 201 })
}

type BoardRow = { steps: number; nickname: string | null }

/** GET /api/daily/{version}/leaderboard — top 20, never a UUID; `me` even outside the top 20. */
export async function getDailyLeaderboard(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: string[],
): Promise<Response> {
  const version = versionParam(params[0])
  const player = optionalPlayerId(req)
  const db = env.DB
  // One round trip: published check, top 20 and (optionally) my row with its rank.
  const statements = [
    publishedStatement(db, version),
    db
      .prepare(
        `SELECT d.steps, p.nickname FROM daily_result d LEFT JOIN player p ON p.id = d.player_id
         WHERE d.version = ? ORDER BY d.steps, d.submitted_at, d.rowid LIMIT ?`,
      )
      .bind(version, TOP),
  ]
  if (player !== null)
    statements.push(
      db
        .prepare(
          `SELECT me.steps, p.nickname,
             (SELECT COUNT(*) + 1 FROM daily_result d WHERE d.version = me.version
                AND (d.steps < me.steps OR (d.steps = me.steps AND (d.submitted_at < me.submitted_at
                     OR (d.submitted_at = me.submitted_at AND d.rowid < me.rowid))))) AS rank
           FROM daily_result me LEFT JOIN player p ON p.id = me.player_id
           WHERE me.version = ? AND me.player_id = ?`,
        )
        .bind(version, player),
    )
  const [published, top, mineResult] = await db.batch(statements)
  if (!first(published)) return problem(404, 'Không có mẻ này')
  const rows = ((top?.results ?? []) as BoardRow[]).map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname ?? ANONYMOUS,
    value: r.steps,
  }))
  const mine = first<BoardRow & { rank: number }>(mineResult)
  const me = mine ? { rank: mine.rank, nickname: mine.nickname ?? ANONYMOUS, value: mine.steps } : null
  return json({ version, rows, me })
}

/** GET /api/streaks/leaderboard — live streaks only (last day today or yesterday, GMT+7). */
export async function getStreakLeaderboard(_req: Request, env: Env): Promise<Response> {
  const yesterday = addDays(dayGmt7(Date.now()), -1)
  const top = await env.DB.prepare(
    `SELECT s.current, p.nickname FROM streak s LEFT JOIN player p ON p.id = s.player_id
     WHERE s.current > 0 AND s.last_day >= ? ORDER BY s.current DESC, s.reached_at, s.player_id LIMIT ?`,
  )
    .bind(yesterday, TOP)
    .all<{ current: number; nickname: string | null }>()
  return json({
    rows: top.results.map((r, i) => ({
      rank: i + 1,
      nickname: r.nickname ?? ANONYMOUS,
      value: r.current,
    })),
  })
}

/** GET /api/me/streak */
export async function getMyStreak(req: Request, env: Env): Promise<Response> {
  const row = await streakStatement(env.DB, playerId(req)).first<StreakRow>()
  return json({
    current: liveCurrent(row, Date.now()),
    longest: row?.longest ?? 0,
  })
}
