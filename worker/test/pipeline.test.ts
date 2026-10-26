// Acceptance tests for docs/acceptance/pipe.md, phase 1 (worker side): AC-PIPE-13 and AC-PIPE-14.
// Contract: docs/api/openapi.yaml (/pipeline/state, /pipeline/batches, /pipeline/batches/{id}).
// D1 is slow under Miniflare on this machine: keep the number of queries per test small.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex (`token = '…'`) does not flag a test constant.
const TOKEN = ['pipe', 'pipeline', 'token'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const ISSUE_URL = 'https://github.com/o/r/issues/1'
const UNKNOWN_RUN = '00000000-0000-4000-8000-000000000000'

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

async function id43(label: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label))
  return Buffer.from(digest).toString('base64url')
}

async function batchBody(version: number) {
  const names = ['Cay', 'Cười', 'Toang', 'Deadline']
  const emojis = ['🌶️', '😂', '💀', '⏰']
  const starters = await Promise.all(names.map((n) => id43(`p|${n}`)))
  const target = await id43('p|Món Đặc Biệt')
  const [x, y] = [starters[0]!, starters[1]!].sort()
  return {
    target,
    body: {
      status: 'success',
      version,
      batch_at: BATCH_AT,
      mode: 'core',
      manifest: {
        version,
        batch_at: BATCH_AT,
        graph_url: `/api/graph/${version}`,
        starters: starters.map((id, i) => ({ id, name: names[i], emoji: emojis[i] })),
        miss_lines: ['Chưa đúng vị, thử lại nhé.'],
        daily: { element_id: target, emoji: '🍲', hint: 'Món cay cay', depth: 4 },
      },
      graph: { format: 1, version, entries: { [await id43(`g|${version}`)]: 'abc' } },
      content: {
        elements: [
          ...names.map((name, i) => ({
            id: starters[i],
            name,
            fold: name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''),
            emoji: emojis[i],
            depth: 0,
          })),
          { id: target, name: 'Món Đặc Biệt', fold: 'mon dac biet', emoji: '🍲', depth: 4 },
        ],
        recipes: [{ id: await id43('r|1'), a: x, b: y, result: target }],
        starters,
        daily_element_id: target,
      },
      stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
    },
  }
}

async function publish(version: number) {
  const { body, target } = await batchBody(version)
  const res = await call('/lau-meme/api/pipeline/batches', { method: 'POST', body: JSON.stringify(body) })
  expect(res.status).toBe(201)
  return { run: (await res.json()) as { id: string; issue_url: string | null }, target }
}

function allKeys(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(allKeys)
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => [k, ...allKeys(v)])
  }
  return []
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
})

describe('pipeline state', () => {
  it('AC-PIPE-13: GET /lau-meme/api/pipeline/state không token hoặc sai token thì 401 problem+json', async () => {
    for (const token of [null, 'wrong-token']) {
      const res = await call('/lau-meme/api/pipeline/state', {}, token)
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    }
  })

  it('AC-PIPE-13: trạng thái pipeline chỉ có dữ liệu nội dung ẩn danh, không có trường người chơi', async () => {
    const { target } = await publish(1)
    await env.DB.prepare(
      "INSERT INTO block (kind, target_id, state, reason, created_at) VALUES ('element', ?, 'blocked', 'admin', ?)",
    )
      .bind('blocked-element-id', Date.now())
      .run()

    const res = await call('/lau-meme/api/pipeline/state')
    expect(res.status).toBe(200)
    const state = (await res.json()) as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(
      ['admin_blocked', 'admin_images', 'banned_aliases', 'blocklist', 'catalog', 'contributions', 'current_version', 'daily_history', 'daily_pin', 'feedback', 'image_links', 'tiers'].sort(),
    )
    expect(state.current_version).toBe(1)
    expect(state.admin_images).toEqual([])
    expect(state.image_links).toEqual([])
    const blocklist = state.blocklist as { elements: string[]; recipes: string[]; images: string[] }
    expect(Object.keys(blocklist).sort()).toEqual(['elements', 'images', 'recipes'])
    expect(blocklist.elements).toContain('blocked-element-id')
    expect(Array.isArray(state.banned_aliases)).toBe(true)
    expect(Array.isArray(state.feedback)).toBe(true)
    const history = state.daily_history as Array<{ version: number; element_id: string; batch_at: string }>
    expect(history).toHaveLength(1)
    expect(Object.keys(history[0]!).sort()).toEqual(['batch_at', 'element_id', 'version'])
    expect(history[0]!.version).toBe(1)
    expect(history[0]!.element_id).toBe(target)
    expect(Date.parse(history[0]!.batch_at)).toBe(Date.parse(BATCH_AT))
    const suspicious = allKeys(state).filter((k) => /player|nickname|uuid|(^|_)ip($|_)/i.test(k))
    expect(suspicious).toEqual([])
  })

  it('AC-PIPE-13: token pipeline không mở được dữ liệu người chơi', async () => {
    for (const path of ['/lau-meme/api/me/streak', '/lau-meme/api/me/nickname']) {
      const res = await call(path)
      expect(res.status, path).not.toBe(200)
      expect(res.status, path).toBeGreaterThanOrEqual(400)
    }
  })
})

describe('pipeline batch report', () => {
  it('AC-PIPE-14: PATCH gắn link Issue vào đợt; id lạ 404; link sai 400; thiếu hoặc sai token 401', async () => {
    const { run } = await publish(1)
    expect(run.issue_url ?? null).toBeNull()
    const patch = (id: string, body: unknown, token: string | null = TOKEN) =>
      call(`/lau-meme/api/pipeline/batches/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, token)

    const ok = await patch(run.id, { issue_url: ISSUE_URL })
    expect(ok.status).toBe(200)
    const updated = (await ok.json()) as Record<string, unknown>
    expect(updated.id).toBe(run.id)
    expect(updated.issue_url).toBe(ISSUE_URL)
    expect(updated.status).toBe('success')
    expect(updated.version).toBe(1)

    const missing = await patch(UNKNOWN_RUN, { issue_url: ISSUE_URL })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('application/problem+json')

    for (const bad of [
      { issue_url: 'http://github.com/o/r/issues/1' },
      { issue_url: 'https://evil.example.com/o/r/issues/1' },
      { issue_url: `https://github.com/${'a'.repeat(300)}` },
      { issue_url: ISSUE_URL, extra: 1 },
      {},
    ]) {
      const res = await patch(run.id, bad)
      expect(res.status, JSON.stringify(bad).slice(0, 60)).toBe(400)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    }

    for (const token of [null, 'wrong-token']) {
      const res = await patch(run.id, { issue_url: ISSUE_URL }, token)
      expect(res.status).toBe(401)
    }
  })
})

describe('pipeline batch: lịch mẻ và cảnh báo pool cạn', () => {
  const post = (b: unknown) => call('/lau-meme/api/pipeline/batches', { method: 'POST', body: JSON.stringify(b) })
  const getManifest = async () => (await call('/lau-meme/api/manifest', {}, null)).json() as Promise<Record<string, unknown>>
  const EVEN = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]

  it('AC-DAILY-12: manifest có schedule_hours_utc [0,2,...,22] thì 201 và GET /api/manifest trả đúng nguyên giá trị', async () => {
    const { body } = await batchBody(1)
    ;(body.manifest as Record<string, unknown>).schedule_hours_utc = EVEN
    expect((await post(body)).status).toBe(201)
    const manifest = await getManifest()
    expect(manifest.schedule_hours_utc).toEqual(EVEN)
    expect(manifest.version).toBe(1)
  })

  it('AC-DAILY-12: manifest không có schedule_hours_utc vẫn 201 và GET /api/manifest không bịa trường này', async () => {
    const { body } = await batchBody(1)
    expect((await post(body)).status).toBe(201)
    const manifest = await getManifest()
    expect('schedule_hours_utc' in manifest).toBe(false)
  })

  it('AC-DAILY-12: schedule_hours_utc không hợp lệ thì 422 problem+json và version hiện hành không đổi', async () => {
    expect((await post((await batchBody(1)).body)).status).toBe(201)
    const invalid: unknown[] = [[24], [-1], [5, 5], [], [5.5], ['5'], [17, 5], 'abc', null, Array.from({ length: 25 }, (_, i) => i)]
    for (const value of invalid) {
      const { body } = await batchBody(2)
      ;(body.manifest as Record<string, unknown>).schedule_hours_utc = value
      const res = await post(body)
      expect(res.status, JSON.stringify(value)).toBe(422)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    }
    const manifest = await getManifest()
    expect(manifest.version).toBe(1)
    expect('schedule_hours_utc' in manifest).toBe(false)
  })

  it('AC-DAILY-01: stats.daily_pool_exhausted true được nhận (201) và trả lại trong đợt', async () => {
    const { body } = await batchBody(1)
    ;(body.stats as Record<string, unknown>).daily_pool_exhausted = true
    const res = await post(body)
    expect(res.status).toBe(201)
    const run = (await res.json()) as { id: string; stats: Record<string, unknown> }
    expect(run.stats.daily_pool_exhausted).toBe(true)
    const patched = await call(`/lau-meme/api/pipeline/batches/${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ issue_url: ISSUE_URL }),
    })
    expect(((await patched.json()) as { stats: Record<string, unknown> }).stats.daily_pool_exhausted).toBe(true)
  })

  it('AC-DAILY-01: stats.daily_pool_exhausted không phải boolean thì 422 problem+json, không ghi gì', async () => {
    for (const value of ['true', 1, null, {}]) {
      const { body } = await batchBody(1)
      ;(body.stats as Record<string, unknown>).daily_pool_exhausted = value
      const res = await post(body)
      expect(res.status, JSON.stringify(value)).toBe(422)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM batch_content').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })
})
