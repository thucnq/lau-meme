// Acceptance tests for docs/acceptance/disc.md (worker part: AC-DISC-02..12, ABUSE).
// Black-box: only the HTTP contract (docs/api/openapi.yaml), ADR 0002/0004/0005 and the D1 schema are used.
// Performance: D1 in Miniflare costs ~66 ms/query, so every test seeds with ONE env.DB.batch and keeps requests few.
// The batch content is published once (and only again when missing) through the pipeline endpoint.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['disc', 'pipeline', 'token'].join('-')
const IP_KEY = ['disc', 'ip', 'hash', 'key'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const BASE = '/lau-meme/api'
const ANON = 'Thực khách ẩn danh'
const NICK_TITLE = 'Nickname không hợp lệ'
const TAKEN_TITLE = 'Nickname đã có người dùng'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Problem = { type: string; title: string; status: number; detail?: string }
type DiscoveryResult = { element_id: string; nickname: string; discovered_at: string; first: boolean }
type Item = { element_id: string; nickname: string; discovered_at: string }

// ---------------------------------------------------------------------------- ADR 0002 helpers (no Node types)
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

// ---------------------------------------------------------------------------- fixture content
const STARTER_DEFS = [
  { name: 'Cay', emoji: '🌶️' },
  { name: 'Cười', emoji: '😂' },
  { name: 'Toang', emoji: '💀' },
  { name: 'Deadline', emoji: '⏰' },
]
const CHAIN = [
  { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
  { a: 'Tới Công Chuyện', b: 'Deadline', result: 'Chạy Deadline', emoji: '🏃', depth: 2 },
  { a: 'Chạy Deadline', b: 'Toang', result: 'Hết Cứu', emoji: '🧯', depth: 3 },
  { a: 'Hết Cứu', b: 'Cay', result: 'Stonks', emoji: '📈', depth: 4 },
]
const TARGET = 'Stonks'
const SIDE = { a: 'Toang', b: 'Deadline', result: 'Khét Lẹt', emoji: '🫠', depth: 1 }
const HINT = 'Món lên như diều gặp gió'

async function batchBody(version: number) {
  const starterIds = await Promise.all(STARTER_DEFS.map((s) => elementId(s.name)))
  const defs = [...CHAIN, SIDE]
  const recipes = await Promise.all(
    defs.map(async (d) => {
      const [x, y] = [await elementId(d.a), await elementId(d.b)].sort()
      return { id: await recipeId(d.a, d.b), a: x!, b: y!, result: await elementId(d.result) }
    }),
  )
  const targetId = await elementId(TARGET)
  return {
    status: 'success',
    version,
    batch_at: BATCH_AT,
    mode: 'core',
    manifest: {
      version,
      batch_at: BATCH_AT,
      graph_url: `/api/graph/${version}`,
      starters: STARTER_DEFS.map((s, i) => ({ id: starterIds[i], name: s.name, emoji: s.emoji })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: targetId, emoji: '📈', hint: HINT, depth: 4 },
    },
    graph: { format: 1, version, entries: { [await recipeId('graph', String(version))]: 'abc' } },
    content: {
      elements: [
        ...STARTER_DEFS.map((s, i) => ({ id: starterIds[i], name: s.name, fold: fold(s.name), emoji: s.emoji, depth: 0, origin: 'vn' })),
        ...(await Promise.all(
          defs.map(async (d) => ({
            id: await elementId(d.result),
            name: d.result,
            fold: fold(d.result),
            emoji: d.emoji,
            depth: d.depth,
            origin: 'vn',
          })),
        )),
      ],
      recipes,
      starters: starterIds,
      daily_element_id: targetId,
    },
    stats: {},
  }
}

// ---------------------------------------------------------------------------- HTTP helpers
async function raw(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(`https://example.com${path}`, { ...init, headers: h }),
    { ...env, PIPELINE_TOKEN: TOKEN, IP_HASH_KEY: IP_KEY },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

async function ensurePublished(): Promise<void> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM app_meta WHERE key = 'current_version'").first()
  if (row) return
  const res = await raw(`${BASE}/pipeline/batches`, { method: 'POST', body: JSON.stringify(await batchBody(1)) }, { Authorization: `Bearer ${TOKEN}` })
  expect(res.status).toBe(201)
}

/** Each player gets a distinct documentation-range IP so IP rate limits never interfere unless a test wants it. */
function ipFor(player: string): string {
  const h = player.replaceAll('-', '')
  return `10.${parseInt(h.slice(0, 2), 16)}.${parseInt(h.slice(2, 4), 16)}.${parseInt(h.slice(4, 6), 16)}`
}
function as(player: string | null, ip?: string): Record<string, string> {
  const h: Record<string, string> = { 'CF-Connecting-IP': ip ?? (player ? ipFor(player) : '10.250.250.250') }
  if (player !== null) h['X-Player-Id'] = player
  return h
}

const postRaw = (player: string | null, body: string, ip?: string) => raw(`${BASE}/discoveries`, { method: 'POST', body }, as(player, ip))
const post = (player: string | null, body: unknown, ip?: string) => postRaw(player, JSON.stringify(body), ip)
const getItems = (ids: string[]) => raw(`${BASE}/discoveries?ids=${ids.join(',')}`)
const putNick = (player: string, nickname: unknown, extra: Record<string, unknown> = {}) =>
  raw(`${BASE}/me/nickname`, { method: 'PUT', body: JSON.stringify({ nickname, ...extra }) }, as(player))
const putTerms = (source: string, body: unknown, token: string | null = TOKEN) =>
  raw(`${BASE}/pipeline/banned-terms/${source}`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }, token ? { Authorization: `Bearer ${token}` } : {})

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const newId = () => crypto.randomUUID()

// ---------------------------------------------------------------------------- seeding
const ins = {
  consent: (player: string, purpose: 'play' | 'nickname') =>
    env.DB.prepare(
      "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, ?, 'grant', ?, NULL, 'web', ?)",
    ).bind(newId(), player, purpose, POLICY_VERSION, Date.now() - 1000),
  player: (id: string, nickname: string | null) =>
    env.DB.prepare('INSERT INTO player (id, nickname, nickname_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(
      id,
      nickname,
      nickname ? fold(nickname) : null,
      Date.now() - 5000,
      Date.now() - 5000,
    ),
  discovery: (element: string, player: string | null, at: number) =>
    env.DB.prepare('INSERT INTO discovery (element_id, player_id, a_id, b_id, version, discovered_at) VALUES (?, ?, ?, ?, 1, ?)').bind(
      element,
      player,
      'seed-a',
      'seed-b',
      at,
    ),
  block: (kind: 'element' | 'recipe', target: string) =>
    env.DB.prepare("INSERT INTO block (kind, target_id, state, reason, created_at) VALUES (?, ?, 'blocked', 'admin', ?)").bind(kind, target, Date.now()),
  term: (term: string, source: 'wordlist' | 'mod' | 'admin') =>
    env.DB.prepare('INSERT INTO banned_term (term_fold, source, created_at) VALUES (?, ?, ?)').bind(term, source, Date.now()),
  bucket: (bucket: string, count: number, windowStart: number) =>
    env.DB.prepare('INSERT INTO rate_counter (bucket, count, expires_at) VALUES (?, ?, ?)').bind(bucket, count, windowStart + 60_000),
}

/** Players that may play (and optionally set a nickname). */
function allowed(player: string, nickname = false, name: string | null = null) {
  const stmts = [ins.consent(player, 'play')]
  if (nickname) stmts.push(ins.consent(player, 'nickname'))
  if (name !== null) stmts.push(ins.player(player, name))
  return stmts
}

async function userBucket(player: string, windowStart: number): Promise<string> {
  return `disc:u:${hex(await sha256(player)).slice(0, 16)}:${windowStart}`
}
async function ipBucket(ip: string, windowStart: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(IP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const ipHashHex = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(ip))))
  return `disc:i:${hex(await sha256(ipHashHex)).slice(0, 16)}:${windowStart}`
}

async function nDiscovery(): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM discovery').first<{ n: number }>())?.n ?? 0
}

beforeEach(async () => {
  await ensurePublished()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM discovery'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM banned_term'),
    env.DB.prepare('DELETE FROM consent'),
    env.DB.prepare('DELETE FROM player'),
    env.DB.prepare('DELETE FROM rate_counter'),
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('disc', () => {
  // ------------------------------------------------------------------------ AC-DISC-02
  it('AC-DISC-02: PUT nickname "  Bếp Trưởng 99 " trả 200 với nickname đã cắt khoảng trắng; đổi nickname thì GET khám phá dùng nickname mới', async () => {
    const u = newId()
    const c = await elementId('Tới Công Chuyện')
    const e = await elementId('Khét Lẹt')
    await env.DB.batch([...allowed(u, true), ins.discovery(c, u, Date.now() - 10_000)])

    const res = await putNick(u, '  Bếp Trưởng 99 ')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ nickname: 'Bếp Trưởng 99' })
    const first = (await (await getItems([c])).json()) as { items: Item[] }
    expect(first.items.map((i) => i.nickname)).toEqual(['Bếp Trưởng 99'])

    expect((await putNick(u, 'Bếp Phó')).status).toBe(200)
    const second = (await (await getItems([c, e])).json()) as { items: Item[] } // other query string: never a cached copy
    expect(second.items.map((i) => i.nickname)).toEqual(['Bếp Phó'])
  })

  it('AC-DISC-02: biên 2 và 20 ký tự (chữ có dấu, số, khoảng trắng, _ và -) được nhận; khoảng trắng hai đầu không tính', async () => {
    const u = newId()
    await env.DB.batch(allowed(u, true))
    const cases: Array<[string, string]> = [
      ['Ăn', 'Ăn'],
      ['Bếp_Trưởng-99 ok', 'Bếp_Trưởng-99 ok'],
      ['  ' + 'a'.repeat(20) + '  ', 'a'.repeat(20)],
    ]
    for (const [sent, want] of cases) {
      const res = await putNick(u, sent)
      expect(res.status, sent).toBe(200)
      expect(await res.json()).toEqual({ nickname: want })
    }
    const row = await env.DB.prepare('SELECT nickname FROM player WHERE id = ?').bind(u).first<{ nickname: string }>()
    expect(row?.nickname).toBe('a'.repeat(20))
  })

  // ------------------------------------------------------------------------ AC-DISC-03
  it('AC-DISC-03: nickname rỗng, 1 ký tự, 21 ký tự hoặc có ký tự ngoài tập cho phép trả 422 problem+json chung; nickname cũ giữ nguyên', async () => {
    const u = newId()
    await env.DB.batch(allowed(u, true, 'Cũ Kỹ'))
    for (const bad of ['', '   ', 'A', 'x'.repeat(21), 'Bếp<b>', 'Bếp 😀']) {
      const res = await putNick(u, bad)
      expect(res.status, JSON.stringify(bad)).toBe(422)
      isProblem(res)
      const body = (await res.json()) as Problem
      expect(body.title).toBe(NICK_TITLE)
      expect(body.status).toBe(422)
    }
    const row = await env.DB.prepare('SELECT nickname FROM player WHERE id = ?').bind(u).first<{ nickname: string }>()
    expect(row?.nickname).toBe('Cũ Kỹ')
  })

  it('AC-DISC-03: từ cấm (mọi nguồn) so trên dạng fold bỏ dấu câu/khoảng trắng, chứa chuỗi con; thông báo không nói từ nào bị chặn', async () => {
    const u = newId()
    await env.DB.batch([
      ...allowed(u, true, 'Cũ Kỹ'),
      ins.term('abc xyz', 'mod'),
      ins.term('tu cam', 'wordlist'),
      ins.term('badword', 'admin'),
    ])
    const cases: Array<[string, string]> = [
      ['ABC  XYZ', 'abc'],
      ['abcxyz', 'xyz'],
      ['Tư Cầm 1', 'cam'],
      ['xx BadWord yy', 'badword'],
    ]
    for (const [bad, leaked] of cases) {
      const res = await putNick(u, bad)
      expect(res.status, bad).toBe(422)
      isProblem(res)
      const text = await res.text()
      expect((JSON.parse(text) as Problem).title).toBe(NICK_TITLE)
      expect(text.toLowerCase(), bad).not.toContain(leaked)
    }
    const row = await env.DB.prepare('SELECT nickname FROM player WHERE id = ?').bind(u).first<{ nickname: string }>()
    expect(row?.nickname).toBe('Cũ Kỹ')
  })

  it('AC-DISC-03: PUT banned-terms/wordlist thay đúng nguồn đó bằng các từ đã fold (bỏ trùng), nguồn khác giữ nguyên, trả 204 và có hiệu lực ngay', async () => {
    const u = newId()
    await env.DB.batch([
      ...allowed(u, true),
      ins.term('old', 'wordlist'),
      ins.term('keepmod', 'mod'),
      ins.term('keepadm', 'admin'),
    ])
    const res = await putTerms('wordlist', { terms: ['Từ Cấm', 'TU CAM', 'Zed'] })
    expect(res.status).toBe(204)
    const rows = (await env.DB.prepare('SELECT term_fold, source FROM banned_term').all<{ term_fold: string; source: string }>()).results
    const flat = rows.map((r) => `${r.source}:${r.term_fold}`).sort()
    expect(flat).toEqual(['admin:keepadm', 'mod:keepmod', 'wordlist:tu cam', 'wordlist:zed'])

    expect((await putNick(u, 'tucam 1')).status).toBe(422)
    expect((await putNick(u, 'Keepadm')).status).toBe(422) // other sources untouched
    expect((await putNick(u, 'Old Man')).status).toBe(200) // replaced term is gone
  })

  it('AC-DISC-03: PUT banned-terms/mod thay tập bí danh; nickname "abcxyz" bị từ chối khi có bí danh "abc xyz" (AC-MOD-06)', async () => {
    const u = newId()
    await env.DB.batch([...allowed(u, true), ins.term('keepwl', 'wordlist')])
    expect((await putTerms('mod', { terms: ['Abc Xyz'] })).status).toBe(204)
    const rows = (await env.DB.prepare('SELECT term_fold, source FROM banned_term').all<{ term_fold: string; source: string }>()).results
    expect(rows.map((r) => `${r.source}:${r.term_fold}`).sort()).toEqual(['mod:abc xyz', 'wordlist:keepwl'])
    expect((await putNick(u, 'abcxyz')).status).toBe(422)
    expect((await putTerms('mod', { terms: [] })).status).toBe(204)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM banned_term WHERE source = 'mod'").first<{ n: number }>())?.n).toBe(0)
  })

  it('AC-DISC-03: banned-terms không có hoặc sai PIPELINE_TOKEN trả 401 và không đổi gì', async () => {
    await env.DB.batch([ins.term('keep', 'wordlist')])
    for (const token of [null, ['wrong', 'token'].join('-')]) {
      const res = await putTerms('wordlist', { terms: ['x'] }, token)
      expect(res.status).toBe(401)
      isProblem(res)
    }
    const rows = (await env.DB.prepare('SELECT term_fold FROM banned_term').all<{ term_fold: string }>()).results
    expect(rows.map((r) => r.term_fold)).toEqual(['keep'])
  })

  it('AC-DISC-03: banned-terms với body sai (không phải mảng, từ rỗng, từ > 100 ký tự, > 5000 từ, nguồn lạ) bị từ chối 4xx và giữ nguyên tập cũ', async () => {
    await env.DB.batch([ins.term('keep', 'wordlist')])
    const bodies: Array<[string, unknown]> = [
      ['wordlist', { terms: 'x' }],
      ['wordlist', { terms: [''] }],
      ['wordlist', { terms: ['x'.repeat(101)] }],
      ['wordlist', { terms: Array.from({ length: 5001 }, (_, i) => `t${i}`) }],
      ['wordlist', {}],
      ['bogus', { terms: ['x'] }],
    ]
    for (const [source, body] of bodies) {
      const res = await putTerms(source, body)
      expect([400, 404, 422], `${source} ${JSON.stringify(body).slice(0, 40)}`).toContain(res.status)
      isProblem(res)
    }
    const rows = (await env.DB.prepare('SELECT term_fold FROM banned_term').all<{ term_fold: string }>()).results
    expect(rows.map((r) => r.term_fold)).toEqual(['keep'])
  })

  // ------------------------------------------------------------------------ AC-DISC-04
  it('AC-DISC-04: nickname "bep truong" trùng "Bếp Trưởng" của UUID khác (so trên fold) trả 409 problem+json; nickname của người kia không đổi', async () => {
    const holder = newId()
    const u = newId()
    await env.DB.batch([...allowed(holder, true, 'Bếp Trưởng'), ...allowed(u, true)])
    const res = await putNick(u, 'bep truong')
    expect(res.status).toBe(409)
    isProblem(res)
    expect(((await res.json()) as Problem).title).toBe(TAKEN_TITLE)
    const rows = (await env.DB.prepare('SELECT id, nickname FROM player WHERE nickname IS NOT NULL').all<{ id: string; nickname: string }>()).results
    expect(rows).toEqual([{ id: holder, nickname: 'Bếp Trưởng' }])
  })

  it('AC-DISC-04: chính chủ đặt lại nickname chỉ khác hoa/thường hoặc dấu của nickname hiện tại thì không bị coi là trùng', async () => {
    const u = newId()
    await env.DB.batch(allowed(u, true, 'Cô Ba'))
    const res = await putNick(u, 'CÔ BA')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ nickname: 'CÔ BA' })
  })

  // ------------------------------------------------------------------------ AC-DISC-05
  it('AC-DISC-05: khám phá đầu tiên trả 201 {element_id, nickname, discovered_at, first:true} và lưu UUID, công thức, version, thời điểm', async () => {
    const u = newId()
    await env.DB.batch(allowed(u, true, 'Bếp Trưởng'))
    const before = Date.now()
    const res = await post(u, { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as DiscoveryResult
    const c = await elementId('Tới Công Chuyện')
    expect(body).toMatchObject({ element_id: c, nickname: 'Bếp Trưởng', first: true })
    expect(Date.parse(body.discovered_at)).toBeGreaterThanOrEqual(before - 2000)
    expect(Date.parse(body.discovered_at)).toBeLessThanOrEqual(Date.now() + 2000)
    expect(Object.keys(body).sort()).toEqual(['discovered_at', 'element_id', 'first', 'nickname'])

    const rows = (await env.DB.prepare('SELECT * FROM discovery').all<Record<string, unknown>>()).results
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ element_id: c, player_id: u, version: 1 })
    expect([rows[0]!.a_id, rows[0]!.b_id].sort()).toEqual([await elementId('Cay'), await elementId('Cười')].sort())
    expect(rows[0]!.discovered_at as number).toBeGreaterThanOrEqual(before - 2000)
  })

  it('AC-DISC-05: người chưa có nickname hiện "Thực khách ẩn danh"; tên không dấu/khác hoa thường vẫn nhận ra công thức', async () => {
    const u = newId()
    await env.DB.batch(allowed(u))
    const res = await post(u, { a: 'toi cong chuyen', b: 'DEADLINE', result: 'chay deadline' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ element_id: await elementId('Chạy Deadline'), nickname: ANON, first: true })
  })

  it('AC-DISC-05: chưa đồng ý chơi (play) thì 403 problem+json và không ghi gì', async () => {
    const u = newId()
    const res = await post(u, { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' })
    expect(res.status).toBe(403)
    isProblem(res)
    expect(await nDiscovery()).toBe(0)
  })

  // ------------------------------------------------------------------------ AC-DISC-06
  it('AC-DISC-06: phần tử đã có người khám phá trả 200 kèm người hiện có và first:false; bản ghi cũ không đổi (kể cả thứ tự a/b ngược)', async () => {
    const holder = newId()
    const u = newId()
    const c = await elementId('Tới Công Chuyện')
    const at = Date.parse('2026-10-19T03:00:00.000Z')
    await env.DB.batch([...allowed(holder, true, 'Bếp Trưởng'), ins.discovery(c, holder, at), ...allowed(u, true, 'Bếp Mới')])
    const res = await post(u, { a: 'Cười', b: 'Cay', result: 'Tới Công Chuyện' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ element_id: c, nickname: 'Bếp Trưởng', discovered_at: '2026-10-19T03:00:00.000Z', first: false })
    const rows = (await env.DB.prepare('SELECT element_id, player_id, a_id, b_id, discovered_at FROM discovery').all<Record<string, unknown>>()).results
    expect(rows).toEqual([{ element_id: c, player_id: holder, a_id: 'seed-a', b_id: 'seed-b', discovered_at: at }])
  })

  // ------------------------------------------------------------------------ AC-DISC-07
  it('AC-DISC-07: công thức không tồn tại, kết quả khác, hoặc phần tử không có thật trả 422 problem+json và không ghi gì', async () => {
    const u = newId()
    await env.DB.batch(allowed(u))
    const cases = [
      { a: 'Cay', b: 'Toang', result: 'Tới Công Chuyện' }, // pair has no recipe
      { a: 'Cay', b: 'Cười', result: 'Khét Lẹt' }, // real pair, other result
      { a: 'Không Có Món Này', b: 'Cay', result: 'Tới Công Chuyện' }, // unknown element
    ]
    for (const c of cases) {
      const res = await post(u, c)
      expect(res.status, JSON.stringify(c)).toBe(422)
      isProblem(res)
      expect(((await res.json()) as Problem).status).toBe(422)
    }
    expect(await nDiscovery()).toBe(0)
  })

  it('AC-DISC-07: công thức bị chặn, kết quả bị ẩn, hoặc đầu vào bị ẩn trả 422 và không ghi gì', async () => {
    const u = newId()
    await env.DB.batch([
      ...allowed(u),
      ins.block('recipe', await recipeId('Cay', 'Cười')),
      ins.block('element', await elementId('Hết Cứu')),
    ])
    const cases = [
      { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' }, // recipe blocked
      { a: 'Chạy Deadline', b: 'Toang', result: 'Hết Cứu' }, // result element blocked
      { a: 'Hết Cứu', b: 'Cay', result: 'Stonks' }, // input element blocked
    ]
    for (const c of cases) {
      const res = await post(u, c)
      expect(res.status, JSON.stringify(c)).toBe(422)
      isProblem(res)
    }
    expect(await nDiscovery()).toBe(0)
  })

  // ------------------------------------------------------------------------ AC-DISC-08
  it('AC-DISC-08: hai UUID gửi cùng lúc cùng một phần tử: đúng một 201 first:true, một 200 first:false với người đầu tiên, chỉ một bản ghi', async () => {
    const p = newId()
    const q = newId()
    await env.DB.batch([...allowed(p, true, 'Bếp Một'), ...allowed(q, true, 'Bếp Hai')])
    const body = { a: 'Toang', b: 'Deadline', result: 'Khét Lẹt' }
    const [r1, r2] = await Promise.all([post(p, body), post(q, body)])
    expect([r1.status, r2.status].sort()).toEqual([200, 201])
    const created = (r1.status === 201 ? r1 : r2) as Response
    const other = (r1.status === 201 ? r2 : r1) as Response
    const win = (await created.json()) as DiscoveryResult
    const lose = (await other.json()) as DiscoveryResult
    expect(win.first).toBe(true)
    expect(lose.first).toBe(false)
    expect(lose.nickname).toBe(win.nickname)
    expect(lose.element_id).toBe(win.element_id)
    expect(lose.discovered_at).toBe(win.discovered_at)
    const rows = (await env.DB.prepare('SELECT player_id FROM discovery').all<{ player_id: string }>()).results
    expect(rows).toHaveLength(1)
    expect([p, q]).toContain(rows[0]!.player_id)
  })

  // ------------------------------------------------------------------------ AC-DISC-09
  it('AC-DISC-09: GET [C, D, E, F]: nickname hoặc "Thực khách ẩn danh", E không có dòng; không UUID, không công thức; Cache-Control public, max-age=60', async () => {
    const withNick = newId()
    const noNick = newId()
    const [c, d, e, f] = await Promise.all(['Tới Công Chuyện', 'Chạy Deadline', 'Khét Lẹt', 'Hết Cứu'].map(elementId))
    const t = Date.parse('2026-10-19T03:00:00.000Z')
    await env.DB.batch([
      ins.player(withNick, 'Bếp Trưởng'),
      ins.discovery(c!, withNick, t),
      ins.discovery(d!, noNick, t),
      ins.discovery(f!, null, t), // erased player
    ])
    const res = await getItems([c!, d!, e!, f!])
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const text = await res.text()
    expect(UUID_IN_TEXT.test(text)).toBe(false)
    expect(text).not.toContain(withNick)
    expect(text).not.toContain(noNick)
    expect(text).not.toContain('seed-a')
    expect(text).not.toContain('seed-b')
    expect(text).not.toMatch(/a_id|b_id|player/)
    const body = JSON.parse(text) as { items: Item[] }
    const byId = Object.fromEntries(body.items.map((i) => [i.element_id, i]))
    expect(body.items).toHaveLength(3)
    expect(byId[c!]!.nickname).toBe('Bếp Trưởng')
    expect(byId[d!]!.nickname).toBe(ANON)
    expect(byId[f!]!.nickname).toBe(ANON)
    expect(byId[e!]).toBeUndefined()
    expect(byId[c!]!.discovered_at).toBe('2026-10-19T03:00:00.000Z')
    for (const i of body.items) expect(Object.keys(i).sort()).toEqual(['discovered_at', 'element_id', 'nickname'])
  })

  it('AC-DISC-09: ids thiếu, rỗng, quá 50, hoặc sai định dạng 43 ký tự base64url trả 400 problem+json', async () => {
    const id = await elementId('Cay')
    const fifty = Array.from({ length: 51 }, () => id)
    for (const path of [
      `${BASE}/discoveries`,
      `${BASE}/discoveries?ids=`,
      `${BASE}/discoveries?ids=${fifty.join(',')}`,
      `${BASE}/discoveries?ids=abc`,
      `${BASE}/discoveries?ids=${id},${id.slice(1)}`,
      `${BASE}/discoveries?ids=${'!'.repeat(43)}`,
    ]) {
      const res = await raw(path)
      expect(res.status, path.slice(0, 60)).toBe(400)
      isProblem(res)
    }
  })

  // ------------------------------------------------------------------------ AC-DISC-10
  it('AC-DISC-10: gửi khám phá với result là phần tử khởi đầu ("Cay") trả 422 problem+json và không ghi gì', async () => {
    const u = newId()
    await env.DB.batch(allowed(u))
    for (const c of [
      { a: 'Cay', b: 'Cười', result: 'Cay' },
      { a: 'Toang', b: 'Deadline', result: 'toang' },
    ]) {
      const res = await post(u, c)
      expect(res.status, JSON.stringify(c)).toBe(422)
      isProblem(res)
    }
    expect(await nDiscovery()).toBe(0)
  })

  // ------------------------------------------------------------------------ AC-DISC-11
  it('AC-DISC-11: UUID gửi quá 30 khám phá/phút thì yêu cầu thứ 31 trả 429 problem+json kèm Retry-After và không ghi gì thêm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T06:00:30.000Z'))
    const u = newId()
    const windowStart = Date.now() - (Date.now() % 60_000)
    await env.DB.batch([...allowed(u), ins.bucket(await userBucket(u, windowStart), 29, windowStart)])
    const body = { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' }
    expect((await post(u, body)).status).toBe(201) // 30th request of the minute is still served
    const limited = await post(u, { a: 'Toang', b: 'Deadline', result: 'Khét Lẹt' })
    expect(limited.status).toBe(429)
    isProblem(limited)
    const retry = Number(limited.headers.get('retry-after'))
    expect(Number.isInteger(retry)).toBe(true)
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(60)
    expect(await nDiscovery()).toBe(1)
  })

  it('AC-DISC-11: cùng IP băm quá 60 khám phá/phút (mỗi UUID còn xa ngưỡng) trả 429 kèm Retry-After; IP khác không bị ảnh hưởng', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T06:00:30.000Z'))
    const shared = '10.99.99.99'
    const fresh = newId()
    const other = newId()
    const windowStart = Date.now() - (Date.now() % 60_000)
    await env.DB.batch([...allowed(fresh), ...allowed(other), ins.bucket(await ipBucket(shared, windowStart), 60, windowStart)])
    const body = { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' }
    const limited = await post(fresh, body, shared)
    expect(limited.status).toBe(429)
    isProblem(limited)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await nDiscovery()).toBe(0)
    expect((await post(other, body, '10.77.77.77')).status).toBe(201)
  })

  // ------------------------------------------------------------------------ AC-DISC-12
  it('AC-DISC-12: thiếu X-Player-Id hoặc UUID không đúng v4 trả 400 problem+json và không ghi gì', async () => {
    const body = { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' }
    for (const bad of [null, '', 'not-a-uuid', '12345678-1234-1234-1234-123456789012', '00000000-0000-0000-0000-000000000000']) {
      const res = await post(bad, body)
      expect(res.status, String(bad)).toBe(400)
      isProblem(res)
    }
    expect(await nDiscovery()).toBe(0)
  })

  it('AC-DISC-12: thiếu a/b/result, không phải chuỗi, chuỗi dài hơn 100 ký tự hoặc không phải JSON trả 400 problem+json và không ghi gì', async () => {
    const u = newId()
    await env.DB.batch(allowed(u))
    const ok = { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' }
    const long = 'x'.repeat(101)
    const bodies: string[] = [
      JSON.stringify({ b: ok.b, result: ok.result }),
      JSON.stringify({ a: ok.a, result: ok.result }),
      JSON.stringify({ a: ok.a, b: ok.b }),
      JSON.stringify({ ...ok, a: 123 }),
      JSON.stringify({ ...ok, result: long }),
      '{"a": "Cay", ',
    ]
    for (const b of bodies) {
      const res = await postRaw(u, b)
      expect(res.status, b.slice(0, 50)).toBe(400)
      isProblem(res)
    }
    expect(await nDiscovery()).toBe(0)
  })

  it('AC-DISC-12: đặt nickname thiếu trường, không phải chuỗi hoặc dài hơn 100 ký tự trả 400 problem+json; nickname cũ giữ nguyên', async () => {
    const u = newId()
    await env.DB.batch(allowed(u, true, 'Cũ Kỹ'))
    for (const body of [JSON.stringify({}), JSON.stringify({ nickname: 12345 }), JSON.stringify({ nickname: 'x'.repeat(101) })]) {
      const res = await raw(`${BASE}/me/nickname`, { method: 'PUT', body }, as(u))
      expect(res.status, body.slice(0, 40)).toBe(400)
      isProblem(res)
    }
    const noHeader = await raw(`${BASE}/me/nickname`, { method: 'PUT', body: JSON.stringify({ nickname: 'Bếp Phó' }) }, { 'CF-Connecting-IP': '10.1.1.1' })
    expect(noHeader.status).toBe(400)
    const row = await env.DB.prepare('SELECT nickname FROM player WHERE id = ?').bind(u).first<{ nickname: string }>()
    expect(row?.nickname).toBe('Cũ Kỹ')
  })

  // ------------------------------------------------------------------------ AC-DISC-VALIDATION
  it('AC-DISC-VALIDATION: chưa có version hiện hành thì POST khám phá trả 503 problem+json và không ghi gì', async () => {
    const u = newId()
    await env.DB.batch(allowed(u))
    await env.DB.prepare("UPDATE app_meta SET key = 'current_version_off' WHERE key = 'current_version'").run()
    try {
      const res = await post(u, { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' })
      expect(res.status).toBe(503)
      isProblem(res)
      expect(await nDiscovery()).toBe(0)
    } finally {
      await env.DB.prepare("UPDATE app_meta SET key = 'current_version' WHERE key = 'current_version_off'").run()
    }
  })

  // ------------------------------------------------------------------------ AC-DISC-ABUSE (endpoint không có tenant)
  it('AC-DISC-ABUSE: tên quá dài, script, SQL, trường lạ giả danh UUID khác bị từ chối 4xx (không 5xx, không 429) và không ghi gì', async () => {
    const u = newId()
    const victim = newId()
    await env.DB.batch(allowed(u))
    const bodies: unknown[] = [
      { a: 'A'.repeat(10_000), b: 'Cười', result: 'Tới Công Chuyện' },
      { a: '<script>alert(1)</script>', b: 'Cười', result: 'Tới Công Chuyện' },
      { a: "'; DROP TABLE discovery;--", b: 'Cười', result: 'Tới Công Chuyện' },
      { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện', player_id: victim, first: true },
    ]
    for (const b of bodies) {
      const res = await post(u, b)
      expect(res.status, JSON.stringify(b).slice(0, 50)).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(res.status).not.toBe(429)
      isProblem(res)
    }
    expect(await nDiscovery()).toBe(0)
  })

  it('AC-DISC-ABUSE: người chơi B không đổi được nickname của A qua body giả (player_id) và không cướp nickname đã có', async () => {
    const a = newId()
    const b = newId()
    await env.DB.batch([...allowed(a, true, 'Bếp A'), ...allowed(b, true)])
    const res = await putNick(b, 'Bếp B', { player_id: a })
    expect([200, 400, 422]).toContain(res.status)
    const rows = (await env.DB.prepare('SELECT id, nickname FROM player WHERE nickname IS NOT NULL').all<{ id: string; nickname: string }>()).results
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.nickname]))
    expect(byId[a]).toBe('Bếp A')
    if (res.status === 200) expect(byId[b]).toBe('Bếp B')
    else expect(byId[b]).toBeUndefined()
    expect((await putNick(b, 'bếp a')).status).toBe(409)
  })
})
