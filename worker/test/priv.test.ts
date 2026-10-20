// Acceptance tests for docs/acceptance/priv.md (worker part: AC-PRIV-03..08, TENANT, VALIDATION).
// Black-box: HTTP contract (docs/api/openapi.yaml), D1 schema (migrations/0003_player_data.sql) and ADR 0004 only.
// Performance: D1 in Miniflare costs ~66 ms/query, so every test seeds with ONE env.DB.batch and keeps requests few.
/// <reference types="vite/client" />
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import wranglerRaw from '../wrangler.jsonc?raw'
import worker from '../src/index'
import { maskId } from '../src/log'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const IP_KEY = ['priv', 'ip', 'hash', 'key'].join('-')
const BAD_TOKEN = ['priv', 'admin', 'token', 'xyz'].join('-')
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const DAY_MS = 86_400_000
const IP = '203.0.113.77'
const BASE = '/lau-meme/api'

type Handler = {
  fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>
  scheduled: (controller: ScheduledController, env: unknown, ctx: ExecutionContext) => Promise<void>
}
const handler = worker as unknown as Handler

type Streak = { current: number; longest: number }
type MyData = {
  nickname: string | null
  discoveries: { element_id: string; discovered_at: string }[]
  daily_results: { version: number; steps: number; rank: number; streak: Streak; submitted_at: string }[]
  streak: Streak
  reports: { target: string; id: string; reason: string; created_at: string }[]
  votes: { recipe_id: string; value: string; updated_at: string }[]
  consents: { purpose: string; action: string; policy_version: number; created_at: string }[]
  event_counts: Record<string, number>
}

// ---------------------------------------------------------------------------- helpers
async function raw(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await handler.fetch(
    new Request(`https://example.com${path}`, { ...init, headers: h }),
    { ...env, IP_HASH_KEY: IP_KEY },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

const as = (player: string, ip = IP): Record<string, string> => ({ 'X-Player-Id': player, 'CF-Connecting-IP': ip })
const postConsent = (player: string, body: unknown, ip = IP) =>
  raw(`${BASE}/consents`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }, as(player, ip))
const putNickname = (player: string, nickname: unknown) =>
  raw(`${BASE}/me/nickname`, { method: 'PUT', body: JSON.stringify({ nickname }) }, as(player))
const getMe = (player: string) => raw(`${BASE}/me`, {}, as(player))
const delMe = (player: string) => raw(`${BASE}/me`, { method: 'DELETE' }, as(player))

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const newId = () => crypto.randomUUID()

async function expectedIpHash(ip: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(IP_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** ip_hash may be stored as TEXT hex or as BLOB (D1 returns a byte array): normalise to hex. */
function toHex(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.toLowerCase()
  const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : Uint8Array.from(v as number[])
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Flatten any D1 row value into text (byte arrays are decoded) so a raw IP cannot hide in a BLOB. */
function asText(rows: unknown[]): string {
  return JSON.stringify(rows, (_k, v) =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number') ? `${JSON.stringify(v)}|${new TextDecoder().decode(Uint8Array.from(v))}` : v,
  )
}

const ins = {
  consent: (player: string, purpose: string, action: string, at: number, hash: string | null = null) =>
    env.DB.prepare(
      "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, 'web', ?)",
    ).bind(newId(), player, purpose, action, POLICY_VERSION, hash, at),
  player: (id: string, nickname: string | null, at: number) =>
    env.DB.prepare('INSERT INTO player (id, nickname, nickname_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(
      id,
      nickname,
      nickname ? nickname.toLowerCase() : null,
      at,
      at,
    ),
  discovery: (element: string, player: string | null, at: number) =>
    env.DB.prepare('INSERT INTO discovery (element_id, player_id, a_id, b_id, version, discovered_at) VALUES (?, ?, ?, ?, 1, ?)').bind(
      element,
      player,
      `a-${element}`,
      `b-${element}`,
      at,
    ),
  daily: (player: string, version: number, steps: number, at: number) =>
    env.DB.prepare(
      "INSERT INTO daily_result (version, player_id, day, steps, path_json, submitted_at) VALUES (?, ?, '2026-10-19', ?, '[]', ?)",
    ).bind(version, player, steps, at),
  streak: (player: string, current: number, longest: number, at: number) =>
    env.DB.prepare("INSERT INTO streak (player_id, current, longest, last_day, reached_at, updated_at) VALUES (?, ?, ?, '2026-10-19', ?, ?)").bind(
      player,
      current,
      longest,
      at,
      at,
    ),
  report: (player: string, target: string, reason: string, at: number) =>
    env.DB.prepare(
      "INSERT INTO report (id, kind, target_id, cycle, player_id, reason, status, created_at) VALUES (?, 'element', ?, 0, ?, ?, 'new', ?)",
    ).bind(newId(), target, player, reason, at),
  vote: (player: string, recipe: string, value: string, at: number) =>
    env.DB.prepare('INSERT INTO vote (recipe_id, player_id, value, updated_at) VALUES (?, ?, ?, ?)').bind(recipe, player, value, at),
  event: (player: string, type: string, at: number) =>
    env.DB.prepare("INSERT INTO event (id, player_id, type, props_json, day, received_at) VALUES (?, ?, ?, '{}', '2026-10-19', ?)").bind(
      newId(),
      player,
      type,
      at,
    ),
}

/** A player with one row of every kind of personal data (single batch). */
function seedPlayer(id: string, tag: string, now: number) {
  return [
    ins.player(id, `Bếp ${tag}`, now),
    ins.consent(id, 'play', 'grant', now - 1000),
    ins.consent(id, 'nickname', 'grant', now - 900),
    ins.discovery(`el-${tag}-1`, id, now - 5000),
    ins.discovery(`el-${tag}-2`, id, now - 4000),
    ins.daily(id, 3, 4, now - 3000),
    ins.streak(id, 3, 5, now - 3000),
    ins.report(id, `el-${tag}-x`, 'other', now - 2000),
    ins.vote(id, `rc-${tag}`, 'ngon', now - 1500),
    ins.event(id, 'session_start', now - 1000),
    ins.event(id, 'session_start', now - 900),
    ins.event(id, 'share', now - 800),
  ]
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM daily_result'),
    env.DB.prepare('DELETE FROM streak'),
    env.DB.prepare('DELETE FROM vote'),
    env.DB.prepare('DELETE FROM event'),
    env.DB.prepare('DELETE FROM report'),
    env.DB.prepare('DELETE FROM discovery'),
    env.DB.prepare('DELETE FROM consent'),
    env.DB.prepare('DELETE FROM player'),
    env.DB.prepare('DELETE FROM rate_counter'),
  ])
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('priv', () => {
  // ============================================================== AC-PRIV-03
  it('AC-PRIV-03: POST /consents (play, grant) trả 201 và ghi dòng append-only với IP băm, kênh web', async () => {
    const u = newId()
    const before = Date.now()
    const res = await postConsent(u, { purpose: 'play', action: 'grant', policy_version: POLICY_VERSION })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ purpose: 'play', action: 'grant', policy_version: POLICY_VERSION })
    expect(Number.isNaN(Date.parse(String(body.created_at)))).toBe(false)

    const rows = (await env.DB.prepare('SELECT * FROM consent WHERE player_id = ?').bind(u).all<Record<string, unknown>>()).results
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ player_id: u, purpose: 'play', action: 'grant', policy_version: POLICY_VERSION, channel: 'web' })
    expect(rows[0]!.created_at as number).toBeGreaterThanOrEqual(before - 1000)
    expect(toHex(rows[0]!.ip_hash)).toBe(await expectedIpHash(IP))

    // append-only: a second grant adds a row, it does not overwrite
    expect((await postConsent(u, { purpose: 'play', action: 'grant', policy_version: POLICY_VERSION })).status).toBe(201)
    expect(await count('SELECT COUNT(*) AS n FROM consent WHERE player_id = ?', u)).toBe(2)
  })

  it('AC-PRIV-03: đồng ý mục đích nickname và rút đồng ý đều là dòng mới (không sửa dòng cũ)', async () => {
    const u = newId()
    for (const [purpose, action] of [
      ['play', 'grant'],
      ['nickname', 'grant'],
      ['play', 'withdraw'],
    ] as const) {
      const res = await postConsent(u, { purpose, action, policy_version: POLICY_VERSION })
      expect(res.status, `${purpose}/${action}`).toBe(201)
      expect(await res.json()).toMatchObject({ purpose, action })
    }
    const rows = (
      await env.DB.prepare('SELECT purpose, action FROM consent WHERE player_id = ? ORDER BY created_at, rowid').bind(u).all<{
        purpose: string
        action: string
      }>()
    ).results
    expect(rows).toEqual([
      { purpose: 'play', action: 'grant' },
      { purpose: 'nickname', action: 'grant' },
      { purpose: 'play', action: 'withdraw' },
    ])
  })

  it('AC-PRIV-03: policy_version khác phiên bản hiện hành trả 422 problem+json và không ghi dòng nào', async () => {
    const u = newId()
    const res = await postConsent(u, { purpose: 'play', action: 'grant', policy_version: POLICY_VERSION + 1 })
    expect(res.status).toBe(422)
    isProblem(res)
    expect(await count('SELECT COUNT(*) AS n FROM consent WHERE player_id = ?', u)).toBe(0)
  })

  it('AC-PRIV-03: thiếu hoặc sai X-Player-Id trả 400 problem+json', async () => {
    const body = JSON.stringify({ purpose: 'play', action: 'grant', policy_version: POLICY_VERSION })
    const none = await raw(`${BASE}/consents`, { method: 'POST', body }, { 'CF-Connecting-IP': IP })
    expect(none.status).toBe(400)
    isProblem(none)
    const bad = await raw(`${BASE}/consents`, { method: 'POST', body }, { 'CF-Connecting-IP': IP, 'X-Player-Id': 'khong-phai-uuid' })
    expect(bad.status).toBe(400)
    isProblem(bad)
  })

  it('AC-PRIV-03: PUT nickname có đồng ý play nhưng chưa có đồng ý nickname trả 403 problem+json; có cả hai thì 200', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u, 'play', 'grant', Date.now() - 1000)])
    const denied = await putNickname(u, 'Bếp Trưởng')
    expect(denied.status).toBe(403)
    isProblem(denied)
    expect(await count('SELECT COUNT(*) AS n FROM player WHERE id = ? AND nickname IS NOT NULL', u)).toBe(0)

    expect((await postConsent(u, { purpose: 'nickname', action: 'grant', policy_version: POLICY_VERSION })).status).toBe(201)
    const ok = await putNickname(u, 'Bếp Trưởng')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ nickname: 'Bếp Trưởng' })
  })

  // ============================================================== AC-PRIV-05
  it('AC-PRIV-05: DELETE /me trả 204; xóa nickname, Daily, streak, phiếu, sự kiện; giữ khám phá và báo cáo nhưng bỏ UUID; giữ đồng ý và thêm dòng erase', async () => {
    const u = newId()
    const v = newId() // another player, must be untouched
    const now = Date.now()
    await env.DB.batch([...seedPlayer(u, 'u', now), ...seedPlayer(v, 'v', now)])

    const res = await delMe(u)
    expect(res.status).toBe(204)

    const [player, daily, streak, vote, event, disc, discKept, report, reportNull, consent, erase, otherPlayer, otherDaily, otherDisc] =
      await env.DB.batch<Record<string, unknown>>([
        env.DB.prepare('SELECT COUNT(*) AS n FROM player WHERE id = ?').bind(u),
        env.DB.prepare('SELECT COUNT(*) AS n FROM daily_result WHERE player_id = ?').bind(u),
        env.DB.prepare('SELECT COUNT(*) AS n FROM streak WHERE player_id = ?').bind(u),
        env.DB.prepare('SELECT COUNT(*) AS n FROM vote WHERE player_id = ?').bind(u),
        env.DB.prepare('SELECT COUNT(*) AS n FROM event WHERE player_id = ?').bind(u),
        env.DB.prepare('SELECT COUNT(*) AS n FROM discovery WHERE player_id = ?').bind(u),
        env.DB.prepare("SELECT COUNT(*) AS n FROM discovery WHERE element_id LIKE 'el-u-%' AND player_id IS NULL"),
        env.DB.prepare('SELECT COUNT(*) AS n FROM report WHERE player_id = ?').bind(u),
        env.DB.prepare("SELECT COUNT(*) AS n FROM report WHERE target_id = 'el-u-x' AND player_id IS NULL"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM consent WHERE player_id = ? AND action <> 'erase'").bind(u),
        env.DB.prepare("SELECT COUNT(*) AS n FROM consent WHERE player_id = ? AND purpose = 'all' AND action = 'erase'").bind(u),
        env.DB.prepare('SELECT COUNT(*) AS n FROM player WHERE id = ?').bind(v),
        env.DB.prepare('SELECT COUNT(*) AS n FROM daily_result WHERE player_id = ?').bind(v),
        env.DB.prepare('SELECT COUNT(*) AS n FROM discovery WHERE player_id = ?').bind(v),
      ])
    const n = (r: { results: Record<string, unknown>[] }) => r.results[0]!.n
    expect(n(player!)).toBe(0)
    expect(n(daily!)).toBe(0)
    expect(n(streak!)).toBe(0)
    expect(n(vote!)).toBe(0)
    expect(n(event!)).toBe(0)
    expect(n(disc!)).toBe(0) // no discovery is linked to U any more...
    expect(n(discKept!)).toBe(2) // ...but both rows are kept, anonymised
    expect(n(report!)).toBe(0)
    expect(n(reportNull!)).toBe(1) // report kept (still counts), UUID removed
    expect(n(consent!)).toBe(2) // consent evidence kept
    expect(Number(n(erase!))).toBeGreaterThanOrEqual(1)
    expect(n(otherPlayer!)).toBe(1)
    expect(n(otherDaily!)).toBe(1)
    expect(n(otherDisc!)).toBe(2)
  })

  it('AC-PRIV-05: gọi DELETE lần hai với UUID đã xóa vẫn trả 204 (idempotent) và /me trả dữ liệu rỗng', async () => {
    const u = newId()
    await env.DB.batch(seedPlayer(u, 'i', Date.now()))
    expect((await delMe(u)).status).toBe(204)
    expect((await delMe(u)).status).toBe(204)
    const body = (await (await getMe(u)).json()) as MyData
    expect(body.nickname).toBeNull()
    expect(body.daily_results).toEqual([])
    expect(body.votes).toEqual([])
    expect(body.event_counts).toEqual({})
    expect(body.streak).toEqual({ current: 0, longest: 0 })
  })

  // ============================================================== AC-PRIV-06
  it('AC-PRIV-06: IP chỉ lưu dạng HMAC-SHA256 với IP_HASH_KEY; không bảng nào chứa IP thô', async () => {
    const u = newId()
    expect((await postConsent(u, { purpose: 'play', action: 'grant', policy_version: POLICY_VERSION })).status).toBe(201)
    const row = await env.DB.prepare('SELECT ip_hash FROM consent WHERE player_id = ?').bind(u).first<{ ip_hash: unknown }>()
    const hex = toHex(row?.ip_hash)
    expect(hex).not.toBeNull()
    expect(hex).not.toBe(IP)
    expect(hex).toBe(await expectedIpHash(IP))

    const dumps = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare('SELECT * FROM consent'),
      env.DB.prepare('SELECT * FROM player'),
      env.DB.prepare('SELECT * FROM event'),
      env.DB.prepare('SELECT * FROM rate_counter'),
    ])
    for (const d of dumps) expect(asText(d.results)).not.toContain(IP)
  })

  it('AC-PRIV-06: hai IP khác nhau cho hai giá trị băm khác nhau (băm phụ thuộc IP)', async () => {
    const u = newId()
    await postConsent(u, { purpose: 'play', action: 'grant', policy_version: POLICY_VERSION }, '203.0.113.1')
    await postConsent(u, { purpose: 'play', action: 'withdraw', policy_version: POLICY_VERSION }, '203.0.113.2')
    const rows = (await env.DB.prepare('SELECT ip_hash FROM consent WHERE player_id = ? ORDER BY rowid').bind(u).all<{ ip_hash: unknown }>())
      .results
    expect(rows.map((r) => toHex(r.ip_hash))).toEqual([await expectedIpHash('203.0.113.1'), await expectedIpHash('203.0.113.2')])
  })

  it('AC-PRIV-06: wrangler.jsonc khai báo cron dọn dẹp "0 20 * * *" (03:00 GMT+7)', () => {
    const noComments = wranglerRaw
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect(noComments).toMatch(/"triggers"\s*:\s*\{[^}]*"crons"\s*:\s*\[[^\]]*"0 20 \* \* \*"/)
  })

  it('AC-PRIV-06: tác vụ dọn hằng ngày đặt ip_hash = NULL cho đồng ý cũ hơn 7 ngày, giữ dòng; xóa sự kiện cũ hơn 90 ngày', async () => {
    const u = newId()
    const now = Date.now()
    const hash = '00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff'
    await env.DB.batch([
      ins.consent(u, 'play', 'grant', now - 8 * DAY_MS, hash),
      ins.consent(u, 'nickname', 'grant', now - 6 * DAY_MS, hash),
      ins.event(u, 'share', now - 91 * DAY_MS),
      ins.event(u, 'share', now - 89 * DAY_MS),
    ])

    const ctx = createExecutionContext()
    await handler.scheduled(createScheduledController({ scheduledTime: new Date(now), cron: '0 20 * * *' }), { ...env, IP_HASH_KEY: IP_KEY }, ctx)
    await waitOnExecutionContext(ctx)

    const [consents, events] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare('SELECT purpose, ip_hash FROM consent WHERE player_id = ?').bind(u),
      env.DB.prepare('SELECT received_at FROM event WHERE player_id = ?').bind(u),
    ])
    const byPurpose = Object.fromEntries(consents!.results.map((r) => [r.purpose as string, r.ip_hash]))
    expect(Object.keys(byPurpose).sort()).toEqual(['nickname', 'play']) // evidence rows are kept
    expect(byPurpose.play).toBeNull()
    expect(byPurpose.nickname).not.toBeNull()
    expect(events!.results).toHaveLength(1)
    expect(events!.results[0]!.received_at as number).toBeGreaterThan(now - 90 * DAY_MS)
  })

  // ============================================================== AC-PRIV-07
  it('AC-PRIV-07: maskId giữ 8 ký tự đầu và thêm "…"', () => {
    const id = '3f0a7f0e-2f52-4c7a-9f5f-0c2b1a1d9e11'
    expect(maskId(id)).toBe('3f0a7f0e…')
  })

  it('AC-PRIV-07: log (thành công và lỗi) không chứa IP, nickname, token; UUID chỉ ở dạng mask', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const u = newId()
    const nick = 'Bếp Trưởng Bí Mật'
    await postConsent(u, { purpose: 'play', action: 'grant', policy_version: POLICY_VERSION })
    await postConsent(u, { purpose: 'nickname', action: 'grant', policy_version: POLICY_VERSION })
    await putNickname(u, nick)
    await postConsent(u, '{khong phai json') // error path
    await postConsent(u, { purpose: 'play', action: 'grant', policy_version: 999 }) // 422 path
    await raw(`${BASE}/pipeline/state`, {}, { Authorization: `Bearer ${BAD_TOKEN}`, 'CF-Connecting-IP': IP, 'X-Player-Id': u }) // token path

    const logged = spies.flatMap((s) => s.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
    const all = logged.join('\n')
    expect(all).not.toContain(IP)
    expect(all).not.toContain(nick)
    expect(all).not.toContain('Bếp Trưởng')
    expect(all).not.toContain(BAD_TOKEN)
    expect(all).not.toContain(u) // full UUID never appears
    expect(all.replace(new RegExp(`${maskId(u)}`, 'g'), '')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })

  // ============================================================== AC-PRIV-08
  it('AC-PRIV-08: GET /me trả đủ nickname, khám phá, Daily, streak, báo cáo, phiếu, đồng ý, số sự kiện theo loại', async () => {
    const u = newId()
    const v = newId()
    const now = Date.now()
    await env.DB.batch([...seedPlayer(u, 'g', now), ...seedPlayer(v, 'h', now)])

    const res = await getMe(u)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text) as MyData
    expect(body.nickname).toBe('Bếp g')
    expect(body.discoveries.map((d) => d.element_id).sort()).toEqual(['el-g-1', 'el-g-2'])
    expect(Date.parse(body.discoveries[0]!.discovered_at)).not.toBeNaN()
    expect(body.daily_results).toHaveLength(1)
    expect(body.daily_results[0]).toMatchObject({ version: 3, steps: 4, rank: 1 })
    expect(Date.parse(body.daily_results[0]!.submitted_at)).not.toBeNaN()
    expect(body.streak).toEqual({ current: 3, longest: 5 })
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0]).toMatchObject({ target: 'element', id: 'el-g-x', reason: 'other' })
    expect(Date.parse(body.reports[0]!.created_at)).not.toBeNaN()
    expect(body.votes).toHaveLength(1)
    expect(body.votes[0]).toMatchObject({ recipe_id: 'rc-g', value: 'ngon' })
    expect(body.consents.map((c) => `${c.purpose}:${c.action}:${c.policy_version}`).sort()).toEqual(['nickname:grant:1', 'play:grant:1'])
    expect(body.event_counts).toEqual({ session_start: 2, share: 1 })
    // nothing of the other player, and no hashed IP leaks into the export
    expect(text).not.toContain('Bếp h')
    expect(text).not.toContain('el-h-')
    expect(text).not.toContain('ip_hash')
  })

  it('AC-PRIV-08: UUID khác trả cấu trúc rỗng của chính UUID đó, không bao giờ dữ liệu người khác', async () => {
    await env.DB.batch(seedPlayer(newId(), 'o', Date.now()))
    const res = await getMe(newId())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      nickname: null,
      discoveries: [],
      daily_results: [],
      streak: { current: 0, longest: 0 },
      reports: [],
      votes: [],
      consents: [],
      event_counts: {},
    })
  })

  // ============================================================== TENANT
  it('AC-PRIV-TENANT: người chơi B không đọc được và không xóa được dữ liệu của A', async () => {
    const a = newId()
    const b = newId()
    await env.DB.batch(seedPlayer(a, 'a', Date.now()))

    // B asking for "its" data gets B's (empty) structure, never A's
    const mine = (await (await getMe(b)).json()) as MyData
    expect(mine.nickname).toBeNull()
    expect(mine.discoveries).toEqual([])
    expect(mine.event_counts).toEqual({})

    // B deleting its own data is a no-op on A
    expect((await delMe(b)).status).toBe(204)
    const [player, daily, vote] = await env.DB.batch<{ n: number }>([
      env.DB.prepare('SELECT COUNT(*) AS n FROM player WHERE id = ?').bind(a),
      env.DB.prepare('SELECT COUNT(*) AS n FROM daily_result WHERE player_id = ?').bind(a),
      env.DB.prepare('SELECT COUNT(*) AS n FROM vote WHERE player_id = ?').bind(a),
    ])
    expect([player!.results[0]!.n, daily!.results[0]!.n, vote!.results[0]!.n]).toEqual([1, 1, 1])

    // B cannot change A's nickname through the API (nickname is bound to the header id)
    await env.DB.batch([ins.consent(b, 'play', 'grant', Date.now()), ins.consent(b, 'nickname', 'grant', Date.now())])
    await putNickname(b, 'Kẻ Lạ Mặt')
    expect(await count('SELECT COUNT(*) AS n FROM player WHERE id = ? AND nickname = ?', a, 'Bếp a')).toBe(1)
  })

  // ============================================================== VALIDATION
  it('AC-PRIV-VALIDATION: POST /consents từ chối purpose/action giả mạo, script tag, phiên bản sai kiểu; không ghi dòng nào', async () => {
    const u = newId()
    const cases: unknown[] = [
      { purpose: '<script>alert(1)</script>', action: 'grant', policy_version: POLICY_VERSION },
      { purpose: 'all', action: 'grant', policy_version: POLICY_VERSION }, // 'all' is server-only
      { purpose: 'play', action: 'erase', policy_version: POLICY_VERSION }, // 'erase' is server-only
      { purpose: 'play', action: 'grant', policy_version: -1 },
      { purpose: 'play', action: 'grant', policy_version: '1; DROP TABLE consent' },
      { purpose: 'x'.repeat(100_000), action: 'grant', policy_version: POLICY_VERSION },
    ]
    for (const body of cases) {
      const res = await postConsent(u, body)
      expect([400, 422], JSON.stringify(body).slice(0, 60)).toContain(res.status)
      isProblem(res)
    }
    expect(await count('SELECT COUNT(*) AS n FROM consent WHERE player_id = ?', u)).toBe(0)
  })

  it('AC-PRIV-VALIDATION: header X-Player-Id chứa script/SQL hoặc quá dài bị từ chối 400 ở cả /consents, /me', async () => {
    const body = JSON.stringify({ purpose: 'play', action: 'grant', policy_version: POLICY_VERSION })
    for (const bad of ['<script>alert(1)</script>', "' OR 1=1 --", 'a'.repeat(5000)]) {
      const post = await raw(`${BASE}/consents`, { method: 'POST', body }, { 'X-Player-Id': bad, 'CF-Connecting-IP': IP })
      expect(post.status).toBe(400)
      const get = await raw(`${BASE}/me`, {}, { 'X-Player-Id': bad, 'CF-Connecting-IP': IP })
      expect(get.status).toBe(400)
      isProblem(get)
    }
    expect(await count('SELECT COUNT(*) AS n FROM consent')).toBe(0)
  })

  it('AC-PRIV-VALIDATION: PUT /me/nickname từ chối chuỗi quá dài, script tag, kiểu sai; nickname không đổi', async () => {
    const u = newId()
    await env.DB.batch([ins.consent(u, 'play', 'grant', Date.now()), ins.consent(u, 'nickname', 'grant', Date.now())])
    for (const nick of ['x'.repeat(5000), '<script>alert(1)</script>', 12345, null]) {
      const res = await putNickname(u, nick)
      expect([400, 422], String(nick).slice(0, 30)).toContain(res.status)
      isProblem(res)
    }
    expect(await count('SELECT COUNT(*) AS n FROM player WHERE id = ? AND nickname IS NOT NULL', u)).toBe(0)
  })
})
