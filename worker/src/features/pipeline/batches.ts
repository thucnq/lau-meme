import { HttpError, json, problem, readJson } from '../../http'
import { dayGmt7, uuidv7 } from '../../uuid'
import { arr, fail, id43, instant, int, obj, oneOf, str } from '../../validate'
import { currentVersion } from '../content/content'

/** Pipeline publishing (ADR 0003): one DB.batch per version, keep the 14 newest, rollback = pointer switch. */
const KEEP_VERSIONS = 14
/** D1 caps a row at 2 MB; the phase 2 pipeline store (ADR 0009) must fit one row. */
const MAX_STORE_BYTES = 1_900_000
const STORE_KEYS = ['elements', 'recipes', 'queue', 'asked_pairs', 'llm_cache', 'art_pending', 'core_art'] as const
const MODES = ['core', 'full'] as const

type Element = {
  id: string
  name: string
  fold: string
  emoji: string
  depth: number
  origin: string | null
  image_key: string | null
  trend_peak: number | null
}
type Recipe = { id: string; a: string; b: string; result: string; score: number | null }

type BatchRunRow = {
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

export function toBatchRun(row: BatchRunRow) {
  return {
    id: row.id,
    version: row.version,
    batch_at: new Date(row.batch_at).toISOString(),
    mode: row.mode,
    status: row.status,
    failed_step: row.failed_step,
    rollback_to: row.rollback_to,
    stats: JSON.parse(row.stats_json) as object,
    issue_url: row.issue_url,
    created_at: new Date(row.created_at).toISOString(),
  }
}

const COUNT_KEYS = ['crawled', 'added', 'queued', 'quota_used', 'queue_size', 'without_image', 'core_without_image', 'contributions_waiting']
const STATS_KEYS = [...COUNT_KEYS, 'blocked', 'source_errors', 'sources', 'images', 'daily_pool_exhausted']

/** BatchStats of the contract: stored as sent and shown on the admin page (AC-ADMIN-11), so checked key by key. */
function parseStats(value: unknown): string {
  const stats = obj(value, 'stats', STATS_KEYS, [])
  for (const k of COUNT_KEYS) if (k in stats) int(stats[k], `stats.${k}`, 0)
  if ('blocked' in stats) {
    // counts per category only: never element names
    const blocked = obj(stats.blocked, 'stats.blocked', Object.keys(stats.blocked ?? {}), [])
    for (const [k, n] of Object.entries(blocked)) int(n, `stats.blocked.${k}`, 0)
  }
  if ('source_errors' in stats)
    arr(stats.source_errors, 'stats.source_errors', 1000).forEach((v, i) => {
      const e = obj(v, `stats.source_errors[${i}]`, ['source', 'error'])
      str(e.source, `stats.source_errors[${i}].source`, 50)
      str(e.error, `stats.source_errors[${i}].error`, 200)
    })
  if ('sources' in stats)
    arr(stats.sources, 'stats.sources', 1000).forEach((v, i) => {
      const p = `stats.sources[${i}]`
      const s = obj(v, p, ['source', 'concepts', 'error'])
      str(s.source, `${p}.source`, 50)
      if (s.concepts !== null) int(s.concepts, `${p}.concepts`, 0)
      if (s.error !== null) str(s.error, `${p}.error`, 100)
    })
  if ('images' in stats) {
    const im = obj(stats.images, 'stats.images', ['drawn', 'fallback', 'pending'])
    for (const k of ['drawn', 'fallback', 'pending']) int(im[k], `stats.images.${k}`, 0)
  }
  // "Pool thử thách cạn" (AC-DAILY-01)
  if ('daily_pool_exhausted' in stats && typeof stats.daily_pool_exhausted !== 'boolean') fail('stats.daily_pool_exhausted: phải là boolean')
  return JSON.stringify(stats)
}

function parseElements(value: unknown): Element[] {
  return arr(value, 'content.elements', 20000, 1).map((v, i) => {
    const p = `content.elements[${i}]`
    const e = obj(v, p, ['id', 'name', 'fold', 'emoji', 'depth', 'origin', 'image_key', 'trend_peak'], ['id', 'name', 'fold', 'emoji', 'depth'])
    const imageKey = e.image_key ?? null
    if (imageKey !== null && (typeof imageKey !== 'string' || !/^[0-9a-f]{12}\.webp$/.test(imageKey))) fail(`${p}.image_key: sai định dạng`)
    return {
      id: id43(e.id, `${p}.id`),
      name: str(e.name, `${p}.name`, 100),
      fold: str(e.fold, `${p}.fold`, 100),
      emoji: str(e.emoji, `${p}.emoji`, 16),
      depth: int(e.depth, `${p}.depth`, 0),
      origin: e.origin === undefined ? null : oneOf(e.origin, `${p}.origin`, ['vn', 'intl']),
      image_key: imageKey as string | null,
      // AC-PIPE-16: absent → the stored value is kept
      trend_peak: e.trend_peak === undefined ? null : int(e.trend_peak, `${p}.trend_peak`, 0),
    }
  })
}

function parseRecipes(value: unknown, known: Set<string>): Recipe[] {
  return arr(value, 'content.recipes', 50000).map((v, i) => {
    const p = `content.recipes[${i}]`
    const r = obj(v, p, ['id', 'a', 'b', 'result', 'score'], ['id', 'a', 'b', 'result'])
    const [a, b] = [id43(r.a, `${p}.a`), id43(r.b, `${p}.b`)].sort() as [string, string]
    const result = id43(r.result, `${p}.result`)
    for (const ref of [a, b, result]) if (!known.has(ref)) fail(`${p}: tham chiếu phần tử không có trong content.elements`)
    return {
      id: id43(r.id, `${p}.id`),
      a,
      b,
      result,
      score: r.score === undefined ? null : int(r.score, `${p}.score`, 1, 5),
    }
  })
}

function parseGraph(value: unknown, version: number): string {
  const g = obj(value, 'graph', ['format', 'version', 'entries'])
  if (g.format !== 1) fail('graph.format: phải là 1')
  if (g.version !== version) fail('graph.version: phải bằng version')
  const entries = obj(g.entries, 'graph.entries', Object.keys(g.entries ?? {}), [])
  for (const [k, v] of Object.entries(entries)) {
    id43(k, 'graph.entries.<khóa>')
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v)) fail('graph.entries: giá trị phải là base64url')
  }
  return JSON.stringify(g)
}

type ManifestRefs = { version: number; batchAt: number; starters: string[]; daily: string; byId: Map<string, Element> }

/**
 * The manifest is served as-is by GET /api/manifest, so it must match the contract's Manifest schema and agree
 * with the content of the same request (starters, Món đặc biệt, version, batch_at).
 */
function parseManifest(value: unknown, refs: ManifestRefs): string {
  const required = ['version', 'batch_at', 'graph_url', 'starters', 'miss_lines', 'daily']
  const m = obj(value, 'manifest', [...required, 'schedule_hours_utc'], required)
  if (m.version !== refs.version) fail('manifest.version: phải bằng version')
  if (instant(m.batch_at, 'manifest.batch_at') !== refs.batchAt) fail('manifest.batch_at: phải bằng batch_at')
  if (m.graph_url !== `/api/graph/${refs.version}`) fail(`manifest.graph_url: phải là /api/graph/${refs.version}`)
  const starters = arr(m.starters, 'manifest.starters', 4, 4).map((v, i) => {
    const p = `manifest.starters[${i}]`
    const s = obj(v, p, ['id', 'name', 'emoji'])
    const el = refs.byId.get(refs.starters[i] ?? '')
    if (s.id !== refs.starters[i] || s.name !== el?.name || s.emoji !== el?.emoji) fail(`${p}: phải khớp content.starters`)
    return { id: s.id, name: s.name, emoji: s.emoji }
  })
  const missLines = arr(m.miss_lines, 'manifest.miss_lines', 1000, 1).map((v, i) => str(v, `manifest.miss_lines[${i}]`, 200))
  const d = obj(m.daily, 'manifest.daily', ['element_id', 'emoji', 'hint', 'depth'])
  const target = refs.byId.get(refs.daily)
  if (d.element_id !== refs.daily) fail('manifest.daily.element_id: phải bằng content.daily_element_id')
  const depth = int(d.depth, 'manifest.daily.depth', 4, 8)
  if (depth !== target?.depth) fail('manifest.daily.depth: phải bằng depth của Món đặc biệt')
  const daily = {
    element_id: refs.daily,
    emoji: str(d.emoji, 'manifest.daily.emoji', 16),
    hint: str(d.hint, 'manifest.daily.hint', 200),
    depth,
  }
  return JSON.stringify({
    version: refs.version,
    batch_at: m.batch_at,
    graph_url: m.graph_url,
    starters,
    miss_lines: missLines,
    daily,
    ...('schedule_hours_utc' in m && { schedule_hours_utc: parseScheduleHours(m.schedule_hours_utc) }),
  })
}

/** Batch hours of the environment, ascending and unique (AC-DAILY-12); manifests published before have none. */
function parseScheduleHours(value: unknown): number[] {
  const hours = arr(value, 'manifest.schedule_hours_utc', 24, 1).map((v, i) => int(v, `manifest.schedule_hours_utc[${i}]`, 0, 23))
  if (hours.some((h, i) => i > 0 && h <= (hours[i - 1] as number))) fail('manifest.schedule_hours_utc: phải tăng dần, không trùng')
  return hours
}

async function maxPublishedVersion(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT MAX(v) AS v FROM (SELECT MAX(version) AS v FROM batch_run UNION ALL SELECT MAX(version) FROM batch_content)')
    .first<{ v: number | null }>()
  return row?.v ?? 0
}

/** POST /api/pipeline/batches - AC-GRAPH-04/05, AC-PIPE-11. */
export async function publishBatch(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req)
  const now = Date.now()
  const status = oneOf(body.status, 'status', ['success', 'error'])

  if (status === 'error') {
    const b = obj(body, 'body', ['status', 'batch_at', 'mode', 'failed_step', 'stats'])
    const run: BatchRunRow = {
      id: uuidv7(now),
      version: null,
      batch_at: instant(b.batch_at, 'batch_at'),
      mode: oneOf(b.mode, 'mode', MODES),
      status: 'error',
      failed_step: str(b.failed_step, 'failed_step', 100),
      rollback_to: null,
      stats_json: parseStats(b.stats),
      issue_url: null,
      created_at: now,
    }
    await insertRun(env.DB, run).run()
    return json(toBatchRun(run), { status: 201 })
  }

  const b = obj(
    body,
    'body',
    ['status', 'version', 'batch_at', 'mode', 'manifest', 'graph', 'content', 'stats', 'store'],
    ['status', 'version', 'batch_at', 'mode', 'manifest', 'graph', 'content', 'stats'],
  )
  const version = int(b.version, 'version', 1)
  const batchAt = instant(b.batch_at, 'batch_at')
  const mode = oneOf(b.mode, 'mode', MODES)
  const graphJson = parseGraph(b.graph, version)
  const content = obj(b.content, 'content', ['elements', 'recipes', 'starters', 'daily_element_id'])
  const elements = parseElements(content.elements)
  const byId = new Map(elements.map((e) => [e.id, e]))
  const known = new Set(byId.keys())
  const recipes = parseRecipes(content.recipes, known)
  const starters = arr(content.starters, 'content.starters', 4, 4).map((s, i) => id43(s, `content.starters[${i}]`))
  const daily = id43(content.daily_element_id, 'content.daily_element_id')
  for (const ref of [...starters, daily]) if (!known.has(ref)) fail('content: khởi đầu / Món đặc biệt không có trong content.elements')
  const manifestJson = parseManifest(b.manifest, { version, batchAt, starters, daily, byId })
  const statsJson = parseStats(b.stats)
  const storeJson = b.store === undefined ? null : parseStore(b.store)

  if (version <= (await maxPublishedVersion(env.DB))) {
    return problem(409, 'Version phải lớn hơn mọi version đã đăng')
  }

  const serverJson = JSON.stringify({
    starters,
    daily_element_id: daily,
    elements: elements.map((e) => [e.id, e.depth]),
    recipes: recipes.map((r) => [r.id, r.a, r.b, r.result]),
  })
  const run: BatchRunRow = {
    id: uuidv7(now),
    version,
    batch_at: batchAt,
    mode,
    status: 'success',
    failed_step: null,
    rollback_to: null,
    stats_json: statsJson,
    issue_url: null,
    created_at: now,
  }
  const db = env.DB
  await db.batch([
    db
      .prepare(
        `INSERT INTO element (id, name, name_fold, emoji, depth, origin, image_key, trend_peak, first_version, last_version, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.fold'),
                json_extract(value, '$.emoji'), json_extract(value, '$.depth'), json_extract(value, '$.origin'),
                json_extract(value, '$.image_key'), json_extract(value, '$.trend_peak'), ?2, ?2, ?3
         FROM json_each(?1) WHERE true
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_fold = excluded.name_fold, emoji = excluded.emoji,
           depth = excluded.depth, origin = excluded.origin, image_key = excluded.image_key,
           trend_peak = COALESCE(excluded.trend_peak, element.trend_peak),
           last_version = excluded.last_version, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(elements), version, now),
    db
      .prepare(
        `INSERT INTO recipe (id, a_id, b_id, result_id, score, first_version, last_version, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.a'), json_extract(value, '$.b'),
                json_extract(value, '$.result'), json_extract(value, '$.score'), ?2, ?2, ?3
         FROM json_each(?1) WHERE true
         ON CONFLICT (id) DO UPDATE SET a_id = excluded.a_id, b_id = excluded.b_id, result_id = excluded.result_id,
           score = excluded.score, last_version = excluded.last_version, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(recipes), version, now),
    db
      .prepare(
        `INSERT INTO batch_content (version, batch_at, day, manifest_json, graph_json, server_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(version, batchAt, dayGmt7(batchAt), manifestJson, graphJson, serverJson, now),
    setCurrent(db, version, now),
    insertRun(db, { ...run, stats_json: statsJson }, daily),
    db
      .prepare('DELETE FROM batch_content WHERE version NOT IN (SELECT version FROM batch_content ORDER BY version DESC LIMIT ?)')
      .bind(KEEP_VERSIONS),
    ...(storeJson === null
      ? []
      : [db.prepare('INSERT INTO pipeline_store (version, store_json, created_at) VALUES (?, ?, ?)').bind(version, storeJson, now)]),
    db.prepare('DELETE FROM pipeline_store WHERE version NOT IN (SELECT version FROM batch_content)'),
  ])
  return json(toBatchRun(run), { status: 201 })
}

/** ADR 0009: opaque to the Worker - only the top-level shape and the one-row size are checked. */
function parseStore(value: unknown): string {
  const store = obj(value, 'store', STORE_KEYS, [])
  // core_art: drawing state of the core elements (AC-ART-11)
  for (const key of ['elements', 'recipes', 'queue', 'asked_pairs', 'core_art'] as const) {
    if (key in store && !Array.isArray(store[key])) fail(`store.${key}: phải là mảng`)
  }
  if ('art_pending' in store) {
    // ADR 0012: element ids waiting for an illustration
    arr(store.art_pending, 'store.art_pending', 20000).forEach((v, i) => id43(v, `store.art_pending[${i}]`))
  }
  const cache = store.llm_cache
  if ('llm_cache' in store && (typeof cache !== 'object' || cache === null || Array.isArray(cache))) fail('store.llm_cache: phải là object')
  const text = JSON.stringify(store)
  if (new TextEncoder().encode(text).length > MAX_STORE_BYTES) throw new HttpError(413, 'Kho pipeline quá lớn (tối đa 1,9 MB)')
  return text
}

/**
 * GET /api/pipeline/store - ADR 0009: the store written with the current version (or `?version=`); `{}` when that
 * version was published without one (core mode) or nothing is published yet; 404 for a version no longer kept.
 */
export async function getPipelineStore(req: Request, env: Env): Promise<Response> {
  const raw = new URL(req.url).searchParams.get('version')
  let version: number | null
  if (raw === null) {
    version = await currentVersion(env.DB)
  } else {
    if (!/^[1-9][0-9]{0,15}$/.test(raw)) return problem(400, 'version: số nguyên ≥ 1')
    version = Number(raw)
    const kept = await env.DB.prepare('SELECT version FROM batch_content WHERE version = ?').bind(version).first()
    if (kept === null) return problem(404, 'Version không còn lưu')
  }
  if (version === null) return json({})
  const row = await env.DB.prepare('SELECT store_json FROM pipeline_store WHERE version = ?').bind(version).first<{ store_json: string }>()
  // Stored text as is: never re-serialised, so the pipeline reads back byte-identical JSON (AC-PIPE-10).
  return new Response(row?.store_json ?? '{}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

function setCurrent(db: D1Database, version: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO app_meta (key, value, updated_at) VALUES ('current_version', ?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(String(version), now)
}

function insertRun(db: D1Database, run: BatchRunRow, dailyElementId: string | null = null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO batch_run (id, version, batch_at, mode, status, failed_step, rollback_to, daily_element_id, stats_json, issue_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(run.id, run.version, run.batch_at, run.mode, run.status, run.failed_step, run.rollback_to, dailyElementId, run.stats_json, run.issue_url, run.created_at)
}

/** POST /api/pipeline/rollback - AC-GRAPH-06/07. */
export async function rollbackBatch(req: Request, env: Env): Promise<Response> {
  const body = obj(await readJson(req), 'body', ['version'], [])
  const requested = body.version === undefined ? null : int(body.version, 'version', 1)
  const current = await currentVersion(env.DB)
  if (current === null) return problem(409, 'Chưa có version nào để rollback')

  let target: number | null
  if (requested !== null) {
    const row = await env.DB.prepare('SELECT version FROM batch_content WHERE version = ?').bind(requested).first<{ version: number }>()
    if (!row) return problem(404, 'Không còn lưu version này')
    if (requested === current) return problem(409, 'Version này đang là bản hiện hành')
    target = requested
  } else {
    const row = await env.DB.prepare('SELECT MAX(version) AS v FROM batch_content WHERE version < ?').bind(current).first<{ v: number | null }>()
    target = row?.v ?? null
    if (target === null) return problem(409, 'Không có bản trước để rollback')
  }

  const now = Date.now()
  const source = await env.DB.prepare('SELECT mode FROM batch_run WHERE version = ?').bind(target).first<{ mode: string }>()
  const run: BatchRunRow = {
    id: uuidv7(now),
    version: null,
    batch_at: now,
    mode: source?.mode ?? 'core',
    status: 'rollback',
    failed_step: null,
    rollback_to: target,
    stats_json: JSON.stringify({}),
    issue_url: null,
    created_at: now,
  }
  await env.DB.batch([setCurrent(env.DB, target, now), insertRun(env.DB, run)])
  return json(toBatchRun(run))
}

// ~2 batches a day: 1 000 picks cover well over a year, longer than any dish waits for its turn again.
const DAILY_HISTORY_LIMIT = 1000

/**
 * GET /api/pipeline/state - AC-PIPE-13: content and anonymous aggregates only, never a player table.
 * One D1 round trip.
 */
export async function getPipelineState(_req: Request, env: Env): Promise<Response> {
  const db = env.DB
  const [current, blocks, aliases, history, admin, catalog, tiers, contributions] = await db.batch([
    db.prepare('SELECT value FROM app_meta WHERE key = ?').bind('current_version'),
    db.prepare('SELECT kind, target_id FROM block ORDER BY kind, target_id'),
    db.prepare("SELECT term_fold FROM banned_term WHERE source IN ('mod', 'admin') ORDER BY term_fold"),
    db.prepare(
      `SELECT version, daily_element_id, batch_at FROM batch_run
       WHERE status = 'success' AND daily_element_id IS NOT NULL ORDER BY version DESC LIMIT ?`,
    ).bind(DAILY_HISTORY_LIMIT),
    db.prepare("SELECT term_fold FROM banned_term WHERE source = 'admin' ORDER BY term_fold"),
    db.prepare('SELECT id, first_version, COALESCE(trend_peak, 0) AS trend_peak FROM element ORDER BY id'),
    db.prepare('SELECT element_id, tier FROM element_tier ORDER BY element_id'),
    // game content only: no description, image link, account or nickname (AC-CONTRIB-09, ADR 0013)
    db.prepare(
      `SELECT element_id, name, emoji, a_id, b_id, image_hint, decided_at FROM contribution
       WHERE status = 'approved' ORDER BY decided_at, id`,
    ),
  ])
  const value = (current?.results[0] as { value: string } | undefined)?.value
  const blocklist: Record<'elements' | 'recipes' | 'images', string[]> = { elements: [], recipes: [], images: [] }
  for (const row of (blocks?.results ?? []) as { kind: 'element' | 'recipe' | 'image'; target_id: string }[]) {
    blocklist[`${row.kind}s`].push(row.target_id)
  }
  return json({
    current_version: value === undefined ? null : Number(value),
    blocklist,
    banned_aliases: [...new Set(((aliases?.results ?? []) as { term_fold: string }[]).map((r) => r.term_fold))],
    admin_blocked: ((admin?.results ?? []) as { term_fold: string }[]).map((r) => r.term_fold),
    daily_history: ((history?.results ?? []) as { version: number; daily_element_id: string; batch_at: number }[]).reverse().map(
      (r) => ({ version: r.version, element_id: r.daily_element_id, batch_at: new Date(r.batch_at).toISOString() }),
    ),
    feedback: [], // FEEDBACK (optional feature) is not built yet
    catalog: (catalog?.results ?? []) as { id: string; first_version: number; trend_peak: number }[],
    tiers: (tiers?.results ?? []) as { element_id: string; tier: number }[],
    contributions: (
      (contributions?.results ?? []) as {
        element_id: string
        name: string
        emoji: string | null
        a_id: string
        b_id: string
        image_hint: string | null
        decided_at: number
      }[]
    ).map((r) => ({
      element_id: r.element_id,
      name: r.name,
      emoji: r.emoji,
      a: r.a_id,
      b: r.b_id,
      image_hint: r.image_hint ?? '',
      approved_at: new Date(r.decided_at).toISOString(),
    })),
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The contract answers every malformed PATCH body with 400 (no 422 for this operation). */
async function readIssueUrl(req: Request): Promise<string> {
  try {
    const body = obj(await readJson(req), 'body', ['issue_url'])
    const issueUrl = str(body.issue_url, 'issue_url', 300)
    if (!/^https:\/\/github\.com\/\S+$/.test(issueUrl)) fail('issue_url: phải bắt đầu bằng https://github.com/')
    return issueUrl
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) throw new HttpError(400, err.title, err.detail)
    throw err
  }
}

/** PATCH /api/pipeline/batches/{id} - AC-PIPE-14: link the GitHub Issue of the batch report. */
export async function patchBatchRun(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = params[0] ?? ''
  if (!UUID.test(id)) throw new HttpError(400, 'Dữ liệu không hợp lệ', 'id: phải là UUID')
  const issueUrl = await readIssueUrl(req)
  const row = await env.DB.prepare('UPDATE batch_run SET issue_url = ? WHERE id = ? RETURNING *')
    .bind(issueUrl, id)
    .first<BatchRunRow>()
  if (!row) return problem(404, 'Không có đợt này')
  return json(toBatchRun(row))
}
