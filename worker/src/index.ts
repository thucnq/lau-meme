import { hasBearer } from './auth'
import { getGraph, getManifest } from './features/content/content'
import { createDiscovery, listDiscoveries, putBannedTerms } from './features/disc/disc'
import { getDailyLeaderboard, getMyStreak, getStreakLeaderboard, submitDailyResult } from './features/daily/daily'
import { getPipelineState, patchBatchRun, publishBatch, rollbackBatch } from './features/pipeline/batches'
import { cleanup } from './features/player/cleanup'
import { createConsent, deleteMyData, getMyData, putNickname } from './features/player/me'
import { HttpError, ResponseError, json, problem } from './http'
import { maskId } from './log'

type Handler = (req: Request, env: Env, ctx: ExecutionContext, params: string[]) => Promise<Response>
type Route = { pattern: RegExp; methods: Partial<Record<string, Handler>> }

// Patterns match the path *below* BASE_PATH (ADR 0007), so the API reads "/api/..." whatever the prefix is.

/** Pipeline-only routes: Bearer PIPELINE_TOKEN (ADR 0003). */
function pipelineOnly(handler: Handler): Handler {
  return async (req, env, ctx, params) => {
    if (!(await hasBearer(req, env.PIPELINE_TOKEN))) return problem(401, 'Thiếu hoặc sai token')
    return handler(req, env, ctx, params)
  }
}

const routes: Route[] = [
  {
    pattern: /^\/api\/health$/,
    methods: {
      GET: async (_req, env) => {
        const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind('schema').first<{ value: string }>()
        return json({ status: 'ok', env: env.APP_ENV, schema: row?.value ?? null })
      },
    },
  },
  { pattern: /^\/api\/manifest$/, methods: { GET: getManifest } },
  { pattern: /^\/api\/graph\/([^/]+)$/, methods: { GET: getGraph } },
  { pattern: /^\/api\/daily\/([^/]+)\/results$/, methods: { POST: submitDailyResult } },
  { pattern: /^\/api\/daily\/([^/]+)\/leaderboard$/, methods: { GET: getDailyLeaderboard } },
  { pattern: /^\/api\/streaks\/leaderboard$/, methods: { GET: getStreakLeaderboard } },
  { pattern: /^\/api\/discoveries$/, methods: { GET: listDiscoveries, POST: createDiscovery } },
  { pattern: /^\/api\/consents$/, methods: { POST: createConsent } },
  { pattern: /^\/api\/me$/, methods: { GET: getMyData, DELETE: deleteMyData } },
  { pattern: /^\/api\/me\/nickname$/, methods: { PUT: putNickname } },
  { pattern: /^\/api\/me\/streak$/, methods: { GET: getMyStreak } },
  { pattern: /^\/api\/pipeline\/batches$/, methods: { POST: pipelineOnly(publishBatch) } },
  { pattern: /^\/api\/pipeline\/batches\/([^/]+)$/, methods: { PATCH: pipelineOnly(patchBatchRun) } },
  { pattern: /^\/api\/pipeline\/rollback$/, methods: { POST: pipelineOnly(rollbackBatch) } },
  { pattern: /^\/api\/pipeline\/banned-terms\/([^/]+)$/, methods: { PUT: pipelineOnly(putBannedTerms) } },
  { pattern: /^\/api\/pipeline\/state$/, methods: { GET: pipelineOnly(getPipelineState) } },
]

/** API under `<BASE_PATH>/api/*`; `rest` is the path below BASE_PATH. */
async function api(req: Request, env: Env, ctx: ExecutionContext, rest: string): Promise<Response> {
  for (const route of routes) {
    const match = route.pattern.exec(rest)
    if (!match) continue
    const handler = route.methods[req.method]
    if (!handler) return problem(405, 'Phương thức không hỗ trợ')
    try {
      return await handler(req, env, ctx, match.slice(1))
    } catch (err) {
      if (err instanceof ResponseError) return err.response
      if (err instanceof HttpError) return problem(err.status, err.title, err.detail)
      // never the body, IP, nickname, token or a driver message (may quote SQL values); the player as its mask (AC-PRIV-07)
      const player = req.headers.get('X-Player-Id')
      console.error('unhandled', player ? maskId(player) : '-', err instanceof Error ? err.name : 'unknown')
      return problem(500, 'Lỗi máy chủ')
    }
  }
  return problem(404, 'Không tìm thấy')
}

const isRead = (req: Request): boolean => req.method === 'GET' || req.method === 'HEAD'

const isNavigation = (req: Request): boolean =>
  isRead(req) && (req.headers.get('Sec-Fetch-Mode') === 'navigate' || (req.headers.get('Accept') ?? '').includes('text/html'))

/** Static file under the base path; a navigation that matches no file gets the SPA's index.html (F5 on any screen). */
async function asset(req: Request, env: Env, url: URL): Promise<Response> {
  const res = await env.ASSETS.fetch(req)
  if (res.status !== 404 || !isNavigation(req)) return res
  // `<base>/` (not `<base>/index.html`, which the assets layer would redirect to the directory URL)
  return env.ASSETS.fetch(new Request(new URL(`${env.BASE_PATH}/`, url), { headers: req.headers }))
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url)
    const base = env.BASE_PATH
    if (url.pathname === base) {
      // a 301 would turn a POST into a GET in most clients
      if (!isRead(req)) return problem(405, 'Phương thức không hỗ trợ')
      return new Response(null, { status: 301, headers: { Location: `${base}/${url.search}` } })
    }
    // Everything outside the game's path belongs to other games or the hub (only reachable here via workers.dev).
    if (!url.pathname.startsWith(`${base}/`)) return problem(404, 'Không tìm thấy')
    const rest = url.pathname.slice(base.length)
    if (rest === '/api' || rest.startsWith('/api/')) return api(req, env, ctx, rest)
    // Images (AC-ART-05, phase 2: R2) — reserved so the SPA never answers for them.
    if (rest.startsWith('/img/')) return problem(404, 'Không tìm thấy')
    return asset(req, env, url)
  },

  // Daily retention job (wrangler.jsonc triggers.crons, AC-PRIV-06).
  async scheduled(controller, env): Promise<void> {
    await cleanup(env.DB, controller.scheduledTime)
  },
} satisfies ExportedHandler<Env>
