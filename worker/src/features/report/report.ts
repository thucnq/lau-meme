import { HttpError, json, problem, readJson } from '../../http'
import { playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { uuidv7 } from '../../uuid'
import { ID43, fail, oneOf } from '../../validate'
import { playConsentStatement, requirePlayConsent, type ConsentRow } from '../player/consent'

/** Báo cáo + chặn nóng (AC-REPORT-01..09, AC-INV-09). */
const REPORT_LIMIT: Limit = { scope: 'report', windowMs: 3_600_000, perPlayer: 10, perIp: 30 } // open question #10
const HIDE_AT = 3 // distinct UUIDs reporting an element in the current cycle
const REASONS = [
  'real_person',
  'politics_religion',
  'sexual',
  'discrimination',
  'violence_drugs_selfharm',
  'inappropriate_image',
  'other',
] as const
const TARGETS = ['element', 'image'] as const

type ReportRow = { kind: string; target_id: string; reason: string; status: string; created_at: number }

const first = <T>(r: D1Result | undefined) => r?.results[0] as T | undefined

const report = (r: ReportRow) => ({
  target: r.kind,
  id: r.target_id,
  reason: r.reason,
  status: r.status,
  created_at: new Date(r.created_at).toISOString(),
})

function parse(body: Record<string, unknown>) {
  for (const k of Object.keys(body))
    if (!['target', 'id', 'reason', 'note'].includes(k)) throw new HttpError(400, 'Dữ liệu không hợp lệ', `${k}: trường không được phép`)
  const { id, note } = body
  if (typeof id !== 'string' || !ID43.test(id)) throw new HttpError(400, 'Dữ liệu không hợp lệ', 'id: id phần tử không hợp lệ')
  if (note !== undefined && (typeof note !== 'string' || note.length > 1000))
    throw new HttpError(400, 'Dữ liệu không hợp lệ', 'note: chuỗi tối đa 1000 ký tự')
  const target = oneOf(body.target, 'target', TARGETS)
  const reason = oneOf(body.reason, 'reason', REASONS)
  if (note !== undefined && reason !== 'other') fail('note: chỉ dùng với lý do "khác"')
  if (typeof note === 'string' && note.length > 200) fail('note: tối đa 200 ký tự')
  return { target, id, reason, note: typeof note === 'string' ? note : null }
}

/**
 * POST /api/reports - counters and reads in one round trip, then the report row and (for the 3rd distinct UUID
 * on an element, or any image report) the block row in one transactional batch (AC-REPORT-04/05).
 */
export async function createReport(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const { target, id, reason, note } = parse(await readJson(req))
  const db = env.DB
  // Counters run before the consent/target checks, so refused calls use up the quota too (ADR 0004: "không ghi
  // gì" never covers the counter itself).
  const limit = await rateCounters(req, env, REPORT_LIMIT, player)
  const reads = await db.batch([
    ...limit.statements,
    playConsentStatement(db, player),
    db.prepare('SELECT image_key FROM element WHERE id = ?').bind(id),
    db
      .prepare(
        `SELECT r.kind, r.target_id, r.reason, r.status, r.created_at FROM report r
         WHERE r.kind = ?1 AND r.target_id = ?2 AND r.player_id = ?3
           AND r.cycle = COALESCE((SELECT cycle FROM report_target WHERE kind = ?1 AND target_id = ?2), 0)`,
      )
      .bind(target, id, player),
  ])
  const over = limit.verdict(reads)
  if (over) return over
  const [consent, element, existing] = reads.slice(limit.statements.length)
  requirePlayConsent(env, first<ConsentRow>(consent))
  const el = first<{ image_key: string | null }>(element)
  if (!el || (target === 'image' && el.image_key === null)) return problem(404, 'Không tìm thấy đích báo cáo')
  // A repeat answers with the stored report even if the target was hidden since (AC-REPORT-03).
  const mine = first<ReportRow>(existing)
  if (mine) return json(report(mine))

  const now = Date.now()
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO report (id, kind, target_id, cycle, player_id, reason, note, status, created_at)
         VALUES (?3, ?1, ?2, COALESCE((SELECT cycle FROM report_target WHERE kind = ?1 AND target_id = ?2), 0),
                 ?4, ?5, ?6, 'new', ?7)
         ON CONFLICT DO NOTHING RETURNING kind, target_id, reason, status, created_at`,
      )
      .bind(target, id, uuidv7(now), player, reason, note, now),
    // Images go to emoji after one report; elements hide at the 3rd distinct UUID of the current cycle.
    db
      .prepare(
        `INSERT INTO block (kind, target_id, state, reason, created_at)
         SELECT ?1, ?2, 'hidden', 'auto_report', ?3
         WHERE ?1 = 'image'
            OR (SELECT COUNT(*) FROM report WHERE kind = ?1 AND target_id = ?2 AND cycle = COALESCE(
                 (SELECT cycle FROM report_target WHERE kind = ?1 AND target_id = ?2), 0)) >= ?4
         ON CONFLICT (kind, target_id) DO NOTHING`,
      )
      .bind(target, id, now, HIDE_AT),
  ])
  const row = first<ReportRow>(inserted)
  if (row) return json(report(row), { status: 201 })
  // a concurrent request of the same UUID won the unique index: answer like a repeat
  const again = await db
    .prepare(
      `SELECT kind, target_id, reason, status, created_at FROM report
       WHERE kind = ?1 AND target_id = ?2 AND player_id = ?3
         AND cycle = COALESCE((SELECT cycle FROM report_target WHERE kind = ?1 AND target_id = ?2), 0)`,
    )
    .bind(target, id, player)
    .first<ReportRow>()
  if (!again) throw new Error('report row missing after insert')
  return json(report(again))
}

/** GET /api/blocklist - ids only; `?fresh=1` skips caches right after a report (AC-REPORT-04/06). */
export async function getBlocklist(req: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare('SELECT kind, target_id FROM block ORDER BY kind, target_id').all<{
    kind: 'element' | 'recipe' | 'image'
    target_id: string
  }>()
  const list = { elements: [] as string[], recipes: [] as string[], images: [] as string[] }
  const key = { element: 'elements', recipe: 'recipes', image: 'images' } as const
  for (const r of rows.results) list[key[r.kind]].push(r.target_id)
  const fresh = new URL(req.url).searchParams.get('fresh') === '1'
  return json(list, { headers: { 'cache-control': fresh ? 'no-store' : 'public, max-age=60' } })
}
