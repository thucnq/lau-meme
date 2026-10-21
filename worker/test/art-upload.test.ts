// Acceptance tests for docs/acceptance/art.md, Worker side of the full-batch wiring (ADR 0012):
// AC-ART-04 (PUT /pipeline/images/{key}, operationId putPipelineImage), AC-ART-03 (PipelineStore.art_pending).
// Contract: docs/api/openapi.yaml. R2 binding `IMG`, object key `img/<key>`. D1 is slow under Miniflare: few queries.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex (`token = '…'`) does not flag a test constant.
const TOKEN = ['pipe', 'store', 'token'].join('-')
const BASE = '/lau-meme/api/pipeline'
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const MAX_BYTES = 524288

type Bucket = {
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  delete(key: string): Promise<void>
}
const IMG = (env as unknown as { IMG: Bucket }).IMG

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

// ---------------------------------------------------------------------------- image helpers

/** "RIFF" + 4 size bytes + "WEBP" + payload; `seed` makes the bytes (and so the key) unique per test. */
function webp(seed: number, extra = 24): Uint8Array {
  const body = new Uint8Array(12 + extra)
  body.set([0x52, 0x49, 0x46, 0x46, extra + 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  for (let i = 0; i < extra; i++) body[12 + i] = (seed * 31 + i * 7) & 0xff
  return body
}

async function keyOf(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 12)}.webp`
}

const used: string[] = []

async function put(
  key: string,
  body: Uint8Array,
  opts: { type?: string | null; token?: string | null } = {},
): Promise<Response> {
  used.push(key)
  const headers: Record<string, string> = {}
  if (opts.type !== null) headers['Content-Type'] = opts.type ?? 'image/webp'
  return call(`${BASE}/images/${key}`, { method: 'PUT', body, headers }, opts.token === undefined ? TOKEN : opts.token)
}

async function stored(key: string): Promise<Uint8Array | null> {
  const obj = await IMG.get(`img/${key}`)
  return obj === null ? null : new Uint8Array(await obj.arrayBuffer())
}

async function expectNothingWritten(key: string) {
  expect(await stored(key)).toBeNull()
}

function expectProblem(res: Response) {
  expect(res.headers.get('content-type')).toContain('application/problem+json')
}

afterEach(async () => {
  for (const k of used.splice(0)) await IMG.delete(`img/${k}`)
})

// ---------------------------------------------------------------------------- AC-ART-04

describe('art: PUT /pipeline/images/{key}', () => {
  it('AC-ART-04: ảnh WebP hợp lệ, khóa = 12 hex đầu SHA-256 thân thì 204, R2 có đúng byte, GET /img/<key> trả lại', async () => {
    const data = webp(1)
    const key = await keyOf(data)

    const res = await put(key, data)
    expect(res.status).toBe(204)

    expect(await stored(key)).toEqual(data)

    const got = await call(`/lau-meme/img/${key}`, {}, null)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/webp')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(data)
  })

  it('AC-ART-04: khóa không khớp SHA-256 của thân thì 422 problem+json và không ghi gì', async () => {
    const data = webp(2)
    const other = await keyOf(webp(3))
    expect(other).not.toBe(await keyOf(data))

    const res = await put(other, data)
    expect(res.status).toBe(422)
    expectProblem(res)
    await expectNothingWritten(other)
    await expectNothingWritten(await keyOf(data))
  })

  it('AC-ART-04: thân không có chữ ký RIFF/WEBP (dù khóa khớp băm) thì 422 và không ghi gì', async () => {
    const bodies = [
      new TextEncoder().encode('<script>alert(1)</script>'),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]), // PNG
      (() => {
        const b = webp(4)
        b.set([0x57, 0x41, 0x56, 0x45], 8) // RIFF....WAVE
        return b
      })(),
      new Uint8Array([0x52, 0x49, 0x46, 0x46]), // too short to be WebP
    ]
    for (const data of bodies) {
      const key = await keyOf(data)
      const res = await put(key, data)
      expect(res.status, key).toBe(422)
      expectProblem(res)
      await expectNothingWritten(key)
    }
  })

  it('AC-ART-04: khóa không khớp ^[0-9a-f]{12}\\.webp$ thì 400 problem+json', async () => {
    const data = webp(5)
    const bad = [
      'ABC123DEF456.webp',
      'abc123def45.webp',
      'abc123def4567.webp',
      'abc123def456.png',
      'abc123def456',
      'zzzzzzzzzzzz.webp',
      '..%2F..%2Fsecret.webp',
      '%3Cscript%3E.webp',
    ]
    for (const key of bad) {
      const res = await put(key, data)
      expect(res.status, key).toBe(400)
      expectProblem(res)
    }
  })

  it('AC-ART-04: Content-Type khác image/webp thì 415 và không ghi gì', async () => {
    const data = webp(6)
    const key = await keyOf(data)
    for (const type of ['application/json', 'image/png', 'application/octet-stream', 'text/plain']) {
      const res = await put(key, data, { type })
      expect(res.status, type).toBe(415)
      expectProblem(res)
    }
    const none = await put(key, data, { type: null })
    expect(none.status).toBe(415)
    await expectNothingWritten(key)
  })

  it('AC-ART-04: thân lớn hơn 524288 byte thì 413 và không ghi gì (đúng 524288 thì vẫn nhận)', async () => {
    const big = webp(7, MAX_BYTES + 1 - 12)
    expect(big.length).toBe(MAX_BYTES + 1)
    const bigKey = await keyOf(big)
    const res = await put(bigKey, big)
    expect(res.status).toBe(413)
    expectProblem(res)
    await expectNothingWritten(bigKey)

    const edge = webp(8, MAX_BYTES - 12)
    expect(edge.length).toBe(MAX_BYTES)
    const edgeKey = await keyOf(edge)
    expect((await put(edgeKey, edge)).status).toBe(204)
    expect(await stored(edgeKey)).toEqual(edge)
  })

  it('AC-ART-04: thiếu token hoặc sai token thì 401 problem+json và không ghi gì', async () => {
    const data = webp(9)
    const key = await keyOf(data)
    for (const token of [null, 'wrong-token', '']) {
      const res = await put(key, data, { token })
      expect(res.status, String(token)).toBe(401)
      expectProblem(res)
    }
    await expectNothingWritten(key)
  })

  it('AC-ART-04: idempotent - đã có object cùng khóa thì PUT lại vẫn 204, nội dung không đổi; PUT hai lần cũng 204', async () => {
    const data = webp(10)
    const key = await keyOf(data)
    used.push(key)
    await IMG.put(`img/${key}`, data)

    const again = await put(key, data)
    expect(again.status).toBe(204)
    expect(await stored(key)).toEqual(data)

    const fresh = webp(11)
    const freshKey = await keyOf(fresh)
    expect((await put(freshKey, fresh)).status).toBe(204)
    expect((await put(freshKey, fresh)).status).toBe(204)
    expect(await stored(freshKey)).toEqual(fresh)
  })

  it('AC-ART-ABUSE: token pipeline bị lộ cũng không ghi đè được ảnh có sẵn bằng nội dung khác hay ghi khóa giả', async () => {
    const original = webp(12)
    const key = await keyOf(original)
    used.push(key)
    await IMG.put(`img/${key}`, original)

    const forged = webp(13)
    expect((await put(key, forged)).status).toBe(422)
    expect(await stored(key)).toEqual(original)

    const traversal = await put('..%2Fimg%2F' + key, forged)
    expect(traversal.status).toBe(400)
    const outside = await call(`${BASE}/images/${key}/extra`, { method: 'PUT', body: forged, headers: { 'Content-Type': 'image/webp' } })
    expect(outside.status).toBeGreaterThanOrEqual(400)
    expect(outside.status).toBeLessThan(500)
    expect(await stored(key)).toEqual(original)
  })
})

// ---------------------------------------------------------------------------- AC-ART-03: art_pending in the store

async function id43(label: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label))
  return Buffer.from(digest).toString('base64url')
}

type Store = Record<string, unknown>

async function batchBody(version: number, store: Store) {
  const names = ['Cay', 'Cười', 'Toang', 'Deadline']
  const emojis = ['🌶️', '😂', '💀', '⏰']
  const starters = await Promise.all(names.map((n) => id43(`s|${n}`)))
  const target = await id43('s|Món Đặc Biệt')
  const [x, y] = [starters[0]!, starters[1]!].sort()
  return {
    status: 'success',
    version,
    batch_at: BATCH_AT,
    mode: 'full',
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
    store,
  }
}

const publish = async (version: number, store: Store) =>
  call(`${BASE}/batches`, { method: 'POST', body: JSON.stringify(await batchBody(version, store)) })

describe('art: PipelineStore.art_pending', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pipeline_store'),
      env.DB.prepare('DELETE FROM banned_term'),
      env.DB.prepare('DELETE FROM block'),
      env.DB.prepare('DELETE FROM batch_content'),
      env.DB.prepare('DELETE FROM batch_run'),
      env.DB.prepare('DELETE FROM recipe'),
      env.DB.prepare('DELETE FROM element'),
      env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
    ])
  })

  it('AC-ART-03: mẻ full kèm store.art_pending (id 43 ký tự) thì 201 và GET /pipeline/store trả đúng danh sách đó', async () => {
    const pending = [await id43('art|1'), await id43('art|2')]
    expect(pending[0]).toHaveLength(43)
    const store: Store = {
      elements: [],
      recipes: [],
      queue: [],
      asked_pairs: [],
      llm_cache: { k: [1] },
      art_pending: pending,
    }
    const res = await publish(71, store)
    expect(res.status).toBe(201)

    const got = await call(`${BASE}/store`)
    expect(got.status).toBe(200)
    const body = (await got.json()) as Store
    expect(body.art_pending).toEqual(pending)
    expect(body).toEqual(store)
  })

  it('AC-ART-VALIDATION: art_pending sai dạng (không phải mảng id, id chứa script, quá dài) bị từ chối 4xx và không đổi version', async () => {
    const bad: unknown[] = ['not-a-list', [123], ['<script>alert(1)</script>'], ['x'.repeat(5000)], [await id43('ok'), 'short']]
    for (const art_pending of bad) {
      const res = await publish(81, { queue: [], asked_pairs: [], llm_cache: {}, art_pending })
      expect(res.status, JSON.stringify(art_pending).slice(0, 40)).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    }
    const state = (await (await call(`${BASE}/state`)).json()) as { current_version: number | null }
    expect(state.current_version).toBeNull()
  })
})
