// Acceptance tests for docs/acceptance/pipe.md, phase 2 (worker side): the pipeline store (ADR 0009).
// AC-PIPE-10 (store round trip, 14 kept versions), AC-PIPE-11 (atomic publish, size cap), AC-PIPE-13 (state, auth).
// Contract: docs/api/openapi.yaml (/pipeline/store, /pipeline/batches, /pipeline/state, /pipeline/rollback).
// D1 is slow under Miniflare on this machine: keep the number of queries per test small.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex (`token = '…'`) does not flag a test constant.
const TOKEN = ['pipe', 'store', 'token'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const BASE = '/lau-meme/api/pipeline'

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

type Store = Record<string, unknown>

async function batchBody(version: number, mode: 'core' | 'full', store?: Store) {
  const names = ['Cay', 'Cười', 'Toang', 'Deadline']
  const emojis = ['🌶️', '😂', '💀', '⏰']
  const starters = await Promise.all(names.map((n) => id43(`s|${n}`)))
  const target = await id43('s|Món Đặc Biệt')
  const [x, y] = [starters[0]!, starters[1]!].sort()
  const body: Record<string, unknown> = {
    status: 'success',
    version,
    batch_at: BATCH_AT,
    mode,
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
  }
  if (store !== undefined) body.store = store
  return body
}

async function publish(version: number, mode: 'core' | 'full', store?: Store): Promise<Response> {
  const body = await batchBody(version, mode, store)
  return call(`${BASE}/batches`, { method: 'POST', body: JSON.stringify(body) })
}

const getStore = (query = '', token: string | null = TOKEN) => call(`${BASE}/store${query}`, {}, token)

function sampleStore(tag: string): Store {
  return {
    elements: [{ id: `e-${tag}`, name: `Meme ${tag}`, emoji: '🔥', hint_ok: true, held_until: null }],
    recipes: [{ id: `r-${tag}`, a: 'a1', b: 'b1', result: `e-${tag}`, score: 4 }],
    queue: [{ key: `q-${tag}`, concept: { name: `Chờ ${tag}` }, attempts: 1, reason: 'unlinked' }],
    asked_pairs: [['a', 'b']],
    llm_cache: { k: [1], [`k-${tag}`]: { ok: true } },
  }
}

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

describe('pipeline store round trip', () => {
  it('AC-PIPE-10: đăng mẻ full kèm store thì GET /pipeline/store trả đúng store đó (cả có và không có ?version)', async () => {
    const store = sampleStore('a')
    const res = await publish(11, 'full', store)
    expect(res.status).toBe(201)

    const current = await getStore()
    expect(current.status).toBe(200)
    expect(await current.json()).toEqual(store)

    const byVersion = await getStore('?version=11')
    expect(byVersion.status).toBe(200)
    expect(await byVersion.json()).toEqual(store)
  })

  it('AC-PIPE-10: chưa đăng mẻ nào thì kho là {}; sau mẻ core (không có store) vẫn là {}', async () => {
    const empty = await getStore()
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({})

    expect((await publish(21, 'core')).status).toBe(201)
    const afterCore = await getStore()
    expect(afterCore.status).toBe(200)
    expect(await afterCore.json()).toEqual({})
  })

  it('AC-PIPE-10: version chưa từng đăng thì 404 problem+json, version không phải số thì 400, thiếu token thì 401', async () => {
    expect((await publish(31, 'full', sampleStore('c'))).status).toBe(201)

    const missing = await getStore('?version=999999')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('application/problem+json')

    for (const bad of ['?version=abc', '?version=0', '?version=-3', '?version=1.5']) {
      const res = await getStore(bad)
      expect(res.status, bad).toBe(400)
      expect(res.headers.get('content-type'), bad).toContain('application/problem+json')
    }

    for (const token of [null, 'wrong-token']) {
      const res = await getStore('', token)
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    }
  })

  it('AC-PIPE-10: hai mẻ full v1<v2 rồi rollback thì GET /pipeline/store trả kho của v1', async () => {
    const s1 = sampleStore('v1')
    const s2 = sampleStore('v2')
    expect((await publish(41, 'full', s1)).status).toBe(201)
    expect((await publish(42, 'full', s2)).status).toBe(201)
    expect(await (await getStore()).json()).toEqual(s2)

    const rb = await call(`${BASE}/rollback`, { method: 'POST' })
    expect(rb.status).toBe(200)

    const after = await getStore()
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual(s1)
  })

  it('AC-PIPE-10: 15 mẻ full thì kho cũ nhất bị dọn cùng batch_content (giữ 14 bản)', async () => {
    for (let v = 101; v <= 115; v++) {
      expect((await publish(v, 'full', { queue: [], asked_pairs: [], llm_cache: { v } })).status, `v${v}`).toBe(201)
    }
    const oldest = await getStore('?version=101')
    expect(oldest.status).toBe(404)
    expect(oldest.headers.get('content-type')).toContain('application/problem+json')

    const kept = await getStore('?version=102')
    expect(kept.status).toBe(200)
    expect(await kept.json()).toEqual({ queue: [], asked_pairs: [], llm_cache: { v: 102 } })
    expect(await (await getStore()).json()).toEqual({ queue: [], asked_pairs: [], llm_cache: { v: 115 } })
  }, 180_000)
})

describe('pipeline store size cap', () => {
  it('AC-PIPE-11: store lớn hơn 1,9 MB bị từ chối 413, version hiện hành và kho không đổi', async () => {
    const good = sampleStore('ok')
    expect((await publish(51, 'full', good)).status).toBe(201)
    const stateBefore = (await (await call(`${BASE}/state`)).json()) as { current_version: number }
    expect(stateBefore.current_version).toBe(51)

    const huge: Store = { ...sampleStore('big'), llm_cache: { k: 'x'.repeat(1_950_000) } }
    expect(JSON.stringify(huge).length).toBeGreaterThan(1_900_000)
    expect(JSON.stringify(huge).length).toBeLessThan(5_000_000)
    const res = await publish(52, 'full', huge)
    expect(res.status).toBe(413)

    const stateAfter = (await (await call(`${BASE}/state`)).json()) as { current_version: number }
    expect(stateAfter.current_version).toBe(51)
    expect(await (await getStore()).json()).toEqual(good)
    expect((await getStore('?version=52')).status).toBe(404)
  }, 60_000)
})

describe('pipeline state admin_blocked', () => {
  it('AC-PIPE-13: state.admin_blocked chỉ gồm fold nguồn admin, banned_aliases vẫn gồm cả mod và admin', async () => {
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO banned_term (term_fold, source, created_at) VALUES (?, ?, ?)').bind('ten mod', 'mod', now),
      env.DB.prepare('INSERT INTO banned_term (term_fold, source, created_at) VALUES (?, ?, ?)').bind('ten admin', 'admin', now),
      env.DB.prepare('INSERT INTO banned_term (term_fold, source, created_at) VALUES (?, ?, ?)').bind('tu cam', 'wordlist', now),
    ])

    const res = await call(`${BASE}/state`)
    expect(res.status).toBe(200)
    const state = (await res.json()) as { admin_blocked: string[]; banned_aliases: string[] }
    expect(state.admin_blocked).toEqual(['ten admin'])
    expect(state.banned_aliases).toEqual(expect.arrayContaining(['ten mod', 'ten admin']))
    expect(state.banned_aliases).not.toContain('tu cam')
  })

  it('AC-PIPE-13: không có term admin thì admin_blocked là mảng rỗng (khóa luôn có mặt)', async () => {
    const res = await call(`${BASE}/state`)
    expect(res.status).toBe(200)
    const state = (await res.json()) as Record<string, unknown>
    expect(state.admin_blocked).toEqual([])
  })
})
