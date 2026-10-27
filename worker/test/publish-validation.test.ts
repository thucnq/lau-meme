// Not acceptance tests: hardening from the feat/graph review (manifest validation, graph cache key).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

const TOKEN = ['validation', 'pipeline', 'token'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  headers.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    { ...env, PIPELINE_TOKEN: TOKEN },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

async function id43(label: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label))
  return Buffer.from(digest).toString('base64url')
}

async function body(version: number) {
  const names = ['Cay', 'Cười', 'Toang', 'Deadline']
  const emojis = ['🌶️', '😂', '💀', '⏰']
  const starters = await Promise.all(names.map((n) => id43(`v|${n}`)))
  const target = await id43('v|Món')
  const [x, y] = [starters[0]!, starters[1]!].sort()
  return {
    status: 'success',
    version,
    batch_at: BATCH_AT,
    mode: 'core',
    manifest: {
      version,
      batch_at: BATCH_AT,
      graph_url: `/api/graph/${version}`,
      starters: starters.map((id, i) => ({ id, name: names[i], emoji: emojis[i] })),
      miss_lines: ['Khét rồi.'],
      daily: { element_id: target, emoji: '🍲', hint: 'Gợi ý', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await id43(`g|${version}`)]: 'abc' } },
    content: {
      elements: [
        ...names.map((name, i) => ({ id: starters[i], name, fold: name.toLowerCase(), emoji: emojis[i], depth: 0 })),
        { id: target, name: 'Món', fold: 'mon', emoji: '🍲', depth: 4 },
      ],
      recipes: [{ id: await id43('r|1'), a: x, b: y, result: target }],
      starters,
      daily_element_id: target,
    },
    stats: {},
  }
}

const publish = (b: unknown) => call('/lau-meme/api/pipeline/batches', { method: 'POST', body: JSON.stringify(b) })

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
})

describe('publish validation', () => {
  it('rejects a manifest that disagrees with the content or the contract (422, nothing written)', async () => {
    type B = Awaited<ReturnType<typeof body>>
    const cases: Array<(b: B) => void> = [
      (b) => (b.manifest.graph_url = '/api/graph/999'),
      (b) => (b.manifest.batch_at = '2026-10-21T05:30:00.000Z'),
      (b) => (b.manifest.starters[0]!.name = 'Tên Khác'),
      (b) => b.manifest.starters.pop(),
      (b) => (b.manifest.miss_lines = []),
      (b) => (b.manifest.daily.element_id = b.content.starters[0]!),
      (b) => (b.manifest.daily.depth = 9),
      (b) => ((b.manifest.daily as Record<string, unknown>).name = 'Tên Khác'),
      (b) => ((b.manifest as Record<string, unknown>).extra = 1),
    ]
    for (const [i, mutate] of cases.entries()) {
      const b = await body(500 + i)
      mutate(b)
      const res = await publish(b)
      expect(res.status, `case ${i}`).toBe(422)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM batch_content').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it('stores only the validated manifest fields', async () => {
    expect((await publish(await body(600))).status).toBe(201)
    const res = await call('/lau-meme/api/manifest')
    const manifest = (await res.json()) as Record<string, unknown>
    expect(Object.keys(manifest).sort()).toEqual(
      ['batch_at', 'daily', 'graph_url', 'miss_lines', 'policy_version', 'starters', 'version'].sort(),
    )
  })

  it('serves the graph from one cache entry whatever the query string', async () => {
    expect((await publish(await body(700))).status).toBe(201)
    expect((await call('/lau-meme/api/graph/700?x=1')).status).toBe(200)
    await env.DB.prepare('DELETE FROM batch_content').run()
    const again = await call('/lau-meme/api/graph/700?x=2')
    expect(again.status).toBe(200)
    expect(again.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})
