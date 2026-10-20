import { hasBearer } from './auth'
import { getGraph, getManifest } from './features/content/content'
import { getDailyLeaderboard, getMyStreak, getStreakLeaderboard, submitDailyResult } from './features/daily/daily'
import { getPipelineState, patchBatchRun, publishBatch, rollbackBatch } from './features/pipeline/batches'
import { HttpError, json, problem } from './http'

type Handler = (req: Request, env: Env, ctx: ExecutionContext, params: string[]) => Promise<Response>
type Route = { pattern: RegExp; methods: Partial<Record<string, Handler>> }

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
  { pattern: /^\/api\/me\/streak$/, methods: { GET: getMyStreak } },
  { pattern: /^\/api\/pipeline\/batches$/, methods: { POST: pipelineOnly(publishBatch) } },
  { pattern: /^\/api\/pipeline\/batches\/([^/]+)$/, methods: { PATCH: pipelineOnly(patchBatchRun) } },
  { pattern: /^\/api\/pipeline\/rollback$/, methods: { POST: pipelineOnly(rollbackBatch) } },
  { pattern: /^\/api\/pipeline\/state$/, methods: { GET: pipelineOnly(getPipelineState) } },
]

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req)
    for (const route of routes) {
      const match = route.pattern.exec(url.pathname)
      if (!match) continue
      const handler = route.methods[req.method]
      if (!handler) return problem(405, 'Phương thức không hỗ trợ')
      try {
        return await handler(req, env, ctx, match.slice(1))
      } catch (err) {
        if (err instanceof HttpError) return problem(err.status, err.title, err.detail)
        console.error('unhandled', err instanceof Error ? err.message : 'unknown')
        return problem(500, 'Lỗi máy chủ')
      }
    }
    return problem(404, 'Không tìm thấy')
  },
} satisfies ExportedHandler<Env>
