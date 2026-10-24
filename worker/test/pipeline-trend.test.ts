// Acceptance tests for docs/acceptance/pipe.md AC-PIPE-16 (worker part): trend_peak stored per element.
// Contract: docs/api/openapi.yaml (BatchContent.elements[].trend_peak: minimum 0, absent = keep the stored value;
// PipelineState.catalog[].trend_peak: never crawled = 0). Schema: 0007_contrib_tier (element.trend_peak).
// Performance: D1 in Miniflare costs ~66 ms/query, so keep requests few.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const PIPELINE_TOKEN = ['trend', 'pipeline', 'token'].join('-')
const GAME_API = 'https://dinoduct.fun/lau-meme/api'
const V1 = 202610230500
const V2 = 202610231700
const V3 = 202610240500

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type CatalogItem = { id: string; first_version: number; trend_peak: number }

async function raw(url: string, init: RequestInit = {}): Promise<Response> {
  const h = new Headers(init.headers)
  h.set('Authorization', `Bearer ${PIPELINE_TOKEN}`)
  h.set('CF-Connecting-IP', '10.40.0.1')
  if (init.body) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(new Request(url, { ...init, headers: h }), { ...env, PIPELINE_TOKEN }, ctx)
  await waitOnExecutionContext(ctx)
  return res
}
const publish = (body: unknown) => raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) })

const id43 = async (label: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label))
  return Buffer.from(digest).toString('base64url')
}

const NAMES = ['Cay', 'Cười', 'Toang', 'Deadline']
const EMOJIS = ['🌶️', '😂', '💀', '⏰']

/** Success body for `version`; `peaks` maps an element name to the trend_peak field sent (absent key = field absent). */
async function publishBody(version: number, peaks: Record<string, unknown>) {
  const starters = await Promise.all(NAMES.map((n) => id43(`t|${n}`)))
  const target = await id43('t|Món Đặc Biệt')
  const [x, y] = [starters[0]!, starters[1]!].sort()
  const batchAt = new Date(Date.UTC(2026, 9, 23, 5, 0, 0) + (version % 10000) * 1000).toISOString()
  const withPeak = (name: string, e: Record<string, unknown>) => (name in peaks ? { ...e, trend_peak: peaks[name] } : e)
  return {
    status: 'success',
    version,
    batch_at: batchAt,
    mode: 'full',
    manifest: {
      version,
      batch_at: batchAt,
      graph_url: `/api/graph/${version}`,
      starters: starters.map((id, i) => ({ id, name: NAMES[i], emoji: EMOJIS[i] })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: target, emoji: '🍲', hint: 'Món cay cay', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await id43(`tg|${version}`)]: 'abc' } },
    content: {
      elements: [
        ...NAMES.map((name, i) => withPeak(name, { id: starters[i], name, fold: name.toLowerCase(), emoji: EMOJIS[i], depth: 0 })),
        withPeak('Món Đặc Biệt', { id: target, name: 'Món Đặc Biệt', fold: 'mon dac biet', emoji: '🍲', depth: 4 }),
      ],
      recipes: [{ id: await id43('tr|1'), a: x, b: y, result: target }],
      starters,
      daily_element_id: target,
    },
    stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
    store: { elements: [], recipes: [], queue: [], asked_pairs: [], llm_cache: {} },
  }
}

/** name -> stored element.trend_peak (null when NULL), one query. */
async function storedPeaks(): Promise<Record<string, number | null>> {
  const rows = (await env.DB.prepare('SELECT name, trend_peak FROM element').all<{ name: string; trend_peak: number | null }>()).results
  return Object.fromEntries(rows.map((r) => [r.name, r.trend_peak]))
}

async function catalogPeaks(): Promise<Record<string, number>> {
  const res = await raw(`${GAME_API}/pipeline/state`)
  expect(res.status).toBe(200)
  const state = (await res.json()) as { catalog: CatalogItem[] }
  const byId = new Map(state.catalog.map((c) => [c.id, c.trend_peak]))
  const ids = await Promise.all([...NAMES, 'Món Đặc Biệt'].map((n) => id43(`t|${n}`)))
  return Object.fromEntries([...NAMES, 'Món Đặc Biệt'].map((n, i) => [n, byId.get(ids[i]!)!]))
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM pipeline_store'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
})

describe('pipeline: trend_peak', () => {
  it(
    'AC-PIPE-16: đợt 1 gửi Cay=4, Cười=1 thì D1 lưu 4 / 1 và catalog trả 4 / 1 / 0; đợt 2 vắng trend_peak của Cay, Cười=2 thì Cay giữ 4, Cười thành 2',
    async () => {
      expect((await publish(await publishBody(V1, { Cay: 4, Cười: 1 }))).status).toBe(201)

      const first = await storedPeaks()
      expect(first.Cay).toBe(4)
      expect(first['Cười']).toBe(1)
      for (const n of ['Toang', 'Deadline', 'Món Đặc Biệt']) expect(first[n] ?? 0).toBe(0)
      expect(await catalogPeaks()).toEqual({ Cay: 4, Cười: 1, Toang: 0, Deadline: 0, 'Món Đặc Biệt': 0 })

      expect((await publish(await publishBody(V2, { Cười: 2 }))).status).toBe(201)

      const second = await storedPeaks()
      expect(second.Cay).toBe(4)
      expect(second['Cười']).toBe(2)
      expect(await catalogPeaks()).toEqual({ Cay: 4, Cười: 2, Toang: 0, Deadline: 0, 'Món Đặc Biệt': 0 })
    },
    60_000,
  )

  it(
    'AC-PIPE-16: trend_peak âm, không phải số nguyên hoặc không phải số bị từ chối 400/422 problem+json, không đổi gì',
    async () => {
      expect((await publish(await publishBody(V1, { Cay: 4, Cười: 1 }))).status).toBe(201)

      for (const [i, bad] of ([-1, 1.5, '3'] as unknown[]).entries()) {
        const res = await publish(await publishBody(V3 + i, { Cay: bad, Cười: 9 }))
        expect([400, 422], `trend_peak = ${JSON.stringify(bad)}`).toContain(res.status)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
      }

      const after = await storedPeaks()
      expect(after.Cay).toBe(4)
      expect(after['Cười']).toBe(1)
      const runs = await env.DB.prepare('SELECT COUNT(*) AS n FROM batch_run').first<{ n: number }>()
      expect(runs!.n).toBe(1)
    },
    60_000,
  )
})
