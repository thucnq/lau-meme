import { HttpError, json, problem, readJson } from '../../http'
import { elementId, recipeId } from '../../ids'
import { ANONYMOUS, playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { readSession, requireSession, sessionCookie, type Session } from '../../session'
import { dayGmt7 } from '../../uuid'
import { fail, obj } from '../../validate'
import { versionParam } from '../content/content'
import { playConsentStatement, requirePlayConsent } from '../player/consent'

/**
 * Món đặc biệt by account (ADR 0010, AC-DAILY-06..15): a signed-in account sends the pair it combined into the
 * target; the time is the server's receive time minus the batch's batch_at. Streaks and week/month periods follow
 * the GMT+7 day of batch_at.
 */
const SUBMIT_LIMIT: Limit = {
  scope: 'daily',
  windowMs: 60_000,
  perPlayer: 10, // per account (the key passed below)
  perIp: 10,
} // open question #10
const TOP = 20
const DAY_MS = 86_400_000
const GMT7_MS = 7 * 3_600_000
const MAX_NAME = 100

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
type EntryRow = { solve_ms: number; solved_at: number; rank: number }

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** A streak is still alive while its last day is today or yesterday (GMT+7); otherwise it reads as 0. */
export function liveCurrent(row: StreakRow | null, now: number): number {
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

function name(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > MAX_NAME || value.trim() === '') fail(`${path}: tên 1–${MAX_NAME} ký tự`)
  return value as string
}

/** The pair must be an active recipe of the batch whose result is the batch's Món đặc biệt (AC-DAILY-07). */
async function verifyPair(content: ServerContent, blocked: BlockRow[], a: string, b: string): Promise<[string, string]> {
  const off = new Set(blocked.map((r) => `${r.kind}:${r.target_id}`))
  const rid = await recipeId(a, b)
  const recipe = content.recipes.find(([id]) => id === rid)
  const active = recipe && !off.has(`recipe:${rid}`) && !off.has(`element:${recipe[3]}`)
  if (!active || recipe[3] !== content.daily_element_id) fail('Cặp này không ra Món đặc biệt của mẻ')
  const ids = await Promise.all([elementId(a), elementId(b)])
  return ids.sort() as [string, string]
}

export function accountStreakStatement(db: D1Database, accountId: string): D1PreparedStatement {
  return db.prepare('SELECT current, longest, last_day, reached_at FROM account_streak WHERE account_id = ?').bind(accountId)
}

/** The account's entry of a batch with its live rank: solved_at ascending, ties at the same ms by write order. */
const entryStatement = (db: D1Database, version: number, accountId: string) =>
  db
    .prepare(
      `SELECT me.solve_ms, me.solved_at,
         (SELECT COUNT(*) + 1 FROM daily_entry d WHERE d.version = me.version
            AND (d.solved_at < me.solved_at OR (d.solved_at = me.solved_at AND d.seq < me.seq))) AS rank
       FROM daily_entry me WHERE me.version = ? AND me.account_id = ?`,
    )
    .bind(version, accountId)

const publishedStatement = (db: D1Database, version: number) =>
  db.prepare("SELECT 1 AS x FROM batch_run WHERE version = ? AND status = 'success'").bind(version)

const first = <T>(r: D1Result | undefined) => r?.results[0] as T | undefined

function dailyResult(version: number, entry: EntryRow, streak: StreakRow | undefined, now: number) {
  return {
    version,
    solve_ms: entry.solve_ms,
    rank: entry.rank,
    streak: { current: liveCurrent(streak ?? null, now), longest: streak?.longest ?? 0 },
    solved_at: new Date(entry.solved_at).toISOString(),
  }
}

const alreadySubmitted = (result: ReturnType<typeof dailyResult>) =>
  problem(409, 'Đã nộp kết quả cho mẻ này', undefined, { result })

/**
 * POST /api/daily/{version}/results - two D1 round trips: counters + every read in one batch, then the entry, the
 * streak and the new rank in one transactional batch. Writes with the session cookie must be JSON (ADR 0010).
 */
export async function submitDailyResult(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: string[],
): Promise<Response> {
  const version = versionParam(params[0])
  if (!(req.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'Cần Content-Type application/json')
  const body = obj(await readJson(req), 'body', ['a', 'b'])
  const [a, b] = [name(body.a, 'a'), name(body.b, 'b')]
  const session = await requireSession(req, env)
  const player = playerId(req)
  const account = session.accountId
  const db = env.DB
  const now = Date.now()
  const limit = await rateCounters(req, env, SUBMIT_LIMIT, account)
  const n = limit.statements.length
  const reads = await db.batch([
    ...limit.statements,
    playConsentStatement(db, player),
    db.prepare("SELECT value FROM app_meta WHERE key = 'current_version'"),
    publishedStatement(db, version),
    entryStatement(db, version, account),
    accountStreakStatement(db, account),
    db.prepare('SELECT batch_at, server_json FROM batch_content WHERE version = ?').bind(version),
    db.prepare("SELECT kind, target_id FROM block WHERE kind IN ('element', 'recipe')"),
  ])
  const limited = limit.verdict(reads)
  if (limited) return limited
  const [consent, current, published, stored, streakRow, batch, blocked] = reads.slice(n)
  requirePlayConsent(env, first(consent))

  if (version !== Number(first<{ value: string }>(current)?.value ?? NaN)) {
    if (first(published)) return problem(410, 'Mẻ này đã qua', 'Chỉ nhận kết quả cho mẻ hiện hành.')
    return problem(404, 'Không có mẻ này')
  }
  const prevStreak = first<StreakRow>(streakRow)
  const existing = first<EntryRow>(stored)
  if (existing) return alreadySubmitted(dailyResult(version, existing, prevStreak, now))
  const content = first<{ batch_at: number; server_json: string }>(batch)
  if (!content) throw new HttpError(404, 'Không có mẻ này')
  const [aId, bId] = await verifyPair(
    JSON.parse(content.server_json) as ServerContent,
    (blocked?.results ?? []) as BlockRow[],
    a,
    b,
  )

  const day = dayGmt7(content.batch_at)
  const solveMs = Math.max(0, now - content.batch_at)
  const streak = nextStreak(prevStreak ?? null, day, now)
  let written: D1Result[]
  try {
    written = await db.batch([
      db
        .prepare(
          'INSERT INTO daily_entry (version, account_id, day, a_id, b_id, solved_at, solve_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(version, account, day, aId, bId, now, solveMs),
      db
        .prepare(
          `INSERT INTO account_streak (account_id, current, longest, last_day, reached_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id) DO UPDATE SET current = excluded.current, longest = excluded.longest,
             last_day = excluded.last_day, reached_at = excluded.reached_at, updated_at = excluded.updated_at`,
        )
        .bind(account, streak.current, streak.longest, streak.last_day, streak.reached_at, now),
      entryStatement(db, version, account),
    ])
  } catch (err) {
    // A concurrent submit of the same account (another device) won the unique key: answer like a resubmission.
    const [raced, racedStreak] = await db.batch([entryStatement(db, version, account), accountStreakStatement(db, account)])
    const row = first<EntryRow>(raced)
    if (!row) throw err
    return alreadySubmitted(dailyResult(version, row, first<StreakRow>(racedStreak), now))
  }
  const entry = first<EntryRow>(written[2]) ?? { solve_ms: solveMs, solved_at: now, rank: 1 }
  return json(dailyResult(version, entry, streak, now), {
    status: 201,
    headers: { 'Set-Cookie': sessionCookie(env, session.token) },
  })
}

type BoardRow = { solve_ms: number; nickname: string | null }

/** GET /api/daily/{version}/leaderboard - top 20, never an account id or UUID; `me` even outside the top 20. */
export async function getDailyLeaderboard(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  params: string[],
): Promise<Response> {
  const version = versionParam(params[0])
  const session = await readSession(req, env)
  const db = env.DB
  const [published, top, mineResult] = await db.batch([
    publishedStatement(db, version),
    db
      .prepare(
        `SELECT d.solve_ms, a.nickname FROM daily_entry d JOIN account a ON a.id = d.account_id
         WHERE d.version = ? ORDER BY d.solved_at, d.seq LIMIT ?`,
      )
      .bind(version, TOP),
    db
      .prepare(
        `SELECT me.solve_ms, a.nickname,
           (SELECT COUNT(*) + 1 FROM daily_entry d WHERE d.version = me.version
              AND (d.solved_at < me.solved_at OR (d.solved_at = me.solved_at AND d.seq < me.seq))) AS rank
         FROM daily_entry me JOIN account a ON a.id = me.account_id
         WHERE me.version = ? AND me.account_id = ?`,
      )
      .bind(version, session?.accountId ?? ''),
  ])
  if (!first(published)) return problem(404, 'Không có mẻ này')
  const rows = ((top?.results ?? []) as BoardRow[]).map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname ?? ANONYMOUS,
    value: r.solve_ms,
  }))
  const mine = first<BoardRow & { rank: number }>(mineResult)
  const me = mine ? { rank: mine.rank, nickname: mine.nickname ?? ANONYMOUS, value: mine.solve_ms } : null
  return json({ version, rows, me }, { headers: renewed(env, session) })
}

const renewed = (env: Env, session: Session | null): Record<string, string> =>
  session ? { 'Set-Cookie': sessionCookie(env, session.token) } : {}

// ---------------------------------------------------------------------------------------------- week / month

type Period = { key: string; startDay: string; endDay: string; startsAt: number; endsAt: number }

const isoDay = (utcMidnight: number) => new Date(utcMidnight).toISOString().slice(0, 10)

/** UTC midnight of the Monday of ISO week 1 of `year` (the week holding 4 January). */
function isoWeekOne(year: number): number {
  const jan4 = Date.UTC(year, 0, 4)
  return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS
}

/** A calendar period in GMT+7: local dates [startDay, endDay) and the instants they start and end at. */
function period(key: string, startLocal: number, endLocal: number): Period {
  return {
    key,
    startDay: isoDay(startLocal),
    endDay: isoDay(endLocal),
    startsAt: startLocal - GMT7_MS,
    endsAt: endLocal - GMT7_MS,
  }
}

function currentWeek(now: number): Period {
  const local = Date.parse(`${dayGmt7(now)}T00:00:00Z`)
  const monday = local - ((new Date(local).getUTCDay() + 6) % 7) * DAY_MS
  const year = new Date(monday + 3 * DAY_MS).getUTCFullYear() // the ISO year is that of the week's Thursday
  const week = Math.floor((monday - isoWeekOne(year)) / (7 * DAY_MS)) + 1
  return period(`${year}-W${String(week).padStart(2, '0')}`, monday, monday + 7 * DAY_MS)
}

const PERIOD = /^(\d{4})-(?:W(\d{2})|(\d{2}))$/

/**
 * `2026-W43` (ISO week) or `2026-10` (month), absent = this week; a period in the future or starting more than
 * 3 months before today (GMT+7) is a 400 (AC-DAILY-14).
 */
function parsePeriod(raw: string | null, now: number): Period {
  if (raw === null) return currentWeek(now)
  const bad = () => new HttpError(400, 'Kỳ không hợp lệ', 'Dùng tuần dạng 2026-W43 hoặc tháng dạng 2026-10.')
  const m = PERIOD.exec(raw)
  if (!m) throw bad()
  const year = Number(m[1])
  let p: Period
  if (m[2] !== undefined) {
    const week = Number(m[2])
    const weeks = (isoWeekOne(year + 1) - isoWeekOne(year)) / (7 * DAY_MS)
    if (week < 1 || week > weeks) throw bad()
    const start = isoWeekOne(year) + (week - 1) * 7 * DAY_MS
    p = period(raw, start, start + 7 * DAY_MS)
  } else {
    const month = Number(m[3])
    if (month < 1 || month > 12) throw bad()
    p = period(raw, Date.UTC(year, month - 1, 1), Date.UTC(year, month, 1))
  }
  const today = new Date(`${dayGmt7(now)}T00:00:00Z`)
  const earliest = isoDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, today.getUTCDate()))
  if (p.startsAt > now || p.startDay < earliest) throw bad()
  return p
}

type PeriodRow = { rnk: number; nickname: string | null; solved: number; total: number; mine: number }

/** GET /api/daily/leaderboard?period= - solved batches desc, total time asc, last result earlier first. */
export async function getDailyPeriodLeaderboard(req: Request, env: Env): Promise<Response> {
  const now = Date.now()
  const p = parsePeriod(new URL(req.url).searchParams.get('period'), now)
  const session = await readSession(req, env)
  const db = env.DB
  const [ranked, batches] = await db.batch([
    db
      .prepare(
        `WITH agg AS (
           SELECT account_id, COUNT(*) AS solved, SUM(solve_ms) AS total, MAX(solved_at) AS last, MAX(seq) AS last_seq
           FROM daily_entry WHERE day >= ? AND day < ? GROUP BY account_id
         ), ranked AS (
           SELECT agg.*, ROW_NUMBER() OVER (ORDER BY solved DESC, total, last, last_seq) AS rnk FROM agg
         )
         SELECT r.rnk, a.nickname, r.solved, r.total, r.account_id = ? AS mine
         FROM ranked r JOIN account a ON a.id = r.account_id
         WHERE r.rnk <= ? OR r.account_id = ? ORDER BY r.rnk`,
      )
      .bind(p.startDay, p.endDay, session?.accountId ?? '', TOP, session?.accountId ?? ''),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM batch_run r JOIN batch_content c ON c.version = r.version
         WHERE r.status = 'success' AND c.day >= ? AND c.day < ? AND c.batch_at <= ?`,
      )
      .bind(p.startDay, p.endDay, now),
  ])
  const all = (ranked?.results ?? []) as PeriodRow[]
  const row = (r: PeriodRow) => ({ rank: r.rnk, nickname: r.nickname ?? ANONYMOUS, solved: r.solved, total_ms: r.total })
  const mine = all.find((r) => r.mine === 1)
  return json(
    {
      period: p.key,
      starts_at: new Date(p.startsAt).toISOString(),
      ends_at: new Date(p.endsAt).toISOString(),
      batches: first<{ n: number }>(batches)?.n ?? 0,
      rows: all.filter((r) => r.rnk <= TOP).map(row),
      me: mine ? row(mine) : null,
    },
    { headers: renewed(env, session) },
  )
}

/** GET /api/streaks/leaderboard - live account streaks only (last day today or yesterday, GMT+7). */
export async function getStreakLeaderboard(_req: Request, env: Env): Promise<Response> {
  const yesterday = addDays(dayGmt7(Date.now()), -1)
  const top = await env.DB.prepare(
    `SELECT s.current, a.nickname FROM account_streak s JOIN account a ON a.id = s.account_id
     WHERE s.current > 0 AND s.last_day >= ? ORDER BY s.current DESC, s.reached_at, s.account_id LIMIT ?`,
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

/** GET /api/me/streak - the signed-in account's streak, every device alike (AC-DAILY-10, AC-AUTH-04). */
export async function getMyStreak(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env)
  const row = await accountStreakStatement(env.DB, session.accountId).first<StreakRow>()
  return json(
    { current: liveCurrent(row, Date.now()), longest: row?.longest ?? 0 },
    { headers: renewed(env, session) },
  )
}
