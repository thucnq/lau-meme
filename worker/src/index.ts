import { json, problem } from './http'

type Handler = (req: Request, env: Env) => Promise<Response>

const routes: Record<string, Partial<Record<string, Handler>>> = {
  '/api/health': {
    GET: async (_req, env) => {
      const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind('schema').first<{ value: string }>()
      return json({ status: 'ok', env: env.APP_ENV, schema: row?.value ?? null })
    },
  },
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req)
    const route = routes[url.pathname]
    if (!route) return problem(404, 'Không tìm thấy')
    const handler = route[req.method]
    if (!handler) return problem(405, 'Phương thức không hỗ trợ')
    try {
      return await handler(req, env)
    } catch (err) {
      console.error('unhandled', err instanceof Error ? err.message : err)
      return problem(500, 'Lỗi máy chủ')
    }
  },
} satisfies ExportedHandler<Env>
