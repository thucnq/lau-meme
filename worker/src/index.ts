import { hasBearer } from './auth'
import { adminOnly, listAudit, listBatches, listElements, listRecipes, listReports, moderate } from './features/admin/admin'
import { getGraph, getImage, getManifest } from './features/content/content'
import { createDiscovery, listDiscoveries, putBannedTerms } from './features/disc/disc'
import { getSession, signInWithGoogle, signOut } from './features/auth/auth'
import { getDailyLeaderboard, getDailyPeriodLeaderboard, getMyStreak, getStreakLeaderboard, submitDailyResult } from './features/daily/daily'
import { getPipelineState, getPipelineStore, patchBatchRun, publishBatch, rollbackBatch } from './features/pipeline/batches'
import { cleanup } from './features/player/cleanup'
import { createConsent, deleteMyData, getMyData, putNickname } from './features/player/me'
import { createReport, getBlocklist } from './features/report/report'
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
  { pattern: /^\/api\/daily\/leaderboard$/, methods: { GET: getDailyPeriodLeaderboard } },
  { pattern: /^\/api\/streaks\/leaderboard$/, methods: { GET: getStreakLeaderboard } },
  { pattern: /^\/api\/blocklist$/, methods: { GET: getBlocklist } },
  { pattern: /^\/api\/reports$/, methods: { POST: createReport } },
  { pattern: /^\/api\/discoveries$/, methods: { GET: listDiscoveries, POST: createDiscovery } },
  { pattern: /^\/api\/auth\/google$/, methods: { POST: signInWithGoogle } },
  { pattern: /^\/api\/auth\/session$/, methods: { GET: getSession, DELETE: signOut } },
  { pattern: /^\/api\/consents$/, methods: { POST: createConsent } },
  { pattern: /^\/api\/me$/, methods: { GET: getMyData, DELETE: deleteMyData } },
  { pattern: /^\/api\/me\/nickname$/, methods: { PUT: putNickname } },
  { pattern: /^\/api\/me\/streak$/, methods: { GET: getMyStreak } },
  { pattern: /^\/api\/pipeline\/batches$/, methods: { POST: pipelineOnly(publishBatch) } },
  { pattern: /^\/api\/pipeline\/batches\/([^/]+)$/, methods: { PATCH: pipelineOnly(patchBatchRun) } },
  { pattern: /^\/api\/pipeline\/rollback$/, methods: { POST: pipelineOnly(rollbackBatch) } },
  { pattern: /^\/api\/pipeline\/banned-terms\/([^/]+)$/, methods: { PUT: pipelineOnly(putBannedTerms) } },
  { pattern: /^\/api\/pipeline\/state$/, methods: { GET: pipelineOnly(getPipelineState) } },
  { pattern: /^\/api\/pipeline\/store$/, methods: { GET: pipelineOnly(getPipelineStore) } },
]

/** Admin API (ADR 0008): only on the admin host, at `/api/admin/*` (no BASE_PATH there). */
const adminRoutes: Route[] = [
  { pattern: /^\/api\/admin\/reports$/, methods: { GET: adminOnly(listReports) } },
  { pattern: /^\/api\/admin\/elements$/, methods: { GET: adminOnly(listElements) } },
  { pattern: /^\/api\/admin\/recipes$/, methods: { GET: adminOnly(listRecipes) } },
  { pattern: /^\/api\/admin\/moderation$/, methods: { POST: adminOnly(moderate) } },
  { pattern: /^\/api\/admin\/batches$/, methods: { GET: adminOnly(listBatches) } },
  { pattern: /^\/api\/admin\/audit$/, methods: { GET: adminOnly(listAudit) } },
]

/** `rest` is the path below BASE_PATH (game host) or the whole path (admin host). */
async function api(routes: Route[], req: Request, env: Env, ctx: ExecutionContext, rest: string): Promise<Response> {
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

/** Headers of every admin-host response; the page itself also gets a strict CSP (ADR 0008). */
const ADMIN_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }
const ADMIN_PAGE_HEADERS = {
  ...ADMIN_HEADERS,
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v)
  return out
}

/**
 * The admin origin (ADR 0008): `/` is the admin page (web/admin.html, built under the base path like every web
 * file), `/api/admin/*` its API, and the page's hashed build files; everything else is 404.
 */
async function adminHost(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return withHeaders(await api(adminRoutes, req, env, ctx, path), ADMIN_HEADERS)
  if (isRead(req) && path === '/') {
    const page = await env.ASSETS.fetch(new Request(new URL(`${env.BASE_PATH}/admin`, url), { headers: req.headers }))
    return withHeaders(page, ADMIN_PAGE_HEADERS)
  }
  if (isRead(req) && path.startsWith(`${env.BASE_PATH}/assets/`)) return withHeaders(await env.ASSETS.fetch(req), ADMIN_HEADERS)
  return withHeaders(problem(404, 'Không tìm thấy'), ADMIN_HEADERS)
}

/** The admin page's entry under the base path: never served on the game origin, where its token would be readable. */
const ADMIN_PAGE = /^\/admin(\.html|\/.*)?$/

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url)
    if (env.ADMIN_HOST && url.hostname === env.ADMIN_HOST) return adminHost(req, env, ctx, url)
    const base = env.BASE_PATH
    if (url.pathname === base) {
      // a 301 would turn a POST into a GET in most clients
      if (!isRead(req)) return problem(405, 'Phương thức không hỗ trợ')
      return new Response(null, { status: 301, headers: { Location: `${base}/${url.search}` } })
    }
    // Everything outside the game's path belongs to other games or the hub (only reachable here via workers.dev).
    if (!url.pathname.startsWith(`${base}/`)) return problem(404, 'Không tìm thấy')
    const rest = url.pathname.slice(base.length)
    if (rest === '/api' || rest.startsWith('/api/')) return api(routes, req, env, ctx, rest)
    if (ADMIN_PAGE.test(rest)) return problem(404, 'Không tìm thấy')
    // Images (AC-ART-05): R2 behind the Worker, never the SPA.
    if (rest.startsWith('/img/')) return isRead(req) ? getImage(req, env, ctx, rest.slice('/img/'.length)) : problem(405, 'Phương thức không hỗ trợ')
    return asset(req, env, url)
  },

  // Daily retention job (wrangler.jsonc triggers.crons, AC-PRIV-06).
  async scheduled(controller, env): Promise<void> {
    await cleanup(env.DB, controller.scheduledTime)
  },
} satisfies ExportedHandler<Env>
