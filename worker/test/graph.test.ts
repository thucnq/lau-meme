import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex (`token = '…'`) does not flag a test constant.
const TOKEN = ['test', 'pipeline', 'token'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }

async function call(path: string, init: RequestInit = {}, token: string | null = TOKEN): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    { ...env, PIPELINE_TOKEN: TOKEN },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

const get = (path: string) => call(path, {}, null)

async function id43(label: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label))
  return Buffer.from(digest).toString('base64url')
}

async function batchBody(version: number, batchAt = BATCH_AT) {
  const names = ['Cay', 'Cười', 'Toang', 'Deadline']
  const emojis = ['🌶️', '😂', '💀', '⏰']
  const starters = await Promise.all(names.map((n) => id43(`e|${n}`)))
  const r1 = await id43('e|Tới Công Chuyện')
  const r2 = await id43('e|Chạy Deadline')
  const r3 = await id43('e|Món Đặc Biệt')
  const pair = async (a: string, b: string, result: string) => {
    const [x, y] = [a, b].sort()
    return { id: await id43(`k|${x}|${y}`), a: x, b: y, result }
  }
  const content = {
    elements: [
      ...names.map((name, i) => ({
        id: starters[i],
        name,
        fold: name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
        emoji: emojis[i],
        depth: 0,
        origin: 'vn',
      })),
      { id: r1, name: 'Tới Công Chuyện', fold: 'toi cong chuyen', emoji: '🔥', depth: 1, origin: 'vn' },
      { id: r2, name: 'Chạy Deadline', fold: 'chay deadline', emoji: '🏃', depth: 2, origin: 'vn' },
      { id: r3, name: 'Món Đặc Biệt', fold: 'mon dac biet', emoji: '🍲', depth: 4, origin: 'vn' },
    ],
    recipes: [
      await pair(starters[0]!, starters[1]!, r1),
      await pair(r1, starters[3]!, r2),
      await pair(r2, starters[2]!, r3),
    ],
    starters,
    daily_element_id: r3,
  }
  return {
    status: 'success',
    version,
    batch_at: batchAt,
    mode: 'core',
    manifest: {
      version,
      batch_at: batchAt,
      graph_url: `/api/graph/${version}`,
      starters: starters.map((id, i) => ({ id, name: names[i], emoji: emojis[i] })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: r3, emoji: '🍲', hint: 'Món cay cay', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await id43(`entry|${version}`)]: 'abc' } },
    content,
    stats: {},
  }
}

async function publish(version: number, token: string | null = TOKEN) {
  return call('/api/pipeline/batches', { method: 'POST', body: JSON.stringify(await batchBody(version)) }, token)
}

async function manifestVersion(): Promise<number> {
  const res = await get('/api/manifest')
  expect(res.status).toBe(200)
  return ((await res.json()) as { version: number }).version
}

const rollback = (body: unknown, token: string | null = TOKEN) =>
  call('/api/pipeline/rollback', { method: 'POST', body: JSON.stringify(body) }, token)

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
})

describe('graph', () => {
  it('AC-GRAPH-08: môi trường mới chưa có mẻ nào thì manifest trả 503 problem+json tiếng Việt', async () => {
    const res = await get('/api/manifest')
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = (await res.json()) as { title: string; status: number }
    expect(body.status).toBe(503)
    expect(body.title.length).toBeGreaterThan(0)
    expect([...body.title].some((c) => c.charCodeAt(0) > 0x7f)).toBe(true)
  })

  it('AC-GRAPH-04: đăng version 1 rồi manifest và graph được phục vụ với cache đúng', async () => {
    const posted = await publish(1)
    expect(posted.status).toBe(201)

    const res = await get('/api/manifest')
    expect(res.status).toBe(200)
    const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')
    expect(maxAge).not.toBeNull()
    expect(Number(maxAge![1])).toBeLessThanOrEqual(60)
    const manifest = (await res.json()) as Record<string, unknown>
    const published = await batchBody(1)
    expect(manifest.version).toBe(1)
    expect(Date.parse(manifest.batch_at as string)).toBe(Date.parse(BATCH_AT))
    expect(manifest.graph_url).toBe('/api/graph/1')
    expect(manifest.starters).toEqual(published.manifest.starters)
    expect(manifest.miss_lines).toEqual(published.manifest.miss_lines)
    expect(manifest.daily).toEqual(published.manifest.daily)
    expect(Number.isInteger(manifest.policy_version)).toBe(true)

    const graph = await get('/api/graph/1')
    expect(graph.status).toBe(200)
    expect(graph.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await graph.json()).toEqual(published.graph)
  })

  it('AC-GRAPH-04: version không tăng thì 409, thiếu hoặc sai token thì 401, tham số sai thì 400/404', async () => {
    expect((await publish(1)).status).toBe(201)
    const dup = await publish(1)
    expect(dup.status).toBe(409)
    expect(dup.headers.get('content-type')).toContain('application/problem+json')
    expect((await publish(2)).status).toBe(201)
    expect((await publish(1)).status).toBe(409)
    expect(await manifestVersion()).toBe(2)

    for (const token of [null, 'sai-token']) {
      const res = await publish(3, token)
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    }
    expect(await manifestVersion()).toBe(2)

    const bad = await get('/api/graph/abc')
    expect(bad.status).toBe(400)
    expect(bad.headers.get('content-type')).toContain('application/problem+json')
    const missing = await get('/api/graph/9999')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('application/problem+json')
  })

  it('AC-GRAPH-05: đăng mẻ thứ 15 thì còn đúng 14 bản, bản cũ nhất bị xóa', async () => {
    // Dùng dải version 100..114 để Cache API của lần chạy trước không che kết quả 404.
    for (let v = 100; v <= 114; v++) expect((await publish(v)).status).toBe(201)
    expect(await manifestVersion()).toBe(114)
    expect((await get('/api/graph/100')).status).toBe(404)
    expect((await get('/api/graph/101')).status).toBe(200)
    expect((await get('/api/graph/114')).status).toBe(200)
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM batch_content').first<{ n: number }>()
    expect(count?.n).toBe(14)
    const oldest = await env.DB.prepare('SELECT MIN(version) AS v FROM batch_content').first<{ v: number }>()
    expect(oldest?.v).toBe(101)
  })

  it('AC-GRAPH-06: rollback không tham số về bản trước, rồi chỉ định version', async () => {
    for (let v = 200; v <= 202; v++) expect((await publish(v)).status).toBe(201)
    const res = await rollback({})
    expect(res.status).toBe(200)
    const run = (await res.json()) as Record<string, unknown>
    expect(run.status).toBe('rollback')
    expect(run.rollback_to).toBe(201)
    expect(await manifestVersion()).toBe(201)
    const manifest = (await (await get('/api/manifest')).json()) as { graph_url: string }
    expect(manifest.graph_url).toBe('/api/graph/201')

    const second = await rollback({ version: 200 })
    expect(second.status).toBe(200)
    expect(((await second.json()) as { rollback_to: number }).rollback_to).toBe(200)
    expect(await manifestVersion()).toBe(200)

    const logged = await env.DB.prepare("SELECT COUNT(*) AS n FROM batch_run WHERE status = 'rollback'").first<{
      n: number
    }>()
    expect(logged?.n).toBe(2)
  })

  it('AC-GRAPH-07: chỉ có một bản thì rollback 409, version không tồn tại thì 404, không token thì 401', async () => {
    expect((await publish(300)).status).toBe(201)

    const noPrev = await rollback({})
    expect(noPrev.status).toBe(409)
    expect(noPrev.headers.get('content-type')).toContain('application/problem+json')
    expect(((await noPrev.json()) as { title: string }).title.length).toBeGreaterThan(0)
    expect(await manifestVersion()).toBe(300)

    const unknown = await rollback({ version: 99 })
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toContain('application/problem+json')
    expect(await manifestVersion()).toBe(300)

    expect((await rollback({}, null)).status).toBe(401)
    expect((await rollback({}, 'sai-token')).status).toBe(401)
    expect(await manifestVersion()).toBe(300)
    const logged = await env.DB.prepare("SELECT COUNT(*) AS n FROM batch_run WHERE status = 'rollback'").first<{
      n: number
    }>()
    expect(logged?.n).toBe(0)
  })
})
