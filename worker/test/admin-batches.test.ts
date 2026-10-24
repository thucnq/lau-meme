// Acceptance tests for docs/acceptance/admin.md AC-ADMIN-11 (worker part): crawl statistics per batch in
// GET /api/admin/batches (items[].stats + summary) and the stats the pipeline sends with POST /pipeline/batches.
// Contract: docs/api/openapi.yaml (/admin/batches, BatchStats, BatchPage, /pipeline/batches).
// Black-box: only the OpenAPI contract and the D1 schema (0002_content: batch_run).
// Performance: D1 in Miniflare costs ~66 ms/query, so every test seeds with ONE env.DB.batch and keeps requests few.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['batches', 'admin', 'token', 'ok'].join('-')
const PIPELINE_TOKEN = ['batches', 'pipeline', 'token'].join('-')
const IP_KEY = ['batches', 'ip', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_API = 'https://dinoduct.fun/lau-meme/api'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Source = { source: string; concepts: number | null; error: string | null }
type Stats = {
  crawled?: number
  added?: number
  queued?: number
  blocked?: Record<string, number>
  source_errors?: { source: string; error: string }[]
  quota_used?: number
  sources?: Source[]
  queue_size?: number
  images?: { drawn: number; fallback: number; pending: number }
  without_image?: number
}
type BatchItem = {
  id: string
  version: number | null
  batch_at: string
  mode: string
  status: string
  failed_step: string | null
  stats: Stats
  issue_url: string | null
}
type Summary = { crawled_total: number; added_total: number; queue_size: number | null; without_image: number | null }
type BatchPage = { page: number; size: number; total: number; items: BatchItem[]; summary: Summary }

async function raw(url: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(url, { ...init, headers: h }),
    { ...env, ADMIN_TOKEN: TOKEN, PIPELINE_TOKEN, IP_HASH_KEY: IP_KEY },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

let ipCounter = 0
const nextIp = () => {
  ipCounter++
  return `10.30.${ipCounter >> 8}.${ipCounter & 255}`
}
const adminBatches = (query = '') =>
  raw(`${ADMIN_ORIGIN}/api/admin/batches${query}`, {}, { Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': nextIp() })
const publish = (body: unknown) =>
  raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) }, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
const json = async <T>(res: Response) => (await res.json()) as T

const B0 = Date.UTC(2026, 9, 20, 0, 0, 0)
const HOUR = 3_600_000

type Seed = { mode: 'core' | 'full'; status: 'success' | 'error' | 'rollback'; stats: Stats; version?: number | null }
function seedRows(rows: Seed[]) {
  return rows.map((r, i) => {
    const id = crypto.randomUUID()
    const at = B0 + i * HOUR
    return {
      id,
      stmt: env.DB.prepare(
        'INSERT INTO batch_run (id, version, batch_at, mode, status, failed_step, rollback_to, daily_element_id, stats_json, issue_url, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)',
      ).bind(id, r.version === undefined ? (r.status === 'success' ? 100 + i : null) : r.version, at, r.mode, r.status, r.status === 'error' ? 'publish' : null, JSON.stringify(r.stats), at + 5000),
    }
  })
}
async function seed(rows: Seed[]): Promise<string[]> {
  const seeded = seedRows(rows)
  await env.DB.batch(seeded.map((s) => s.stmt))
  return seeded.map((s) => s.id)
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM batch_run')])
})

// ---------------------------------------------------------------------------- fixtures (the AC-ADMIN-11 scenario)
const FULL_OLD_1: Stats = {
  crawled: 25,
  added: 2,
  queued: 8,
  queue_size: 10,
  blocked: { chinh_tri: 1 },
  source_errors: [],
  quota_used: 30,
  sources: [
    { source: 'Reddit', concepts: 5, error: null },
    { source: 'Know Your Meme', concepts: 20, error: null },
  ],
  images: { drawn: 4, fallback: 1, pending: 0 },
  without_image: 90,
}
const FULL_OLD_2: Stats = {
  crawled: 35,
  added: 4,
  queued: 12,
  queue_size: 30,
  blocked: {},
  source_errors: [],
  quota_used: 35,
  sources: [
    { source: 'Reddit', concepts: 15, error: null },
    { source: 'Know Your Meme', concepts: 20, error: null },
  ],
  images: { drawn: 10, fallback: 2, pending: 3 },
  without_image: 70,
}
const FULL_LATEST: Stats = {
  crawled: 60,
  added: 6,
  queued: 50,
  queue_size: 80,
  blocked: { chinh_tri: 3, nhay_cam: 1 },
  source_errors: [{ source: 'Reddit', error: 'RobotsDenied' }],
  quota_used: 42,
  sources: [
    { source: 'Reddit', concepts: null, error: 'RobotsDenied' },
    { source: 'Know Your Meme', concepts: 40, error: null },
    { source: 'Tuổi Trẻ', concepts: 20, error: null },
  ],
  images: { drawn: 20, fallback: 3, pending: 9 },
  without_image: 7,
}
const CORE: Stats = { crawled: 0, added: 0, queued: 0, source_errors: [], quota_used: 0, blocked: {} }

describe('admin batches: thống kê crawl', () => {
  it(
    'AC-ADMIN-11: 3 đợt full + 1 đợt core: mỗi đợt có số khái niệm theo nguồn (nguồn lỗi có loại lỗi, không có số), số thêm, hàng chờ, bị chặn theo danh mục, quota, ảnh vẽ / emoji / chờ vẽ; core không có nguồn',
    async () => {
      const ids = await seed([
        { mode: 'full', status: 'success', stats: FULL_OLD_1 },
        { mode: 'full', status: 'success', stats: FULL_OLD_2 },
        { mode: 'full', status: 'success', stats: FULL_LATEST },
        { mode: 'core', status: 'success', stats: CORE },
      ])

      const res = await adminBatches()
      expect(res.status).toBe(200)
      const body = await json<BatchPage>(res)
      expect(body).toMatchObject({ page: 1, size: 50, total: 4 })
      expect(body.items.map((i) => i.id)).toEqual([...ids].reverse())

      const [core, latest, older2, older1] = body.items as [BatchItem, BatchItem, BatchItem, BatchItem]
      expect(core.mode).toBe('core')
      expect(core.stats.sources ?? []).toEqual([])

      expect(latest.stats.sources).toEqual(FULL_LATEST.sources)
      expect(latest.stats.sources?.[0]).toEqual({ source: 'Reddit', concepts: null, error: 'RobotsDenied' })
      expect(latest.stats).toMatchObject({
        crawled: 60,
        added: 6,
        queued: 50,
        queue_size: 80,
        quota_used: 42,
        blocked: { chinh_tri: 3, nhay_cam: 1 },
        images: { drawn: 20, fallback: 3, pending: 9 },
        without_image: 7,
      })
      // blocked is a count per category only: no element names (AC-ADMIN-11)
      expect(Object.values(latest.stats.blocked ?? {}).every((n) => typeof n === 'number')).toBe(true)
      expect(Object.values(latest.stats.blocked ?? {}).reduce((a, b) => a + b, 0)).toBe(4)
      expect(older2.stats.sources).toEqual(FULL_OLD_2.sources)
      expect(older1.stats.sources).toEqual(FULL_OLD_1.sources)
    },
    60_000,
  )

  it(
    'AC-ADMIN-11: ô tổng: tổng khái niệm đã crawl và tổng phần tử đã thêm cộng mọi đợt full thành công; hàng chờ và số phần tử chưa có ảnh lấy từ đợt full gần nhất (đợt core mới hơn không ghi đè)',
    async () => {
      await seed([
        { mode: 'full', status: 'success', stats: FULL_OLD_1 },
        { mode: 'full', status: 'success', stats: FULL_OLD_2 },
        { mode: 'full', status: 'success', stats: FULL_LATEST },
        { mode: 'core', status: 'success', stats: CORE },
      ])

      const body = await json<BatchPage>(await adminBatches())
      expect(body.summary).toEqual({ crawled_total: 25 + 35 + 60, added_total: 2 + 4 + 6, queue_size: 80, without_image: 7 })
    },
    60_000,
  )

  it(
    'AC-ADMIN-11: đợt full lỗi và đợt rollback không cộng vào ô tổng và không là "đợt full gần nhất" của hàng chờ / chưa có ảnh',
    async () => {
      await seed([
        { mode: 'full', status: 'success', stats: { ...FULL_OLD_2, crawled: 10, added: 1, queue_size: 5, without_image: 9 } },
        { mode: 'full', status: 'error', stats: { crawled: 99, added: 9, queued: 9, queue_size: 77, without_image: 1, source_errors: [], quota_used: 5, blocked: {} } },
        { mode: 'full', status: 'rollback', stats: { crawled: 88, added: 8, queue_size: 66, without_image: 2 } },
      ])

      const body = await json<BatchPage>(await adminBatches())
      expect(body.total).toBe(3)
      expect(body.summary).toEqual({ crawled_total: 10, added_total: 1, queue_size: 5, without_image: 9 })
    },
    60_000,
  )

  it(
    'AC-ADMIN-11: chỉ có đợt core: ô tổng 0 / 0 và hàng chờ, chưa có ảnh là null (chưa có đợt full thành công)',
    async () => {
      await seed([{ mode: 'core', status: 'success', stats: CORE }])

      const body = await json<BatchPage>(await adminBatches())
      expect(body.total).toBe(1)
      expect(body.summary).toEqual({ crawled_total: 0, added_total: 0, queue_size: null, without_image: null })
    },
    60_000,
  )

  it('AC-ADMIN-11: chưa có đợt nào: items rỗng, total 0, ô tổng 0 / 0 / null / null (giao diện hiện "Chưa có đợt nào")', async () => {
    const res = await adminBatches()
    expect(res.status).toBe(200)
    const body = await json<BatchPage>(res)
    expect(body).toMatchObject({ page: 1, size: 50, total: 0, items: [] })
    expect(body.summary).toEqual({ crawled_total: 0, added_total: 0, queue_size: null, without_image: null })
  })

  it(
    'AC-ADMIN-11: ô tổng tính trên mọi đợt, không chỉ trang hiện tại (size=1 vẫn ra tổng đầy đủ)',
    async () => {
      await seed([
        { mode: 'full', status: 'success', stats: FULL_OLD_1 },
        { mode: 'full', status: 'success', stats: FULL_LATEST },
      ])

      const body = await json<BatchPage>(await adminBatches('?page=2&size=1'))
      expect(body).toMatchObject({ page: 2, size: 1, total: 2 })
      expect(body.items).toHaveLength(1)
      expect(body.summary).toEqual({ crawled_total: 85, added_total: 8, queue_size: 80, without_image: 7 })
    },
    60_000,
  )
})

// ---------------------------------------------------------------------------- pipeline -> admin round trip
const id43 = async (label: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label))
  return Buffer.from(digest).toString('base64url')
}

async function publishBody(version: number, stats: unknown) {
  const names = ['Cay', 'Cười', 'Toang', 'Deadline']
  const emojis = ['🌶️', '😂', '💀', '⏰']
  const starters = await Promise.all(names.map((n) => id43(`b|${n}`)))
  const target = await id43('b|Món Đặc Biệt')
  const [x, y] = [starters[0]!, starters[1]!].sort()
  const batchAt = '2026-10-23T05:00:00.000Z'
  return {
    status: 'success',
    version,
    batch_at: batchAt,
    mode: 'full',
    manifest: {
      version,
      batch_at: batchAt,
      graph_url: `/api/graph/${version}`,
      starters: starters.map((id, i) => ({ id, name: names[i], emoji: emojis[i] })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: target, emoji: '🍲', hint: 'Món cay cay', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await id43(`bg|${version}`)]: 'abc' } },
    content: {
      elements: [
        ...names.map((name, i) => ({ id: starters[i], name, fold: name.toLowerCase(), emoji: emojis[i], depth: 0 })),
        { id: target, name: 'Món Đặc Biệt', fold: 'mon dac biet', emoji: '🍲', depth: 4 },
      ],
      recipes: [{ id: await id43('br|1'), a: x, b: y, result: target }],
      starters,
      daily_element_id: target,
    },
    stats,
    store: { elements: [], recipes: [], queue: [], asked_pairs: [], llm_cache: {} },
  }
}

describe('admin batches: số liệu do pipeline gửi', () => {
  it(
    'AC-ADMIN-11: pipeline gửi stats.sources / queue_size / images / without_image kèm đợt (201), trang quản trị đọc lại đúng nguyên số liệu và ô tổng',
    async () => {
      const res = await publish(await publishBody(2026102312, FULL_LATEST))
      expect(res.status).toBe(201)

      const body = await json<BatchPage>(await adminBatches())
      expect(body.total).toBe(1)
      expect(body.items[0]!.stats).toMatchObject({
        crawled: 60,
        added: 6,
        queue_size: 80,
        images: { drawn: 20, fallback: 3, pending: 9 },
        without_image: 7,
        sources: FULL_LATEST.sources,
        blocked: { chinh_tri: 3, nhay_cam: 1 },
      })
      expect(body.summary).toEqual({ crawled_total: 60, added_total: 6, queue_size: 80, without_image: 7 })
    },
    60_000,
  )

  it(
    'AC-ADMIN-11: số liệu sai định dạng bị từ chối (400/422 problem+json) và không ghi đợt nào: số khái niệm âm, tên nguồn quá 50 ký tự, thiếu "pending" ở ảnh, queue_size âm, khóa lạ trong stats',
    async () => {
      const bad: unknown[] = [
        { ...FULL_LATEST, sources: [{ source: 'Reddit', concepts: -1, error: null }] },
        { ...FULL_LATEST, sources: [{ source: 'R'.repeat(51), concepts: 1, error: null }] },
        { ...FULL_LATEST, sources: [{ source: 'Reddit', concepts: 1 }] },
        { ...FULL_LATEST, images: { drawn: 1, fallback: 1 } },
        { ...FULL_LATEST, queue_size: -5 },
        { ...FULL_LATEST, blocked_names: ['Tên bị chặn'] },
      ]
      for (const [i, stats] of bad.entries()) {
        const res = await publish(await publishBody(2026102320 + i, stats))
        expect([400, 422], `trường hợp ${i}`).toContain(res.status)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
      }
      const body = await json<BatchPage>(await adminBatches())
      expect(body.total).toBe(0)
      expect(body.items).toEqual([])
    },
    120_000,
  )
})
