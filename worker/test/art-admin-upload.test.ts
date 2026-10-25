// Phủ (thêm 2026-10-25, ADR 0016, migration 0008 `element.image_source` + `admin_image_change`):
//   AC-ART-13  PUT /admin/elements/{id}/image (adminPutElementImage): thân image/webp <= 1 MB, chữ ký RIFF/WEBP, 256x256 đọc từ
//              header VP8 / VP8L / VP8X; hợp lệ -> 200 {element_id, before_key, after_key}, R2 `img/<12 hex SHA-256>.webp`,
//              GET /img/<key> phục vụ, danh sách "Nội dung" hiện image_key + image_source 'admin', audit `set_image`
//              (before/after {image_key}), /pipeline/state.admin_images; sai định dạng / sai cỡ / quá 1 MB -> 400 problem+json,
//              không đổi gì, không audit (AC-ADMIN-09); phần tử lạ -> 404; thiếu/sai token -> 401; mẻ đăng sau giữ khóa ảnh admin.
//   AC-ART-VALIDATION, AC-ART-ABUSE (cho endpoint này).
// Black-box: docs/api/openapi.yaml (PUT /admin/elements/{id}/image, GET /admin/elements, GET /admin/audit, GET /pipeline/state
// `admin_images`, POST /pipeline/batches), ADR 0002 ids, ADR 0016, migrations 0002_content, 0004_ops, 0008.
// Performance: D1 in Miniflare costs ~66 ms/query, so tests seed with ONE env.DB.batch and combine assertions per case.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['art', 'admin', 'token', 'ok'].join('-')
const WRONG = ['art', 'admin', 'token', 'no'].join('-')
const PIPELINE_TOKEN = ['art', 'pipeline', 'token'].join('-')
const IP_KEY = ['art', 'ip', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_ORIGIN = 'https://dinoduct.fun'
const GAME_API = `${GAME_ORIGIN}/lau-meme/api`
const MAX_BYTES = 1048576

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Row = Record<string, unknown>
type Page<T> = { page: number; size: number; total: number; items: T[] }
type ElementItem = { id: string; name: string; image_key: string | null; image_state: string; image_source: 'ai' | 'admin' | null }
type AuditItem = { action: string; target_kind: string; target_id: string; before: unknown; after: unknown; token_fp: string; created_at: string }
type ImageResult = { element_id: string; before_key: string | null; after_key: string }
type Bucket = {
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  delete(key: string): Promise<void>
}
const R2 = (env as unknown as { IMG: Bucket }).IMG

// ---------------------------------------------------------------------------- ADR 0002 helpers
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

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

// ---------------------------------------------------------------------------- WebP builders (header only, the Worker never decodes)
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
const u16 = (n: number) => [n & 255, (n >> 8) & 255]
const u24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const filler = (seed: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 7 + 1) & 0xff)

function chunk(fourcc: string, data: Uint8Array): number[] {
  return [...ascii(fourcc), ...u32(data.length), ...data, ...(data.length % 2 ? [0] : [])]
}
function riff(chunks: number[]): Uint8Array {
  return Uint8Array.from([...ascii('RIFF'), ...u32(4 + chunks.length), ...ascii('WEBP'), ...chunks])
}

type Kind = 'vp8x' | 'vp8l' | 'vp8'
/** Smallest-possible header-only WebP of the given kind; `extra` filler bytes (seeded) make the content unique or large. */
function webp(kind: Kind, w: number, h: number, seed: number, extra = 8): Uint8Array {
  const pad = filler(seed, extra)
  if (kind === 'vp8x') {
    const head = Uint8Array.from([0, 0, 0, 0, ...u24(w - 1), ...u24(h - 1)])
    return riff([...chunk('VP8X', head), ...chunk('JUNK', pad)])
  }
  if (kind === 'vp8l') {
    const bits = (w - 1) | ((h - 1) << 14)
    return riff(chunk('VP8L', Uint8Array.from([0x2f, ...u32(bits >>> 0), ...pad])))
  }
  return riff(chunk('VP8 ', Uint8Array.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, ...u16(w), ...u16(h), ...pad])))
}
/** Same as webp() but exactly `total` bytes long (filler adjusted for chunk padding). */
function webpOfSize(kind: Kind, w: number, h: number, seed: number, total: number): Uint8Array {
  const guess = total - webp(kind, w, h, seed, 0).length
  for (const extra of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
    const data = webp(kind, w, h, seed, Math.max(extra, 0))
    if (data.length === total) return data
  }
  throw new Error(`không dựng được WebP ${total} byte`)
}
const pngBytes = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR'), 0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0, 1, 2, 3, 4])

async function keyOf(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return `${hex(digest).slice(0, 12)}.webp`
}

// ---------------------------------------------------------------------------- catalog
const P = 'Ar Món Một' // có ảnh tự vẽ (ai)
const Q = 'Ar Món Hai' // chưa có ảnh
const S = 'Ar Món Ba' // chưa có ảnh
const NAMES = [P, Q, S]
const OLD = '0123456789ab.webp'

const elementRow = (name: string, imageKey: string | null, source: 'ai' | 'admin' | null) =>
  elementId(name).then((id) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO element (id, name, name_fold, emoji, depth, origin, image_key, image_source, first_version, last_version, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, 1, ?)',
    ).bind(id, name, fold(name), '🍲', 'vn', imageKey, source, Date.now()),
  )

// ---------------------------------------------------------------------------- HTTP helpers
let ipCounter = 0
const nextIp = () => {
  ipCounter++
  return `10.40.${ipCounter >> 8}.${ipCounter & 255}`
}

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

type AOpts = { auth?: string | null; headers?: Record<string, string> }
function adminGet(path: string, o: AOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': nextIp(), ...(o.headers ?? {}) }
  const auth = o.auth === undefined ? `Bearer ${TOKEN}` : o.auth
  if (auth !== null) headers.Authorization = auth
  return raw(`${ADMIN_ORIGIN}/api/admin${path}`, {}, headers)
}
function putImage(id: string, data: Uint8Array | string, o: AOpts & { type?: string | null; origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': nextIp(), ...(o.headers ?? {}) }
  if (o.type !== null) headers['Content-Type'] = o.type ?? 'image/webp'
  const auth = o.auth === undefined ? `Bearer ${TOKEN}` : o.auth
  if (auth !== null) headers.Authorization = auth
  const base = o.origin ?? `${ADMIN_ORIGIN}/api/admin`
  return raw(`${base}/elements/${id}/image`, { method: 'PUT', body: data }, headers)
}
const getPipelineState = () => raw(`${GAME_API}/pipeline/state`, {}, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const json = async <T>(res: Response) => (await res.json()) as T

// ---------------------------------------------------------------------------- DB / R2 probes
const imageChangeCount = async (): Promise<number> => (await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_image_change').first<{ n: number }>())!.n
const elementImage = async (id: string): Promise<Row | null> => env.DB.prepare('SELECT image_key, image_source FROM element WHERE id = ?').bind(id).first<Row>()
const used: string[] = []
const stored = async (key: string): Promise<Uint8Array | null> => {
  const obj = await R2.get(`img/${key}`)
  return obj === null ? null : new Uint8Array(await obj.arrayBuffer())
}
const auditItems = async () => (await json<Page<AuditItem>>(await adminGet('/audit?size=100'))).items
const listItems = async () => (await json<Page<ElementItem>>(await adminGet('/elements?size=100'))).items

async function publish(version: number, images: Record<string, string | undefined>): Promise<Response> {
  const starterNames = ['Cay', 'Cười', 'Toang', 'Deadline']
  const starters = await Promise.all(starterNames.map(elementId))
  const batchAt = '2026-10-20T05:30:00.000Z'
  const [x, y] = [starters[0]!, starters[1]!].sort()
  const target = await elementId(P)
  const elems = await Promise.all(
    NAMES.map(async (name) => ({
      id: await elementId(name),
      name,
      fold: fold(name),
      emoji: '🍲',
      depth: 4,
      auto_tier: 3,
      ...(images[name] === undefined ? {} : { image_key: images[name] }),
    })),
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
      elements: [
        ...starters.map((id, i) => ({ id, name: starterNames[i]!, fold: fold(starterNames[i]!), emoji: '🔥', depth: 0 })),
        ...elems,
      ],
      recipes: [{ id: await recipeId('Cay', 'Cười'), a: x, b: y, result: target }],
      starters,
      daily_element_id: target,
    },
    stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: {} },
  }
  return raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) }, { Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_image_change'),
    env.DB.prepare('DELETE FROM admin_change'),
    env.DB.prepare('DELETE FROM element_tier'),
    env.DB.prepare('DELETE FROM admin_audit'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM rate_counter'),
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
    await elementRow(P, OLD, 'ai'),
    await elementRow(Q, null, null),
    await elementRow(S, null, null),
  ])
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const k of used.splice(0)) await R2.delete(`img/${k}`)
})

describe('art admin upload (worker)', () => {
  it(
    'AC-ART-13: WebP VP8X 256x256 hợp lệ thay ảnh cũ: 200 {element_id, before_key, after_key}, R2 có đúng byte, GET /img phục vụ, danh sách hiện image_key + image_source admin, đúng 1 audit set_image, /pipeline/state.admin_images liệt kê',
    async () => {
      const p = await elementId(P)
      const data = webp('vp8x', 256, 256, 1)
      const key = await keyOf(data)
      used.push(key)
      const fp = hex(await sha256(TOKEN)).slice(0, 8)

      const res = await putImage(p, data)
      expect(res.status).toBe(200)
      expect(await json<ImageResult>(res)).toEqual({ element_id: p, before_key: OLD, after_key: key })

      expect(await stored(key)).toEqual(data)
      const served = await raw(`${GAME_API.replace('/api', '')}/img/${key}`, {}, { 'CF-Connecting-IP': nextIp() })
      expect(served.status).toBe(200)
      expect(served.headers.get('content-type')).toBe('image/webp')
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(data)

      expect(await elementImage(p)).toEqual({ image_key: key, image_source: 'admin' })
      const row = (await listItems()).find((i) => i.id === p)
      expect(row).toMatchObject({ image_key: key, image_source: 'admin' })

      const audit = (await auditItems()).filter((a) => a.action === 'set_image')
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ target_kind: 'element', target_id: p, before: { image_key: OLD }, after: { image_key: key }, token_fp: fp })
      expect(Math.abs(Date.parse(audit[0]!.created_at) - Date.now())).toBeLessThan(5 * 60_000)
      expect(await imageChangeCount()).toBe(1)

      const state = await json<{ admin_images: Array<{ element_id: string; image_key: string }> }>(await getPipelineState())
      expect(state.admin_images).toEqual([{ element_id: p, image_key: key }])
    },
    60_000,
  )

  it(
    'AC-ART-13: phần tử chưa có ảnh nhận WebP VP8L và VP8 lossy 256x256 (before_key null); đúng 1 MB vẫn nhận; mỗi lần ghi 1 audit',
    async () => {
      const [q, s] = [await elementId(Q), await elementId(S)]
      const lossless = webp('vp8l', 256, 256, 2)
      const lossy = webpOfSize('vp8', 256, 256, 3, MAX_BYTES)
      expect(lossy.length).toBe(MAX_BYTES)
      const [kl, ky] = [await keyOf(lossless), await keyOf(lossy)]
      used.push(kl, ky)

      const a = await putImage(s, lossless)
      expect(a.status).toBe(200)
      expect(await json<ImageResult>(a)).toEqual({ element_id: s, before_key: null, after_key: kl })
      const b = await putImage(q, lossy)
      expect(b.status).toBe(200)
      expect(await json<ImageResult>(b)).toEqual({ element_id: q, before_key: null, after_key: ky })

      expect(await stored(kl)).toEqual(lossless)
      expect(await stored(ky)).toEqual(lossy)
      const by = new Map((await listItems()).map((i) => [i.id, i]))
      expect(by.get(s)).toMatchObject({ image_key: kl, image_source: 'admin' })
      expect(by.get(q)).toMatchObject({ image_key: ky, image_source: 'admin' })
      const audit = (await auditItems()).filter((x) => x.action === 'set_image')
      expect(audit).toHaveLength(2)
      expect(audit.map((x) => (x.after as { image_key: string }).image_key).sort()).toEqual([kl, ky].sort())
    },
    90_000,
  )

  it(
    'AC-ART-13: sai kích thước (512x512, 256x512), PNG, không phải WebP, RIFF WAVE, header cụt, quá 1 MB đều 400 problem+json; ảnh cũ giữ nguyên, R2 không có object mới, không audit',
    async () => {
      const p = await elementId(P)
      const wave = webp('vp8x', 256, 256, 4)
      wave.set(ascii('WAVE'), 8)
      const bad: Array<[string, Uint8Array]> = [
        ['512x512 vp8x', webp('vp8x', 512, 512, 5)],
        ['256x512 vp8l', webp('vp8l', 256, 512, 6)],
        ['255x256 vp8', webp('vp8', 255, 256, 7)],
        ['png', pngBytes()],
        ['text', enc.encode('<script>alert(1)</script>')],
        ['wave', wave],
        ['cut header', Uint8Array.from([...ascii('RIFF'), 4, 0, 0, 0, ...ascii('WEBP')])],
        ['empty', new Uint8Array(0)],
        ['over 1 MB', webpOfSize('vp8l', 256, 256, 8, MAX_BYTES + 2)], // RIFF chunks are even-sized: +1 cannot be built
      ]
      const keys: string[] = []
      for (const [label, data] of bad) {
        const key = await keyOf(data)
        keys.push(key)
        used.push(key)
        const res = await putImage(p, data)
        expect(res.status, label).toBe(400)
        isProblem(res)
      }
      for (const key of keys) expect(await stored(key), key).toBeNull()
      expect(await elementImage(p)).toEqual({ image_key: OLD, image_source: 'ai' })
      expect(await imageChangeCount()).toBe(0)
      expect((await auditItems()).filter((a) => a.action === 'set_image')).toEqual([])
    },
    120_000,
  )

  it('AC-ART-13: phần tử không tồn tại trả 404 problem+json, không ghi R2, không audit, không dòng đổi ảnh', async () => {
    const ghost = await elementId('Ar Không Có Thật')
    const data = webp('vp8x', 256, 256, 9)
    const key = await keyOf(data)
    used.push(key)
    const res = await putImage(ghost, data)
    expect(res.status).toBe(404)
    isProblem(res)
    expect(await stored(key)).toBeNull()
    expect(await imageChangeCount()).toBe(0)
    expect((await auditItems()).filter((a) => a.action === 'set_image')).toEqual([])
  })

  it('AC-ART-13: thiếu token, token sai, sai sơ đồ trả 401 problem+json; ảnh không đổi, R2 không ghi', async () => {
    const p = await elementId(P)
    const data = webp('vp8x', 256, 256, 10)
    const key = await keyOf(data)
    used.push(key)
    for (const auth of [null, `Bearer ${WRONG}`, `Basic ${btoa(`admin:${TOKEN}`)}`, `Bearer ${PIPELINE_TOKEN}`]) {
      const res = await putImage(p, data, { auth })
      expect(res.status, String(auth)).toBe(401)
      isProblem(res)
    }
    expect(await stored(key)).toBeNull()
    expect(await elementImage(p)).toEqual({ image_key: OLD, image_source: 'ai' })
    expect(await imageChangeCount()).toBe(0)
  })

  it(
    'AC-ART-13: ảnh admin không bị mẻ sau đè: mẻ đăng kèm image_key khác (hoặc không kèm) cho phần tử đó vẫn giữ khóa admin, image_source admin; phần tử khác nhận khóa của mẻ',
    async () => {
      const [p, q] = [await elementId(P), await elementId(Q)]
      const data = webp('vp8x', 256, 256, 11)
      const key = await keyOf(data)
      const other = await keyOf(webp('vp8l', 256, 256, 12))
      used.push(key, other)
      await R2.put(`img/${other}`, webp('vp8l', 256, 256, 12))
      expect((await putImage(p, data)).status).toBe(200)

      expect((await publish(1, { [P]: other, [Q]: other })).status).toBe(201)
      let by = new Map((await listItems()).map((i) => [i.id, i]))
      expect(by.get(p)).toMatchObject({ image_key: key, image_source: 'admin' })
      expect(by.get(q)).toMatchObject({ image_key: other })

      expect((await publish(2, {})).status).toBe(201) // mẻ không mang khóa ảnh nào
      by = new Map((await listItems()).map((i) => [i.id, i]))
      expect(by.get(p)).toMatchObject({ image_key: key, image_source: 'admin' })
      const state = await json<{ admin_images: Array<{ element_id: string; image_key: string }> }>(await getPipelineState())
      expect(state.admin_images).toEqual([{ element_id: p, image_key: key }])
    },
    120_000,
  )

  it('AC-ART-VALIDATION: id đường dẫn sai định dạng (ngắn, dài 10000, script, SQL, id công thức) và thân là JSON không bao giờ trả 200 và không đổi gì', async () => {
    const p = await elementId(P)
    const data = webp('vp8x', 256, 256, 13)
    const key = await keyOf(data)
    used.push(key)
    const ids = ['abc', 'A'.repeat(10_000), encodeURIComponent('<script>alert(1)</script>'.padEnd(43, 'a')), encodeURIComponent("'; DROP TABLE element;--".padEnd(43, 'a')), p + 'A', await recipeId(P, Q)]
    for (const id of ids) {
      const res = await putImage(id, data)
      expect([400, 404], id.slice(0, 40)).toContain(res.status)
      isProblem(res)
    }
    const json400 = await putImage(p, JSON.stringify({ image_key: key }), { type: 'application/json' })
    expect(json400.status).toBeGreaterThanOrEqual(400)
    expect(json400.status).toBeLessThan(500)
    expect(await stored(key)).toBeNull()
    expect(await elementImage(p)).toEqual({ image_key: OLD, image_source: 'ai' })
    expect(await imageChangeCount()).toBe(0)
  }, 120_000)

  it('AC-ART-ABUSE: trên host game /lau-meme/api/admin/... trả 404; giả header (X-Admin, X-Forwarded-For) không né xác thực; không đổi gì', async () => {
    const p = await elementId(P)
    const data = webp('vp8x', 256, 256, 14)
    const key = await keyOf(data)
    used.push(key)
    const onGame = await putImage(p, data, { origin: `${GAME_API}/admin` })
    expect(onGame.status).toBe(404)
    const spoof = { 'X-Admin': 'true', 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '9.9.9.9' }
    expect((await putImage(p, data, { auth: null, headers: spoof })).status).toBe(401)
    for (const near of [`${TOKEN}x`, TOKEN.slice(0, -1), TOKEN.toUpperCase()]) {
      expect((await putImage(p, data, { auth: `Bearer ${near}` })).status).toBe(401)
    }
    expect(await stored(key)).toBeNull()
    expect(await imageChangeCount()).toBe(0)
  })
})
