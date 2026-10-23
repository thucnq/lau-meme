import { hasBearer } from '../../auth'
import { HttpError, json, problem, readJson } from '../../http'
import { optionalPlayerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { dayGmt7, uuidv7 } from '../../uuid'
import { arr, fail, int, obj, oneOf } from '../../validate'
import { playConsentStatement, requirePlayConsent, type ConsentRow } from '../player/consent'

/** Anonymous play events and their daily summary (AC-METRIC-02..06, ADR 0004). */
const EVENTS_LIMIT: Limit = { scope: 'events', windowMs: 60_000, perPlayer: 20, perIp: 200 }
const MAX_EVENTS = 50
const DAY_MS = 86_400_000
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const TYPES = ['session_start', 'combine_summary', 'daily_start', 'daily_complete', 'share', 'report', 'feedback'] as const
type EventType = (typeof TYPES)[number]
type Event = { type: EventType; props: Record<string, unknown> }

/** Allow-list of each event's properties (contract `Event`): anything else is a 422, never stored. */
function parseEvent(value: unknown, path: string): Event {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${path}: phải là object`)
  const type = oneOf((value as Record<string, unknown>).type, `${path}.type`, TYPES)
  switch (type) {
    case 'session_start':
      obj(value, path, ['type'])
      return { type, props: {} }
    case 'combine_summary': {
      const o = obj(value, path, ['type', 'ok', 'miss'])
      return { type, props: { ok: int(o.ok, `${path}.ok`, 0, 10_000), miss: int(o.miss, `${path}.miss`, 0, 10_000) } }
    }
    case 'daily_start': {
      const o = obj(value, path, ['type', 'version'])
      return { type, props: { version: int(o.version, `${path}.version`, 1) } }
    }
    case 'daily_complete': {
      const o = obj(value, path, ['type', 'version', 'steps'])
      return { type, props: { version: int(o.version, `${path}.version`, 1), steps: int(o.steps, `${path}.steps`, 1, 200) } }
    }
    case 'share': {
      const o = obj(value, path, ['type', 'card', 'method'])
      return {
        type,
        props: { card: oneOf(o.card, `${path}.card`, ['daily', 'discovery']), method: oneOf(o.method, `${path}.method`, ['copy', 'native', 'image']) },
      }
    }
    case 'report': {
      const o = obj(value, path, ['type', 'target'])
      return { type, props: { target: oneOf(o.target, `${path}.target`, ['element', 'image']) } }
    }
    case 'feedback': {
      const o = obj(value, path, ['type', 'value'])
      return { type, props: { value: oneOf(o.value, `${path}.value`, ['ngon', 'nhat']) } }
    }
  }
}

/** `X-Player-Id`, or `player_id` in the body for `sendBeacon`, which cannot set headers (ADR 0004). */
function eventPlayer(req: Request, body: Record<string, unknown>): string {
  const fromBody = body.player_id
  if (fromBody !== undefined && (typeof fromBody !== 'string' || !UUID_V4.test(fromBody)))
    throw new HttpError(400, 'player_id không hợp lệ', 'Cần UUID v4.')
  const id = optionalPlayerId(req) ?? (fromBody as string | undefined)?.toLowerCase()
  if (id === undefined) throw new HttpError(400, 'Thiếu X-Player-Id', 'Cần UUID v4 ở header hoặc player_id.')
  return id
}

/**
 * POST /api/events - the whole batch is valid or nothing is written. Stores type, UUID, server time and the
 * validated properties only: no IP, user agent or referrer (AC-METRIC-02).
 */
export async function createEvents(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  const player = eventPlayer(req, body)
  obj(body, 'body', ['player_id', 'events'], ['events'])
  const events = arr(body.events, 'events', MAX_EVENTS, 1).map((e, i) => parseEvent(e, `events[${i}]`))

  const db = env.DB
  const limit = await rateCounters(req, env, EVENTS_LIMIT, player)
  const reads = await db.batch([...limit.statements, playConsentStatement(db, player)])
  const over = limit.verdict(reads)
  if (over) return over
  requirePlayConsent(env, reads[limit.statements.length]?.results[0] as ConsentRow | undefined)

  const now = Date.now()
  const day = dayGmt7(now)
  await db.batch(
    events.map((e) =>
      db
        .prepare('INSERT INTO event (id, player_id, type, props_json, day, received_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(uuidv7(now), player, e.type, JSON.stringify(e.props), day, now),
    ),
  )
  return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } })
}

/** A real calendar date 'YYYY-MM-DD' (2026-02-30 is not), else null. */
function parseDay(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null
}

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null)

type DayRow = {
  daily_players: number
  daily_completions: number
  share_daily: number
  share_discovery: number
  ok: number | null
  miss: number | null
  nhat: number
  feedback: number
  reports: number
}
type CohortRow = { first: string; n: number; back: number }

/**
 * GET /api/metrics/summary?day= - one GMT+7 day as aggregate numbers only, never a UUID or a raw event
 * (AC-METRIC-05/06). D1/D7: players whose first `session_start` was D-1/D-7 and who have one on D (open question 59).
 */
export async function getMetricsSummary(req: Request, env: Env): Promise<Response> {
  const [pipeline, admin] = await Promise.all([hasBearer(req, env.PIPELINE_TOKEN), hasBearer(req, env.ADMIN_TOKEN)])
  if (!pipeline && !admin) return problem(401, 'Thiếu hoặc sai token')
  const day = parseDay(new URL(req.url).searchParams.get('day'))
  if (day === null) return problem(400, 'Tham số không hợp lệ', 'day: ngày YYYY-MM-DD')

  const db = env.DB
  const d1 = shiftDay(day, -1)
  const d7 = shiftDay(day, -7)
  const [counts, cohorts] = await db.batch([
    db
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN type = 'daily_start' THEN player_id END) AS daily_players,
           COALESCE(SUM(type = 'daily_complete'), 0) AS daily_completions,
           COALESCE(SUM(type = 'share' AND json_extract(props_json, '$.card') = 'daily'), 0) AS share_daily,
           COALESCE(SUM(type = 'share' AND json_extract(props_json, '$.card') = 'discovery'), 0) AS share_discovery,
           SUM(CASE WHEN type = 'combine_summary' THEN json_extract(props_json, '$.ok') END) AS ok,
           SUM(CASE WHEN type = 'combine_summary' THEN json_extract(props_json, '$.miss') END) AS miss,
           COALESCE(SUM(type = 'feedback' AND json_extract(props_json, '$.value') = 'nhat'), 0) AS nhat,
           COALESCE(SUM(type = 'feedback'), 0) AS feedback,
           COALESCE(SUM(type = 'report'), 0) AS reports
         FROM event WHERE day = ?`,
      )
      .bind(day),
    db
      .prepare(
        `WITH firsts AS (
           SELECT player_id, MIN(day) AS first FROM event WHERE type = 'session_start' GROUP BY player_id)
         SELECT f.first, COUNT(*) AS n,
                SUM(EXISTS (SELECT 1 FROM event e WHERE e.player_id = f.player_id AND e.type = 'session_start' AND e.day = ?1)) AS back
         FROM firsts f WHERE f.first IN (?2, ?3) GROUP BY f.first`,
      )
      .bind(day, d1, d7),
  ])
  const c = counts?.results[0] as DayRow
  const cohort = (first: string) => {
    const row = (cohorts?.results as CohortRow[] | undefined)?.find((r) => r.first === first)
    return row ? ratio(row.back, row.n) : null
  }
  const ok = c.ok ?? 0
  const miss = c.miss ?? 0
  return json({
    day,
    daily_players: c.daily_players,
    daily_completions: c.daily_completions,
    d1_retention: cohort(d1),
    d7_retention: cohort(d7),
    shares: { daily: c.share_daily, discovery: c.share_discovery },
    miss_rate: ratio(miss, ok + miss),
    nhat_rate: ratio(c.nhat, c.feedback),
    reports: c.reports,
  })
}
