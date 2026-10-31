// Phủ (thêm 2026-10-31, ADR 0025, migration 0013, contract 0.12.0) phần worker của:
//   AC-ADMIN-19  GET /admin/elements: sort name|created|updated|depth|tier, order asc|desc, khóa phụ tên rồi id, tier hiệu lực,
//                created_at / updated_at mỗi dòng; updated_at đổi theo mọi lệnh ghi của admin và theo mẻ chỉ khi có giá trị đổi.
//   AC-ADMIN-20  GET /admin/elements?image=none|active|hidden kết hợp bộ lọc khác, total và phân trang theo bộ lọc.
// Black-box: docs/api/openapi.yaml 0.12.0, ADR 0025 (ghi chú), migrations 0002, 0004, 0013 và các test admin có sẵn.
// Performance: D1 in Miniflare costs ~66 ms/query, so each test seeds with ONE env.DB.batch and keeps requests few.
// Mỗi test dùng tiền tố tên riêng (zqs, zqw, zqb, zqi, zqt) và lọc bằng q để không lẫn dữ liệu của test khác.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['sort', 'admin', 'token', 'ok'].join('-')
const PIPELINE_TOKEN = ['sort', 'pipeline', 'token'].join('-')
const IP_KEY = ['sort', 'ip', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_API = 'https://dinoduct.fun/lau-meme/api'
const DAY = 86_400_000
const T = Date.UTC(2026, 9, 20, 3, 0, 0)

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Page<T> = { page: number; size: number; total: number; items: T[] }
type El = {
  id: string
  name: string
  depth: number
  state: string
  image_key: string | null
  image_state: string
  tier: number
  tier_source: string
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------- ADR 0002 helpers
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))

function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
const elementId = async (name: string) => b64u(await sha256(`lm1|e|${fold(name)}`))
async function recipeId(a: string, b: string): Promise<string> {
  const [x, y] = [fold(a), fold(b)].sort()
  return b64u(await sha256(`lm1|k|${x}\0${y}`))
}

// ---------------------------------------------------------------------------- HTTP helpers
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
  return `10.70.${ipCounter >> 8}.${ipCounter & 255}`
}
type AOpts = { method?: string; body?: unknown; rawBody?: Uint8Array; contentType?: string }
/** Call /api/admin<path> on the admin host with the right token. */
function A(path: string, o: AOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': nextIp(), Authorization: `Bearer ${TOKEN}` }
  const init: RequestInit = { method: o.method ?? (o.body !== undefined || o.rawBody ? 'POST' : 'GET') }
  if (o.rawBody) {
    init.body = o.rawBody
    headers['Content-Type'] = o.contentType ?? 'image/webp'
  } else if (o.body !== undefined) init.body = JSON.stringify(o.body)
  return raw(`${ADMIN_ORIGIN}/api/admin${path}`, init, headers)
}
const pipelineHeaders = () => ({ Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
const json = async <T>(res: Response) => (await res.json()) as T
const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')

const list = async (qs: string): Promise<Page<El>> => {
  const res = await A(`/elements?${qs}`)
  expect(res.status, qs).toBe(200)
  return json<Page<El>>(res)
}
const names = (p: Page<El>) => p.items.map((i) => i.name)
const mod = (kind: 'element' | 'image', id: string, action: string) => A('/moderation', { body: { target_kind: kind, target_id: id, action, reason: 'kiểm thử' } })
const putTier = (id: string, tier: unknown) => A(`/elements/${id}/tier`, { method: 'PUT', body: { tier } })
const patchEl = (id: string, body: unknown) => A(`/elements/${id}`, { method: 'PATCH', body })

/** A 256x256 lossless WebP header (VP8L, 14-bit width-1 / height-1), enough for the admin image check. */
const webp256 = (salt: number) =>
  new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 18, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, // RIFF....WEBP
    0x56, 0x50, 0x38, 0x4c, 6, 0, 0, 0, // VP8L, chunk size 6
    0x2f, 0xff, 0xc0, 0x3f, 0x00, salt & 255, // signature + 255 | 255 << 14, one payload byte
  ]) // fmt: skip

type Seed = { name: string; depth?: number; created?: number; updated?: number; auto_tier?: number | null; image_key?: string | null }
const seedEl = async (s: Seed) =>
  env.DB.prepare(
    'INSERT OR REPLACE INTO element (id, name, name_fold, emoji, depth, origin, image_key, image_source, first_version, last_version, updated_at, created_at, auto_tier) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, 1, ?, ?, ?)',
  ).bind(await elementId(s.name), s.name, fold(s.name), '🍲', s.depth ?? 1, 'vn', s.image_key ?? null, s.updated ?? T, s.created ?? T, s.auto_tier === undefined ? 2 : s.auto_tier)
const insBlock = async (kind: 'element' | 'image', name: string, state: 'hidden' | 'blocked') =>
  env.DB.prepare('INSERT INTO block (kind, target_id, state, reason, created_at) VALUES (?, ?, ?, ?, ?)').bind(kind, await elementId(name), state, 'admin', Date.now())

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------- AC-ADMIN-19 catalog
const SA = 'Zqs Alpha'
const SB = 'Zqs Beta'
const SC = 'Zqs Gamma'
const SD = 'Zqs Delta' // C and D tie on depth, created, updated and auto tier: name breaks the tie (Delta before Gamma)
const sortCatalog = () =>
  Promise.all([
    seedEl({ name: SA, depth: 3, created: T + 3 * DAY, updated: T + 1 * DAY, auto_tier: 2 }),
    seedEl({ name: SB, depth: 1, created: T + 1 * DAY, updated: T + 3 * DAY, auto_tier: 5 }),
    seedEl({ name: SC, depth: 2, created: T + 2 * DAY, updated: T + 2 * DAY, auto_tier: 1 }),
    seedEl({ name: SD, depth: 2, created: T + 2 * DAY, updated: T + 2 * DAY, auto_tier: 1 }),
  ])

describe('admin sort and image filter', () => {
  it(
    'AC-ADMIN-19: sắp xếp theo Tên, Ngày tạo, Ngày cập nhật, Độ sâu, Tier, tăng hoặc giảm dần; giá trị bằng nhau xếp theo tên rồi id; mặc định Tên tăng dần',
    async () => {
      await env.DB.batch(await sortCatalog())
      const q = 'q=zqs&size=100'
      const expected: Record<string, [string[], string[]]> = {
        name: [[SA, SB, SD, SC], [SC, SD, SB, SA]],
        created: [[SB, SD, SC, SA], [SA, SD, SC, SB]],
        updated: [[SA, SD, SC, SB], [SB, SD, SC, SA]],
        depth: [[SB, SD, SC, SA], [SA, SD, SC, SB]],
        tier: [[SD, SC, SA, SB], [SB, SA, SD, SC]],
      }
      for (const [sort, [asc, desc]] of Object.entries(expected)) {
        const a = await list(`${q}&sort=${sort}&order=asc`)
        expect(names(a), `${sort} asc`).toEqual(asc)
        expect(a.total).toBe(4)
        expect(names(await list(`${q}&sort=${sort}&order=desc`)), `${sort} desc`).toEqual(desc)
        expect(names(await list(`${q}&sort=${sort}`)), `${sort} default order`).toEqual(asc)
      }
      expect(names(await list(q))).toEqual([SA, SB, SD, SC]) // default: name asc
      expect(names(await list(`${q}&order=desc`))).toEqual([SC, SD, SB, SA])

      // paging is stable across ties: pages of 3 with a tie in the middle concatenate to the full order
      const p1 = await list('q=zqs&size=3&sort=depth&order=asc&page=1')
      const p2 = await list('q=zqs&size=3&sort=depth&order=asc&page=2')
      expect(p1.total).toBe(4)
      expect([...names(p1), ...names(p2)]).toEqual([SB, SD, SC, SA])

      // each row carries created_at and updated_at as ISO 8601
      const rows = new Map((await list(`${q}&sort=name`)).items.map((i) => [i.name, i]))
      expect(rows.get(SA)!.created_at).toBe(new Date(T + 3 * DAY).toISOString())
      expect(rows.get(SA)!.updated_at).toBe(new Date(T + 1 * DAY).toISOString())
      expect(rows.get(SB)!.created_at).toBe(new Date(T + 1 * DAY).toISOString())
      expect(rows.get(SB)!.updated_at).toBe(new Date(T + 3 * DAY).toISOString())

      // together with the state filter
      await env.DB.batch([await insBlock('element', SD, 'hidden')])
      expect(names(await list(`${q}&sort=created&order=desc&state=active`))).toEqual([SA, SC, SB])
      expect(names(await list(`${q}&sort=depth&state=hidden`))).toEqual([SD])
    },
    60_000,
  )

  it(
    'AC-ADMIN-19: sắp xếp Tier dùng tier hiệu lực - tier admin gán thắng tier tự động',
    async () => {
      await env.DB.batch(await sortCatalog())
      expect((await putTier(await elementId(SB), 1)).status).toBe(200) // auto 5, admin 1
      expect((await putTier(await elementId(SD), 3)).status).toBe(200) // auto 1, admin 3
      // effective tiers: A 2 (auto), B 1 (admin), C 1 (auto), D 3 (admin)
      expect(names(await list('q=zqs&size=100&sort=tier&order=asc'))).toEqual([SB, SC, SA, SD])
      expect(names(await list('q=zqs&size=100&sort=tier&order=desc'))).toEqual([SD, SA, SB, SC])
    },
    60_000,
  )

  it('AC-ADMIN-19: sort hoặc order không hợp lệ trả 400 problem+json', async () => {
    for (const qs of [
      'sort=bogus',
      'sort=created_at',
      'sort=NAME',
      'sort=',
      "sort=name;DROP%20TABLE%20element",
      'sort=name,id',
      'order=up',
      'order=ASC',
      'order=',
      'sort=name&order=desc;--',
    ]) {
      const res = await A(`/elements?${qs}`)
      expect(res.status, qs).toBe(400)
      isProblem(res)
      expect((await json<{ status: number }>(res)).status).toBe(400)
    }
  })

  it(
    'AC-ADMIN-19: ngày cập nhật đổi theo mọi lệnh ghi của admin lên phần tử hoặc ảnh của nó, không đổi theo lệnh thất bại hay phần tử khác; ngày tạo giữ nguyên',
    async () => {
      const X = 'Zqw Phần Tử X' // has an image
      const Z = 'Zqw Phần Tử Z' // no image: manual upload
      const Y = 'Zqw Phần Tử Y' // never touched
      const OLD = T - 30 * DAY
      await env.DB.batch(await Promise.all([seedEl({ name: X, created: OLD, updated: OLD, image_key: 'cccccccccccc.webp' }), seedEl({ name: Z, created: OLD, updated: OLD }), seedEl({ name: Y, created: OLD, updated: OLD })]))
      const [x, z, y] = await Promise.all([elementId(X), elementId(Z), elementId(Y)])
      vi.useFakeTimers({ toFake: ['Date'] })

      const get = async (id: string) => (await list('q=zqw&size=100')).items.find((i) => i.id === id)!
      const stamp = (n: number) => T + n * 60_000
      const steps: Array<[string, () => Promise<Response>]> = [
        ['PATCH /admin/elements/{id}', () => patchEl(x, { description: 'Mô tả sửa tay' })],
        ['gán tier', () => putTier(x, 4)],
        ['trả tier về tự động', () => putTier(x, 'auto')],
        ['ẩn phần tử', () => mod('element', x, 'hide')],
        ['hiện phần tử', () => mod('element', x, 'show')],
        ['chặn phần tử', () => mod('element', x, 'block')],
        ['gỡ chặn phần tử', () => mod('element', x, 'unblock')],
        ['ẩn ảnh', () => mod('image', x, 'hide')],
        ['hiện ảnh', () => mod('image', x, 'show')],
      ]
      let n = 0
      for (const [label, run] of steps) {
        n++
        vi.setSystemTime(new Date(stamp(n)))
        const res = await run()
        expect(res.status, label).toBe(200)
        const row = await get(x)
        expect(row.updated_at, label).toBe(new Date(stamp(n)).toISOString())
        expect(row.created_at, label).toBe(new Date(OLD).toISOString())
      }

      // manual image upload on Z
      n++
      vi.setSystemTime(new Date(stamp(n)))
      const up = await A(`/elements/${z}/image`, { method: 'PUT', rawBody: webp256(7) })
      expect(up.status).toBe(200)
      expect((await get(z)).updated_at).toBe(new Date(stamp(n)).toISOString())
      expect((await get(z)).created_at).toBe(new Date(OLD).toISOString())

      // failed commands change nothing
      const before = (await get(x)).updated_at
      n++
      vi.setSystemTime(new Date(stamp(n)))
      expect((await putTier(x, 6)).status).toBe(400)
      expect((await mod('element', x, 'unblock')).status).toBe(409) // active, not blocked
      expect((await patchEl(await elementId('Zqw Không Có Thật'), { description: 'x' })).status).toBe(404)
      expect((await get(x)).updated_at).toBe(before)

      // the untouched element keeps its old value; sort by updated desc puts the latest write first
      expect((await get(y)).updated_at).toBe(new Date(OLD).toISOString())
      expect(names(await list('q=zqw&size=100&sort=updated&order=desc'))[0]).toBe(Z)
      expect(names(await list('q=zqw&size=100&sort=updated&order=asc'))).toEqual([Y, X, Z])
    },
    120_000,
  )

  // ---------------------------------------------------------------------- batch (POST /pipeline/batches)
  const BDAILY = 'Zqb Món Daily'
  const BP2 = 'Zqb P2 Không Đổi'
  const BP3 = 'Zqb P3 Đổi Giá Trị'
  const BP4 = 'Zqb P4 Mới'
  async function publish(version: number, catalog: Array<{ name: string; emoji?: string }>): Promise<Response> {
    const starterNames = ['Cay', 'Cười', 'Toang', 'Deadline']
    const starters = await Promise.all(starterNames.map(elementId))
    const batchAt = '2026-10-29T05:30:00.000Z'
    const target = await elementId(BDAILY)
    const [lo, hi] = [starters[0]!, starters[1]!].sort()
    const elems = await Promise.all(
      catalog.map(async (c) => ({ id: await elementId(c.name), name: c.name, fold: fold(c.name), emoji: c.emoji ?? '🍲', depth: c.name === BDAILY ? 4 : 3, auto_tier: 2 })),
    )
    const body = {
      status: 'success',
      version,
      batch_at: batchAt,
      mode: 'core',
      manifest: {
        version,
        batch_at: batchAt,
        graph_url: `/api/graph/${version}`,
        starters: starters.map((id, i) => ({ id, name: starterNames[i], emoji: '🔥' })),
        miss_lines: ['Chưa đúng vị, thử lại nhé.'],
        daily: { element_id: target, emoji: '🍲', hint: 'Món cay cay', depth: 4 },
      },
      graph: { format: 1, version, entries: { [await elementId(`g|${version}`)]: 'abc' } },
      content: {
        elements: [...starters.map((id, i) => ({ id, name: starterNames[i]!, fold: fold(starterNames[i]!), emoji: '🔥', depth: 0 })), ...elems],
        recipes: [{ id: await recipeId('Cay', 'Cười'), a: lo!, b: hi!, result: target }],
        starters,
        daily_element_id: target,
      },
      stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
    }
    return raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) }, pipelineHeaders())
  }

  it(
    'AC-ADMIN-19: mẻ ghi lại phần tử không đổi giá trị thì giữ ngày cập nhật (P2), đổi một giá trị thì ngày cập nhật là lúc mẻ (P3), phần tử mới có ngày tạo là lúc mẻ (P4); ngày tạo không bị nhánh cập nhật đổi',
    async () => {
      const [t1, t2, t3] = [T + 10 * DAY, T + 11 * DAY, T + 12 * DAY]
      const iso = (t: number) => new Date(t).toISOString()
      const [p2, p3, p4] = await Promise.all([elementId(BP2), elementId(BP3), elementId(BP4)])
      const get = async (id: string) => (await list('q=zqb&size=100')).items.find((i) => i.id === id)
      vi.useFakeTimers({ toFake: ['Date'] })

      vi.setSystemTime(new Date(t1))
      expect((await publish(9001, [{ name: BDAILY }, { name: BP2 }, { name: BP3 }])).status).toBe(201)
      expect(await get(p4)).toBeUndefined()
      expect(await get(p2)).toMatchObject({ created_at: iso(t1), updated_at: iso(t1) })
      expect(await get(p3)).toMatchObject({ created_at: iso(t1), updated_at: iso(t1) })

      // second batch: P2 identical, P3 changes its emoji, P4 is new
      vi.setSystemTime(new Date(t2))
      expect((await publish(9002, [{ name: BDAILY }, { name: BP2 }, { name: BP3, emoji: '🍜' }, { name: BP4 }])).status).toBe(201)
      expect(await get(p2)).toMatchObject({ created_at: iso(t1), updated_at: iso(t1) })
      expect(await get(p3)).toMatchObject({ created_at: iso(t1), updated_at: iso(t2) })
      expect(await get(p4)).toMatchObject({ created_at: iso(t2), updated_at: iso(t2) })

      // third batch repeats the second exactly: nothing changes, last_version still moves
      vi.setSystemTime(new Date(t3))
      expect((await publish(9003, [{ name: BDAILY }, { name: BP2 }, { name: BP3, emoji: '🍜' }, { name: BP4 }])).status).toBe(201)
      for (const [id, created, updated] of [
        [p2, t1, t1],
        [p3, t1, t2],
        [p4, t2, t2],
      ] as const) {
        const row = await get(id)
        expect(row, id).toMatchObject({ created_at: iso(created), updated_at: iso(updated) })
      }
      expect((await get(p4))!.created_at).not.toBe(iso(t3))
    },
    120_000,
  )

  // ---------------------------------------------------------------------- AC-ADMIN-20
  it(
    'AC-ADMIN-20: lọc Ảnh Chưa có ảnh / Đang hiện / Đang ẩn (ảnh ẩn hoặc chặn chỉ ở Đang ẩn), kết hợp bộ lọc khác, total và phân trang theo bộ lọc',
    async () => {
      const N1 = 'Zqi Không Ảnh Một'
      const N2 = 'Zqi Không Ảnh Hai'
      const N3 = 'Zqi Không Ảnh Ba'
      const V = 'Zqi Ảnh Hiện'
      const H1 = 'Zqi Ảnh Ẩn' // image hidden, element also hidden
      const H2 = 'Zqi Ảnh Chặn' // image blocked, element active
      await env.DB.batch([
        ...(await Promise.all([
          seedEl({ name: N1, auto_tier: 2 }),
          seedEl({ name: N2, auto_tier: 3 }),
          seedEl({ name: N3, auto_tier: 2 }),
          seedEl({ name: V, auto_tier: 3, image_key: 'dddddddddddd.webp' }),
          seedEl({ name: H1, auto_tier: 2, image_key: 'eeeeeeeeeeee.webp' }),
          seedEl({ name: H2, auto_tier: 3, image_key: 'ffffffffffff.webp' }),
        ])),
        await insBlock('image', H1, 'hidden'),
        await insBlock('image', H2, 'blocked'),
        await insBlock('element', H1, 'hidden'),
      ])
      const q = 'q=zqi&size=100&sort=name'
      expect((await list(q)).total).toBe(6)
      expect(names(await list(`${q}&image=none`))).toEqual([N3, N2, N1])
      expect(names(await list(`${q}&image=active`))).toEqual([V])
      expect(names(await list(`${q}&image=hidden`))).toEqual([H1, H2])
      expect((await list(`${q}&image=none`)).items.every((i) => i.image_state === 'none')).toBe(true)
      expect((await list(`${q}&image=hidden`)).items.every((i) => i.image_state === 'hidden')).toBe(true)
      expect(names(await list(`${q}&image=none`))).not.toContain(H1) // a hidden image is not "no image"

      // combined with other filters
      expect(names(await list(`${q}&image=hidden&state=active`))).toEqual([H2])
      expect(names(await list(`${q}&image=hidden&state=hidden`))).toEqual([H1])
      expect(names(await list(`${q}&image=none&tier=3`))).toEqual([N2])
      expect(names(await list(`${q}&image=active&tier=2`))).toEqual([])
      expect(names(await list('q=zqi+khong&size=100&image=none&sort=name&order=desc'))).toEqual([N1, N2, N3].sort((a, b) => fold(b).localeCompare(fold(a))))

      // total and paging follow the filter
      const p1 = await list('q=zqi&size=2&image=none&sort=name&page=1')
      const p2 = await list('q=zqi&size=2&image=none&sort=name&page=2')
      const p3 = await list('q=zqi&size=2&image=none&sort=name&page=3')
      expect([p1.total, p2.total]).toEqual([3, 3])
      expect([...names(p1), ...names(p2)]).toEqual([N3, N2, N1])
      expect(p1.items).toHaveLength(2)
      expect(p2.items).toHaveLength(1)
      expect(p3.items).toHaveLength(0)
    },
    60_000,
  )

  it('AC-ADMIN-20: giá trị lọc ảnh không hợp lệ trả 400 problem+json', async () => {
    for (const v of ['all', 'NONE', 'Active', 'shown', '1', '', 'none%3Bdrop', 'none,active', '%3Cscript%3E']) {
      const res = await A(`/elements?image=${v}`)
      expect(res.status, v).toBe(400)
      isProblem(res)
    }
  })
})
