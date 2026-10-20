import { HttpError, json, problem } from '../../http'

/** Version currently served (app_meta 'current_version'), or null before the first batch. */
export async function currentVersion(db: D1Database): Promise<number | null> {
  const row = await db.prepare('SELECT value FROM app_meta WHERE key = ?').bind('current_version').first<{ value: string }>()
  return row ? Number(row.value) : null
}

const SHORT_CACHE = 'public, max-age=60'
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** GET /api/manifest - AC-GRAPH-04/08. The Worker adds `policy_version` (ADR 0004). */
export async function getManifest(_req: Request, env: Env): Promise<Response> {
  const version = await currentVersion(env.DB)
  const row =
    version === null
      ? null
      : await env.DB.prepare('SELECT manifest_json FROM batch_content WHERE version = ?')
          .bind(version)
          .first<{ manifest_json: string }>()
  if (!row) return problem(503, 'Chưa có mẻ nhúng nào được đăng', 'Nồi lẩu đang được chuẩn bị, thử lại sau ít phút.')
  const manifest = { ...(JSON.parse(row.manifest_json) as object), policy_version: policyVersion(env) }
  return json(manifest, { headers: { 'cache-control': SHORT_CACHE } })
}

export function policyVersion(env: Env): number {
  const v = Number(env.POLICY_VERSION ?? '1')
  return Number.isInteger(v) && v >= 1 ? v : 1
}

/** Path parameter `{version}`: positive integer (YYYYMMDDHHmm per ADR 0006, ≤ 15 digits stays a safe integer), otherwise 400. */
export function versionParam(raw: string | undefined): number {
  if (!/^[1-9]\d{0,14}$/.test(raw ?? '')) throw new HttpError(400, 'Version không hợp lệ')
  return Number(raw)
}

/** GET /api/graph/{version} - immutable, put into the Cache API so D1 is read once per location. */
export async function getGraph(req: Request, env: Env, ctx: ExecutionContext, params: string[]): Promise<Response> {
  const version = versionParam(params[0])
  // Key = origin + path only: a query string must not create a new cache entry (and a D1 read) per request.
  const url = new URL(req.url)
  const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' })
  const cache = caches.default
  const hit = await cache.match(cacheKey)
  if (hit) return hit
  const row = await env.DB.prepare('SELECT graph_json FROM batch_content WHERE version = ?')
    .bind(version)
    .first<{ graph_json: string }>()
  if (!row) return problem(404, 'Không còn lưu graph của version này')
  const res = new Response(row.graph_json, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': IMMUTABLE },
  })
  ctx.waitUntil(cache.put(cacheKey, res.clone()))
  return res
}
