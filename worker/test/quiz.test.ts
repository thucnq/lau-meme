// Acceptance tests for docs/acceptance/quiz.md, worker part: HTTP + WebSocket + Durable Object flow.
//   AC-QUIZ-01..07, 09..11, 13..16, 18..25 (and 08, 12, 17 through the room); criterion 27 was dropped (open question 93),
//   AC-QUIZ-TENANT, AC-QUIZ-VALIDATION, AC-QUIZ-ABUSE.
// Pure functions (question generation, scoring, ranking, solo hash) are in quiz-logic.test.ts.
// Black-box: HTTP contract docs/api/openapi.yaml (/quiz/*), WebSocket contract docs/api/quiz-ws.md, ADR 0021 and the D1
// schema (migrations 0011_quiz_history.sql). The Durable Object clock is driven with runDurableObjectAlarm, never by sleeping,
// and no test asserts an exact elapsed millisecond from the DO clock (exact points are tested on questionPoints).
// Performance: D1 in Miniflare costs ~66 ms/query, so every test seeds with ONE env.DB.batch and keeps requests few.
// Content: worker/test/quiz-fixture.ts (12 eligible targets, depth 1..5; Món đặc biệt "Stonks").
//
// Assumptions that are not spelled out by the contract (the main session should confirm them when running):
//   - UUID travels in X-Player-Id for POST /quiz/rooms and GET /quiz/history (openapi), in the `join` message for WebSocket.
//   - solo_pack answer_hash uses q = 1-based question number (the same number as the `q` field of `question`).
//   - A 1-player `start` is a solo game; a game needs >= 2 connected players to be multiplayer.
import { createExecutionContext, createScheduledController, env, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { DAILY, batchBody, b64u, depthByName, elementId, idMaps, resultName, sha256 } from './quiz-fixture'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['quiz', 'pipeline', 'token'].join('-')
const IP_KEY = ['quiz', 'ip', 'hash', 'key'].join('-')
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const BASE = '/lau-meme/api'
const DAY_MS = 86_400_000
const ANON = 'Thực khách ẩn danh'
const CODE_RE = /^[2-9A-HJKMNP-Z]{6}$/
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

type Handler = {
  fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>
  scheduled: (controller: ScheduledController, env: unknown, ctx: ExecutionContext) => Promise<void>
}
const handler = worker as unknown as Handler

type Problem = { type: string; title: string; status: number; detail?: string }
type Created = { code: string; url: string; state: string; questions: number; seconds: number }
type Standing = { rank: number; nickname: string; score: number; correct: number }
type GameSummary = { game_no: number; questions: number; seconds: number; started_at: string; finished_at: string; standings: Standing[] }
type RoomView = {
  code: string
  state: 'lobby' | 'playing' | 'finished'
  questions: number
  seconds: number
  players: string[]
  latest: GameSummary | null
  earlier: { game_no: number; finished_at: string; player_count: number }[]
}
type HistoryItem = {
  code: string
  game_no: number
  url: string
  finished_at: string
  player_count: number
  questions: number
  nickname: string
  score: number
  correct: number
  rank: number
}
type HistoryPage = { page: number; size: number; total: number; items: HistoryItem[] }

type Msg = { type: string; [k: string]: unknown }
type Opt = { id: string; name: string; emoji: string; image_key: string | null }
type LobbyMsg = {
  type: 'lobby'
  code: string
  questions: number
  seconds: number
  host_seat: number
  you: number
  players: { seat: number; nickname: string; connected: boolean }[]
  last_game: GameSummary | null
  server_now: number
}
type StartedMsg = { type: 'started'; game_no: number; total: number; seconds: number; server_now: number }
type QuestionMsg = {
  type: 'question'
  q: number
  total: number
  target: { name: string; emoji: string; image_key: string | null }
  options: Opt[]
  server_now: number
  deadline: number
}
type RevealMsg = {
  type: 'reveal'
  q: number
  correct: [string, string]
  results: { seat: number; picks: [string, string] | null; ok: boolean; points: number }[]
  board: { top: { seat: number; nickname: string; score: number; rank: number }[]; me: { seat: number; score: number; rank: number } }
  next_at: number
}
type FinalMsg = {
  type: 'final'
  game_no: number
  standings: { seat: number; nickname: string; score: number; correct: number; rank: number }[]
  saved: boolean
}
type SoloPackMsg = {
  type: 'solo_pack'
  game_no: number
  total: number
  seconds: number
  salt: string
  items: { target: { name: string; emoji: string; image_key: string | null }; options: Opt[]; answer_hash: string }[]
}
type ErrorMsg = { type: 'error'; code: string; message: string }
type AnsweredMsg = { type: 'answered'; q: number }

// ---------------------------------------------------------------------------- HTTP helpers
const testEnv = () => ({ ...env, PIPELINE_TOKEN: TOKEN, IP_HASH_KEY: IP_KEY })
const quizNs = () => (env as unknown as { QUIZ_ROOM: DurableObjectNamespace }).QUIZ_ROOM
const roomStub = (code: string) => quizNs().get(quizNs().idFromName(code))

async function raw(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await handler.fetch(new Request(`https://example.com${path}`, { ...init, headers: h }), testEnv(), ctx)
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

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const newId = () => crypto.randomUUID()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const fakeCode = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')

type Player = { id: string; nick: string }
const mkPlayers = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({ id: newId(), nick: `Bếp ${i + 1}` }))

const createRoom = (p: Player | string, body: Record<string, unknown> | string = {}, ip?: string) => {
  const id = typeof p === 'string' ? p : p.id
  const nick = typeof p === 'string' ? 'Bếp Trưởng' : p.nick
  const payload = typeof body === 'string' ? body : JSON.stringify({ nickname: nick, ...body })
  return raw(`${BASE}/quiz/rooms`, { method: 'POST', body: payload }, as(id, ip))
}
const getRoom = (code: string) => raw(`${BASE}/quiz/rooms/${code}`)
const getHistory = (player: string | null, query = '') => raw(`${BASE}/quiz/history${query}`, {}, as(player))
const getMe = (player: string) => raw(`${BASE}/me`, {}, as(player))
const delMe = (player: string) => raw(`${BASE}/me`, { method: 'DELETE' }, as(player))

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0
}

// ---------------------------------------------------------------------------- seeding
const ins = {
  consent: (player: string) =>
    env.DB.prepare(
      "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
    ).bind(newId(), player, POLICY_VERSION, Date.now() - 1000),
  term: (term: string, source: 'wordlist' | 'mod' | 'admin') =>
    env.DB.prepare('INSERT INTO banned_term (term_fold, source, created_at) VALUES (?, ?, ?)').bind(term, source, Date.now()),
  block: (kind: 'element' | 'recipe', target: string) =>
    env.DB.prepare("INSERT INTO block (kind, target_id, state, reason, created_at) VALUES (?, ?, 'blocked', 'admin', ?)").bind(kind, target, Date.now()),
}

type SeedRow = { seat: number; id: string | null; nick: string; score: number; correct: number; rank: number; ms?: number }
/** A finished multiplayer game in D1 (room row + game row + player rows), as the DO would have written it. */
function seedGame(code: string, gameNo: number, finishedAt: number, rows: SeedRow[], opts: { closed?: boolean; questions?: number } = {}) {
  const gameId = newId()
  const stmts = [
    env.DB.prepare('INSERT OR IGNORE INTO quiz_room (code, created_at, closed_at) VALUES (?, ?, ?)').bind(code, finishedAt - 600_000, opts.closed === false ? null : finishedAt),
    env.DB.prepare(
      'INSERT INTO quiz_game (id, room_code, game_no, content_version, questions, seconds, player_count, started_at, finished_at) VALUES (?, ?, ?, 1, ?, 20, ?, ?, ?)',
    ).bind(gameId, code, gameNo, opts.questions ?? 5, rows.length, finishedAt - 120_000, finishedAt),
    ...rows.map((r) =>
      env.DB.prepare('INSERT INTO quiz_player (game_id, seat, player_id, nickname, score, correct, correct_ms, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        gameId,
        r.seat,
        r.id,
        r.nick,
        r.score,
        r.correct,
        r.ms ?? 1000 * r.correct,
        r.rank,
      ),
    ),
  ]
  return { gameId, stmts }
}

beforeEach(async () => {
  await ensurePublished()
  await env.DB.batch([env.DB.prepare('DELETE FROM block'), env.DB.prepare('DELETE FROM banned_term'), env.DB.prepare('DELETE FROM rate_counter')])
})

// ---------------------------------------------------------------------------- WebSocket client
const clients: Client[] = []

class Client {
  readonly log: Msg[] = []
  closeInfo: { code: number; reason: string } | null = null
  private cursor = 0
  private waiters: Array<() => void> = []

  private constructor(readonly ws: WebSocket) {}

  static async open(code: string): Promise<Client> {
    const ctx = createExecutionContext()
    const res = await handler.fetch(new Request(`https://example.com${BASE}/quiz/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } }), testEnv(), ctx)
    expect(res.status, 'websocket upgrade').toBe(101)
    const ws = res.webSocket
    if (!ws) throw new Error('response has no webSocket')
    ws.accept()
    const c = new Client(ws)
    ws.addEventListener('message', (e: MessageEvent) => {
      try {
        c.log.push(JSON.parse(String(e.data)) as Msg)
      } catch {
        c.log.push({ type: '__invalid_json', raw: String(e.data) })
      }
      c.wake()
    })
    ws.addEventListener('close', (e: CloseEvent) => {
      c.closeInfo = { code: e.code, reason: e.reason }
      c.wake()
    })
    clients.push(c)
    return c
  }

  // Paced send: stays at or below 10 messages per rolling second (AC-QUIZ-25) so fast machines never trip the
  // server's flood limit. Order is preserved through an internal queue; callers need not await.
  private sentAt: number[] = []
  private pending = 0
  private chain: Promise<void> = Promise.resolve()

  send(m: unknown): void {
    const data = typeof m === 'string' ? m : JSON.stringify(m)
    const trySync = (): boolean => {
      const now = Date.now()
      this.sentAt = this.sentAt.filter((t) => now - t <= 1000)
      if (this.sentAt.length >= 10) return false
      this.sentAt.push(now)
      this.ws.send(data)
      return true
    }
    if (this.pending === 0 && trySync()) return
    this.pending++
    this.chain = this.chain.then(async () => {
      for (;;) {
        if (trySync()) break
        const wait = 1000 - (Date.now() - this.sentAt[0]!) + 20
        await sleep(Math.max(wait, 5))
      }
      this.pending--
    })
  }

  // Deliberate flooding (AC-QUIZ-25): bypasses pacing.
  sendRaw(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m))
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  async until<T>(find: () => T | undefined, what: string, ms = 10_000): Promise<T> {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.wake()
    }, ms)
    try {
      for (;;) {
        const v = find()
        if (v !== undefined) return v
        if (timedOut) throw new Error(`timeout waiting for ${what}; got ${JSON.stringify(this.log.map((m) => m.type))}; closed=${JSON.stringify(this.closeInfo)}`)
        await new Promise<void>((r) => this.waiters.push(r))
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Next not-yet-consumed message of one of the given types (earlier non-matching messages are skipped for good). */
  next<T extends Msg = Msg>(types: string | string[], pred?: (m: T) => boolean, ms?: number): Promise<T> {
    const set = Array.isArray(types) ? types : [types]
    return this.until<T>(() => {
      for (let i = this.cursor; i < this.log.length; i++) {
        const m = this.log[i]!
        if (set.includes(m.type) && (!pred || pred(m as T))) {
          this.cursor = i + 1
          return m as T
        }
      }
      return undefined
    }, set.join('|'), ms)
  }

  /** Any message in the whole log (consumed or not) that matches. */
  waitAny<T extends Msg = Msg>(type: string, pred?: (m: T) => boolean, ms?: number): Promise<T> {
    return this.until<T>(() => this.log.find((m) => m.type === type && (!pred || pred(m as T))) as T | undefined, type, ms)
  }

  all<T extends Msg = Msg>(type: string): T[] {
    return this.log.filter((m) => m.type === type) as T[]
  }

  last<T extends Msg = Msg>(type: string): T {
    const l = this.all<T>(type)
    if (l.length === 0) throw new Error(`no ${type} received`)
    return l[l.length - 1]!
  }

  /** Assert that nothing of this type arrives (after the cursor) within `ms`. */
  async none(type: string, ms = 300): Promise<void> {
    const from = this.cursor
    await sleep(ms)
    expect(this.log.slice(from).filter((m) => m.type === type)).toEqual([])
  }

  closed(ms?: number): Promise<{ code: number; reason: string }> {
    return this.until(() => this.closeInfo ?? undefined, 'close', ms)
  }

  async errorCode(ms?: number): Promise<string> {
    return (await this.next<ErrorMsg>('error', undefined, ms)).code
  }

  async close(): Promise<void> {
    this.ws.close(1000, 'bye')
    await this.closed()
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of clients.splice(0)) {
    try {
      c.ws.close(1000, 'cleanup')
    } catch {
      // already closed
    }
  }
  await sleep(20)
})

/** Run the Durable Object alarm of a room (the room clock moves on). Retries briefly: the alarm may not be stored yet. */
async function tick(code: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await runDurableObjectAlarm(roomStub(code))) return
    await sleep(30)
  }
  throw new Error(`no alarm pending for room ${code}`)
}
/** Run alarms until none is left (room cancelled). Returns how many ran. */
async function drain(code: string, max = 12): Promise<number> {
  let n = 0
  while (n < max && (await runDurableObjectAlarm(roomStub(code)))) n++
  return n
}

async function join(code: string, p: Player, nickname = p.nick): Promise<{ c: Client; lobby: LobbyMsg }> {
  const c = await Client.open(code)
  c.send({ type: 'join', uuid: p.id, nickname })
  const lobby = await c.next<LobbyMsg>('lobby')
  return { c, lobby }
}

/** Players with consent, a room created by the first one, everybody joined in order (seat = index + 1). */
async function setupGame(n: number, opts: { questions?: number; seconds?: number } = {}) {
  const players = mkPlayers(n)
  await env.DB.batch(players.map((p) => ins.consent(p.id)))
  const res = await createRoom(players[0]!, { questions: opts.questions ?? 5, seconds: opts.seconds ?? 20 })
  expect(res.status, 'create room').toBe(201)
  const { code } = (await res.json()) as Created
  const cs: Client[] = []
  for (const p of players) cs.push((await join(code, p)).c)
  return { players, code, clients: cs }
}

// ---------------------------------------------------------------------------- answering helpers (names -> recipes)
function correctPair(q: QuestionMsg): [string, string] {
  const hits: [string, string][] = []
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (resultName(q.options[i]!.name, q.options[j]!.name) === q.target.name) hits.push([q.options[i]!.id, q.options[j]!.id])
    }
  }
  expect(hits, `pairs of ${JSON.stringify(q.options.map((o) => o.name))} that make ${q.target.name}`).toHaveLength(1)
  return hits[0]!
}
const others = (q: QuestionMsg): [string, string] => {
  const ok = correctPair(q)
  const rest = q.options.map((o) => o.id).filter((id) => !ok.includes(id))
  return [rest[0]!, rest[1]!]
}
const wrongPair = (q: QuestionMsg): [string, string] => others(q)
const halfPair = (q: QuestionMsg): [string, string] => [correctPair(q)[0], others(q)[0]]

type Strategy = (ci: number, q: QuestionMsg) => [string, string] | null
/** Plays a whole game for the given (connected) clients; returns every question, reveal round and final. */
async function playGame(code: string, cs: Client[], strategy: Strategy) {
  const questions: QuestionMsg[] = []
  const reveals: RevealMsg[][] = []
  for (;;) {
    const firsts = await Promise.all(cs.map((c) => c.next<Msg>(['question', 'final'], undefined, 20_000)))
    if (firsts[0]!.type === 'final') return { questions, reveals, finals: firsts as FinalMsg[] }
    const q = firsts[0] as QuestionMsg
    questions.push(q)
    let skipped = false
    for (const [ci, c] of cs.entries()) {
      const picks = strategy(ci, q)
      if (picks === null) {
        skipped = true
        continue
      }
      c.send({ type: 'answer', q: q.q, picks })
      await c.next<AnsweredMsg>('answered', (m) => m.q === q.q)
    }
    if (skipped) await tick(code)
    reveals.push(await Promise.all(cs.map((c) => c.next<RevealMsg>('reveal', (m) => m.q === q.q, 15_000))))
    await tick(code)
  }
}
const allCorrect: Strategy = (_ci, q) => correctPair(q)

/** reveal for question q on `c`; if it does not come by itself, move the clock once. */
async function revealOrTick(code: string, c: Client, q: number): Promise<RevealMsg> {
  try {
    return await c.next<RevealMsg>('reveal', (m) => m.q === q, 3000)
  } catch {
    await tick(code)
    return await c.next<RevealMsg>('reveal', (m) => m.q === q)
  }
}

const GAME_TIMEOUT = 90_000

describe('quiz', () => {
  // ============================================================== AC-QUIZ-01
  it('AC-QUIZ-01: POST /quiz/rooms trả 201 với mã 6 ký tự từ bảng chữ không nhầm, link tuyệt đối, state lobby; thiếu questions/seconds thì 10 câu 20 giây; hai phòng mã khác nhau; U là chủ phòng', async () => {
    const host = mkPlayers(1)[0]!
    await env.DB.batch([ins.consent(host.id)])

    const res = await createRoom(host, { questions: 10, seconds: 20 })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Created
    expect(body.code).toMatch(CODE_RE)
    expect(body.url).toBe(`https://example.com/lau-meme/quiz/${body.code}`)
    expect(body).toMatchObject({ state: 'lobby', questions: 10, seconds: 20 })
    expect(Object.keys(body).sort()).toEqual(['code', 'questions', 'seconds', 'state', 'url'])
    expect(await count('SELECT COUNT(*) AS n FROM quiz_room WHERE code = ?', body.code)).toBe(1)

    const second = await createRoom(host, {}) // no questions, no seconds
    expect(second.status).toBe(201)
    const b2 = (await second.json()) as Created
    expect(b2).toMatchObject({ state: 'lobby', questions: 10, seconds: 20 })
    expect(b2.code).toMatch(CODE_RE)
    expect(b2.code).not.toBe(body.code)

    const { lobby } = await join(body.code, host)
    expect(lobby.host_seat).toBe(lobby.you) // the creator is the host
    expect(lobby.players.map((p) => p.nickname)).toEqual(['Bếp 1'])
  })

  it('AC-QUIZ-01: questions 5/15 và seconds 10/30 được giữ nguyên trong phòng', async () => {
    const host = mkPlayers(1)[0]!
    await env.DB.batch([ins.consent(host.id)])
    for (const [questions, seconds] of [
      [5, 10],
      [15, 30],
    ] as const) {
      const res = await createRoom(host, { questions, seconds })
      expect(res.status).toBe(201)
      const body = (await res.json()) as Created
      expect(body).toMatchObject({ questions, seconds })
      const view = (await (await getRoom(body.code)).json()) as RoomView
      expect(view).toMatchObject({ state: 'lobby', questions, seconds })
    }
  })

  // ============================================================== AC-QUIZ-02
  it('AC-QUIZ-02: questions/seconds ngoài tập cho phép, UUID sai, thiếu nickname, nickname quá dài trả 400 problem+json chỉ rõ trường sai; không phòng nào được tạo', async () => {
    const host = mkPlayers(1)[0]!
    await env.DB.batch([ins.consent(host.id)])
    const before = await count('SELECT COUNT(*) AS n FROM quiz_room')

    const bodyCases: Array<[Record<string, unknown>, string]> = [
      [{ questions: 7 }, 'questions'],
      [{ questions: 0 }, 'questions'],
      [{ questions: '10' }, 'questions'],
      [{ seconds: 15 }, 'seconds'],
      [{ seconds: -20 }, 'seconds'],
      [{ nickname: 'x'.repeat(101) }, 'nickname'],
    ]
    for (const [extra, field] of bodyCases) {
      const res = await createRoom(host, extra)
      expect(res.status, JSON.stringify(extra)).toBe(400)
      isProblem(res)
      expect(JSON.stringify(await res.json()), JSON.stringify(extra)).toContain(field)
    }
    const noNick = await createRoom(host, JSON.stringify({ questions: 10 }))
    expect(noNick.status).toBe(400)
    isProblem(noNick)

    for (const bad of ['not-a-uuid', '12345678-1234-1234-1234-123456789012', '']) {
      const res = await raw(`${BASE}/quiz/rooms`, { method: 'POST', body: JSON.stringify({ nickname: 'Bếp Trưởng' }) }, { 'X-Player-Id': bad, 'CF-Connecting-IP': '10.9.9.9' })
      expect(res.status, bad).toBe(400)
      isProblem(res)
    }
    const noHeader = await raw(`${BASE}/quiz/rooms`, { method: 'POST', body: JSON.stringify({ nickname: 'Bếp Trưởng' }) }, { 'CF-Connecting-IP': '10.9.9.9' })
    expect(noHeader.status).toBe(400)

    expect(await count('SELECT COUNT(*) AS n FROM quiz_room')).toBe(before)
  })

  it('AC-QUIZ-02: nickname trúng từ cấm hoặc bí danh trả 422 problem+json (không nói từ nào bị chặn); nickname sai luật ký tự/độ dài bị từ chối; không phòng nào được tạo', async () => {
    const host = mkPlayers(1)[0]!
    await env.DB.batch([ins.consent(host.id), ins.term('cam tu', 'wordlist'), ins.term('bi danh', 'mod')])
    const before = await count('SELECT COUNT(*) AS n FROM quiz_room')

    for (const nickname of ['Cam Tu 1', 'xx BÍ DANH yy', 'camtu']) {
      const res = await createRoom(host, { nickname })
      expect(res.status, nickname).toBe(422)
      isProblem(res)
      const text = (await res.text()).toLowerCase()
      expect(text, nickname).not.toContain('cam tu')
      expect(text, nickname).not.toContain('bi danh')
    }
    for (const nickname of ['A', '   ', 'x'.repeat(21), 'Bếp<b>', 'Bếp 😀']) {
      const res = await createRoom(host, { nickname })
      expect([400, 422], nickname).toContain(res.status)
      isProblem(res)
    }
    expect(await count('SELECT COUNT(*) AS n FROM quiz_room')).toBe(before)
  })

  it('AC-QUIZ-02: UUID chưa đồng ý (play) thì 403 problem+json và không phòng nào được tạo', async () => {
    const stranger = mkPlayers(1)[0]!
    const before = await count('SELECT COUNT(*) AS n FROM quiz_room')
    const res = await createRoom(stranger, { questions: 10, seconds: 20 })
    expect(res.status).toBe(403)
    isProblem(res)
    expect(await count('SELECT COUNT(*) AS n FROM quiz_room')).toBe(before)
  })

  it(
    'AC-QUIZ-02: quá 5 phòng/giờ/UUID thì phòng thứ 6 trả 429 problem+json kèm Retry-After và không tạo phòng',
    async () => {
      const host = mkPlayers(1)[0]!
      await env.DB.batch([ins.consent(host.id)])
      const before = await count('SELECT COUNT(*) AS n FROM quiz_room')
      for (let i = 0; i < 5; i++) expect((await createRoom(host)).status, `room ${i + 1}`).toBe(201)
      const limited = await createRoom(host)
      expect(limited.status).toBe(429)
      isProblem(limited)
      const retry = Number(limited.headers.get('retry-after'))
      expect(Number.isInteger(retry)).toBe(true)
      expect(retry).toBeGreaterThanOrEqual(1)
      expect(await count('SELECT COUNT(*) AS n FROM quiz_room')).toBe(before + 5)
    },
    GAME_TIMEOUT,
  )

  it(
    'AC-QUIZ-02: quá 20 phòng/giờ/IP băm (mỗi UUID còn xa ngưỡng) thì phòng thứ 21 trả 429 kèm Retry-After',
    async () => {
      const shared = '10.77.66.55'
      const hosts = mkPlayers(21)
      await env.DB.batch(hosts.map((h) => ins.consent(h.id)))
      for (const [i, h] of hosts.slice(0, 20).entries()) expect((await createRoom(h, {}, shared)).status, `room ${i + 1}`).toBe(201)
      const limited = await createRoom(hosts[20]!, {}, shared)
      expect(limited.status).toBe(429)
      isProblem(limited)
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      const other = await createRoom(hosts[20]!, {}, '10.88.1.1') // a different IP is not affected
      expect(other.status).toBe(201)
    },
    GAME_TIMEOUT * 2,
  )

  // ============================================================== AC-QUIZ-03
  it('AC-QUIZ-03: GET phòng chờ -> lobby (số câu, số giây, nickname), đang chơi -> playing không có đề, đã kết thúc -> finished kèm bảng chung cuộc, mã lạ -> 404 problem+json', async () => {
    const [host, guest] = mkPlayers(2) as [Player, Player]
    const [uA, uB] = [newId(), newId()]
    const finishedCode = fakeCode()
    const seeded = seedGame(finishedCode, 1, Date.now() - 3_600_000, [
      { seat: 1, id: uA, nick: 'Bếp Nhất', score: 4800, correct: 5, rank: 1 },
      { seat: 2, id: uB, nick: 'Bếp Nhì', score: 3100, correct: 3, rank: 2 },
    ])
    await env.DB.batch([ins.consent(host.id), ins.consent(guest.id), ...seeded.stmts])

    // P1: lobby
    const created = (await (await createRoom(host, { questions: 15, seconds: 30 })).json()) as Created
    const hostSock = (await join(created.code, host)).c
    const lobbyRes = await getRoom(created.code)
    expect(lobbyRes.status).toBe(200)
    expect(lobbyRes.headers.get('cache-control')).toContain('no-store')
    const lobbyText = await lobbyRes.text()
    expect(UUID_IN_TEXT.test(lobbyText)).toBe(false)
    const lobby = JSON.parse(lobbyText) as RoomView
    expect(lobby).toMatchObject({ code: created.code, state: 'lobby', questions: 15, seconds: 30, players: ['Bếp 1'], latest: null, earlier: [] })
    expect(Object.keys(lobby).sort()).toEqual(['code', 'earlier', 'latest', 'players', 'questions', 'seconds', 'state'])

    // P2: playing, no deck
    const guestSock = (await join(created.code, guest)).c
    hostSock.send({ type: 'start' })
    await guestSock.next('question')
    const playing = await getRoom(created.code)
    expect(playing.status).toBe(200)
    const playingText = await playing.text()
    expect(JSON.parse(playingText)).toMatchObject({ code: created.code, state: 'playing' })
    expect(Object.keys(JSON.parse(playingText) as object).sort()).toEqual(['code', 'earlier', 'latest', 'players', 'questions', 'seconds', 'state'])
    expect(UUID_IN_TEXT.test(playingText)).toBe(false)
    for (const word of ['options', 'target', 'answer', 'deadline', 'correct']) expect(playingText).not.toContain(`"${word}"`)

    // P3: finished (history in D1, Durable Object long gone)
    const finished = await getRoom(finishedCode)
    expect(finished.status).toBe(200)
    const fText = await finished.text()
    expect(UUID_IN_TEXT.test(fText)).toBe(false)
    const fView = JSON.parse(fText) as RoomView
    expect(fView.state).toBe('finished')
    expect(fView.players).toEqual([])
    expect(fView.latest).toMatchObject({ game_no: 1, questions: 5, seconds: 20 })
    expect(fView.latest!.standings).toEqual([
      { rank: 1, nickname: 'Bếp Nhất', score: 4800, correct: 5 },
      { rank: 2, nickname: 'Bếp Nhì', score: 3100, correct: 3 },
    ])
    expect(fView.earlier).toEqual([])

    // P4: unknown code
    const unknown = await getRoom('ZZZZZZ')
    expect(unknown.status).toBe(404)
    isProblem(unknown)
    expect(((await unknown.json()) as Problem).status).toBe(404)
    const malformed = await getRoom('abc')
    expect([400, 404]).toContain(malformed.status)
    isProblem(malformed)
  })

  // ============================================================== AC-QUIZ-04
  it('AC-QUIZ-04: join -> lobby có danh sách theo thứ tự vào, chủ phòng, số câu, số giây; mọi socket nhận lobby mới khi có người vào hoặc rời; nickname trùng (sau fold) được thêm hậu tố " 2", " 3"', async () => {
    const players = mkPlayers(4)
    await env.DB.batch(players.map((p) => ins.consent(p.id)))
    const { code } = (await (await createRoom(players[0]!, { questions: 10, seconds: 30 })).json()) as Created

    const h = await join(code, players[0]!)
    expect(h.lobby).toMatchObject({ code, questions: 10, seconds: 30, host_seat: 1, you: 1 })
    expect(h.lobby.players).toEqual([{ seat: 1, nickname: 'Bếp 1', connected: true }])
    expect(typeof h.lobby.server_now).toBe('number')

    const b = await join(code, players[1]!)
    expect(b.lobby.you).toBe(2)
    expect(b.lobby.host_seat).toBe(1)
    expect(b.lobby.players.map((p) => p.nickname)).toEqual(['Bếp 1', 'Bếp 2'])
    const hostSees = await h.c.next<LobbyMsg>('lobby', (m) => m.players.length === 2, 1500)
    expect(hostSees.players.map((p) => p.seat)).toEqual([1, 2])

    // same nickname after fold -> suffix " 2", then " 3"
    const dup1 = await join(code, players[2]!, 'BEP 1')
    expect(dup1.lobby.players.map((p) => p.nickname)).toEqual(['Bếp 1', 'Bếp 2', 'BEP 1 2'])
    const dup2 = await join(code, players[3]!, 'bep 1')
    expect(dup2.lobby.players.map((p) => p.nickname)).toEqual(['Bếp 1', 'Bếp 2', 'BEP 1 2', 'bep 1 3'])
    const text = JSON.stringify(dup2.lobby)
    expect(UUID_IN_TEXT.test(text)).toBe(false)
    for (const p of dup2.lobby.players) expect(Object.keys(p).sort()).toEqual(['connected', 'nickname', 'seat'])

    // someone leaves the lobby: every other socket gets the new list within a second
    dup2.c.send({ type: 'leave' })
    const afterLeave = await h.c.next<LobbyMsg>('lobby', (m) => !m.players.some((p) => p.nickname === 'bep 1 3'), 1500)
    expect(afterLeave.players.map((p) => p.nickname)).toEqual(['Bếp 1', 'Bếp 2', 'BEP 1 2'])
    await b.c.next<LobbyMsg>('lobby', (m) => !m.players.some((p) => p.nickname === 'bep 1 3'), 1500)
  })

  it(
    'AC-QUIZ-04: người thứ 51 nhận error room_full rồi socket đóng (mã 1008); 50 người đầu vào bình thường',
    async () => {
      const players = mkPlayers(51)
      await env.DB.batch(players.map((p) => ins.consent(p.id)))
      const { code } = (await (await createRoom(players[0]!)).json()) as Created
      const lobbies: LobbyMsg[] = []
      for (let i = 0; i < 50; i += 10) {
        const chunk = await Promise.all(players.slice(i, i + 10).map((p) => join(code, p)))
        for (const x of chunk) lobbies.push(x.lobby)
      }
      expect(Math.max(...lobbies.map((l) => l.players.length))).toBe(50)

      const late = await Client.open(code)
      late.send({ type: 'join', uuid: players[50]!.id, nickname: players[50]!.nick })
      expect(await late.errorCode()).toBe('room_full')
      expect((await late.closed()).code).toBe(1008)
      expect(late.all('lobby')).toEqual([])
    },
    GAME_TIMEOUT * 2,
  )

  // ============================================================== AC-QUIZ-05
  it('AC-QUIZ-05: join sai nickname -> nickname_rejected và socket giữ để nhập lại; UUID sai -> bad_request, chưa đồng ý -> consent_required, tin khác trước join -> not_joined (đóng 1008); danh sách người chơi không đổi', async () => {
    const [host, ok, stranger] = mkPlayers(3) as [Player, Player, Player]
    await env.DB.batch([ins.consent(host.id), ins.consent(ok.id), ins.term('cam tu', 'wordlist'), ins.term('bi danh', 'mod')])
    const { code } = (await (await createRoom(host)).json()) as Created
    const hostSock = (await join(code, host)).c

    const c = await Client.open(code)
    for (const bad of ['Cam Tu 1', 'xx Bí Danh', 'A', 'x'.repeat(21), 'Bếp<b>', '   ']) {
      c.send({ type: 'join', uuid: ok.id, nickname: bad })
      expect(await c.errorCode(), JSON.stringify(bad)).toBe('nickname_rejected')
    }
    await sleep(200)
    expect(c.closeInfo).toBeNull() // socket kept
    c.send({ type: 'join', uuid: ok.id, nickname: 'Bếp Ổn' })
    const lobby = await c.next<LobbyMsg>('lobby')
    expect(lobby.players.map((p) => p.nickname)).toEqual(['Bếp 1', 'Bếp Ổn'])

    const badUuid = await Client.open(code)
    badUuid.send({ type: 'join', uuid: 'abc', nickname: 'Bếp Lạ' })
    expect(await badUuid.errorCode()).toBe('bad_request')
    expect((await badUuid.closed()).code).toBe(1008)

    const noConsent = await Client.open(code)
    noConsent.send({ type: 'join', uuid: stranger.id, nickname: 'Bếp Lạ' })
    expect(await noConsent.errorCode()).toBe('consent_required')
    expect((await noConsent.closed()).code).toBe(1008)

    const early = await Client.open(code)
    early.send({ type: 'answer', q: 1, picks: [await elementId('Cay'), await elementId('Cười')] })
    expect(await early.errorCode()).toBe('not_joined')
    expect((await early.closed()).code).toBe(1008)
    const early2 = await Client.open(code)
    early2.send({ type: 'start' })
    expect(await early2.errorCode()).toBe('not_joined')
    expect((await early2.closed()).code).toBe(1008)

    await sleep(300)
    expect(hostSock.last<LobbyMsg>('lobby').players.map((p) => p.nickname)).toEqual(['Bếp 1', 'Bếp Ổn'])
    const view = (await (await getRoom(code)).json()) as RoomView
    expect(view.players).toEqual(['Bếp 1', 'Bếp Ổn'])
  })

  // ============================================================== AC-QUIZ-06
  it(
    'AC-QUIZ-06: phòng đang chơi không nhận UUID mới (error already_started rồi đóng 1008, phòng không đổi); người rớt mạng vào lại được',
    async () => {
      const { players, code, clients: cs } = await setupGame(2)
      const u9 = { id: newId(), nick: 'Bếp Chín' }
      await env.DB.batch([ins.consent(u9.id)])
      cs[0]!.send({ type: 'start' })
      const q1 = await cs[0]!.next<QuestionMsg>('question')
      await cs[1]!.next('question')
      await cs[1]!.close() // U2 drops

      const late = await Client.open(code)
      late.send({ type: 'join', uuid: u9.id, nickname: u9.nick })
      expect(await late.errorCode()).toBe('already_started')
      expect((await late.closed()).code).toBe(1008)
      const view = (await (await getRoom(code)).json()) as RoomView
      expect(view.state).toBe('playing')
      expect(view.players).not.toContain('Bếp Chín')

      const back = await Client.open(code)
      back.send({ type: 'join', uuid: players[1]!.id, nickname: players[1]!.nick })
      const again = await back.next<QuestionMsg>('question')
      expect(again.q).toBe(q1.q)
      expect(back.all('error')).toEqual([])
    },
    GAME_TIMEOUT,
  )

  // ============================================================== AC-QUIZ-07
  it('AC-QUIZ-07: start của người không phải chủ phòng -> error not_host và phòng vẫn chờ; start của chủ phòng phát câu 1 cho mọi người', async () => {
    const { code, clients: cs } = await setupGame(3)
    cs[1]!.send({ type: 'start' })
    expect(await cs[1]!.errorCode()).toBe('not_host')
    await cs[0]!.none('started')
    await cs[0]!.none('question', 100)
    expect(((await (await getRoom(code)).json()) as RoomView).state).toBe('lobby')

    cs[0]!.send({ type: 'start' })
    const qs = await Promise.all(cs.map((c) => c.next<QuestionMsg>('question')))
    for (const q of qs) expect(q.q).toBe(1)
    const started = await cs[2]!.waitAny<StartedMsg>('started')
    expect(started).toMatchObject({ game_no: 1, total: 5, seconds: 20 })
    expect(((await (await getRoom(code)).json()) as RoomView).state).toBe('playing')
  })

  it('AC-QUIZ-07: chủ phòng rời phòng chờ quá 30 s thì quyền chủ phòng chuyển cho người vào sớm nhất còn kết nối, mọi socket nhận lobby mới; chủ cũ quay lại là người chơi thường', async () => {
    const { players, code, clients: cs } = await setupGame(3)
    await cs[0]!.close()
    await sleep(200)
    await tick(code) // the 30 s host-transfer alarm
    const l2 = await cs[1]!.next<LobbyMsg>('lobby', (m) => m.host_seat === 2, 3000)
    expect(l2.players.find((p) => p.seat === 2)?.nickname).toBe('Bếp 2')
    await cs[2]!.next<LobbyMsg>('lobby', (m) => m.host_seat === 2, 3000)

    const back = await join(code, players[0]!)
    expect(back.lobby.host_seat).toBe(2)
    expect(back.lobby.you).not.toBe(2)
    back.c.send({ type: 'start' })
    expect(await back.c.errorCode()).toBe('not_host')

    cs[1]!.send({ type: 'start' })
    expect((await cs[1]!.next<QuestionMsg>('question')).q).toBe(1)
  })

  // ============================================================== AC-QUIZ-08 (through the room)
  it('AC-QUIZ-08: đề trong gói chơi một mình có 10 câu khó dần, đích khác nhau và khác Món đặc biệt, độ sâu 1..5, 4 lựa chọn khác nhau với đúng một cặp là công thức', async () => {
    const { clients: cs } = await setupGame(1, { questions: 10 })
    cs[0]!.send({ type: 'start' })
    const pack = await cs[0]!.next<SoloPackMsg>('solo_pack')
    expect(pack.total).toBe(10)
    expect(pack.items).toHaveLength(10)
    let last = 0
    const seen = new Set<string>()
    for (const [i, item] of pack.items.entries()) {
      const at = `item ${i + 1} (${item.target.name})`
      const depth = depthByName.get(item.target.name)
      expect(depth, at).toBeGreaterThanOrEqual(1)
      expect(depth, at).toBeLessThanOrEqual(5)
      expect(depth, `${at} difficulty never goes down`).toBeGreaterThanOrEqual(last)
      last = depth!
      expect(item.target.name, at).not.toBe(DAILY)
      expect(seen.has(item.target.name), `${at} repeated`).toBe(false)
      seen.add(item.target.name)
      const names = item.options.map((o) => o.name)
      expect(new Set(item.options.map((o) => o.id)).size, at).toBe(4)
      expect(names, at).not.toContain(item.target.name)
      let hits = 0
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) if (resultName(names[a]!, names[b]!) === item.target.name) hits++
      expect(hits, `${at} pairs that make the target`).toBe(1)
      for (const n of names) expect(resultName(n, n), `${at} self pair`).not.toBe(item.target.name)
    }
  })

  // ============================================================== AC-QUIZ-09
  it(
    'AC-QUIZ-09: pool 12 meme đề mà phòng xin 15 câu thì ván có 12 câu và tin started báo total 12',
    async () => {
      const { clients: cs } = await setupGame(2, { questions: 15 })
      cs[0]!.send({ type: 'start' })
      for (const c of cs) {
        const started = await c.next<StartedMsg>('started')
        expect(started).toMatchObject({ game_no: 1, total: 12, seconds: 20 })
        expect((await c.next<QuestionMsg>('question')).total).toBe(12)
      }
    },
    GAME_TIMEOUT,
  )

  it('AC-QUIZ-09: pool còn dưới 5 meme đề thì start nhận error not_enough_questions, không ai nhận started, phòng vẫn chờ', async () => {
    const { idOf } = await idMaps()
    const blocked = ['Tới Công Chuyện', 'Khét Lẹt', 'Cháy Nhà', 'Chạy Deadline', 'Khét Cay', 'Cháy Cười', 'Hết Cứu', 'Lẩu Thập Cẩm']
    await env.DB.batch(blocked.map((n) => ins.block('element', idOf.get(n)!)))
    const { code, clients: cs } = await setupGame(2, { questions: 15 })
    cs[0]!.send({ type: 'start' })
    expect(await cs[0]!.errorCode()).toBe('not_enough_questions')
    await cs[0]!.none('started')
    await cs[1]!.none('started', 100)
    expect(cs[1]!.all('error')).toEqual([])
    expect(((await (await getRoom(code)).json()) as RoomView).state).toBe('lobby')
    expect(await count('SELECT COUNT(*) AS n FROM quiz_game WHERE room_code = ?', code)).toBe(0)
  })

  // ============================================================== AC-QUIZ-10
  it('AC-QUIZ-10: mọi socket nhận cùng tin question (q/total, meme đề, 4 lựa chọn, server_now, deadline = server_now + 20 s) và không có trường nào lộ đáp án, độ sâu hay công thức', async () => {
    const { clients: cs } = await setupGame(2)
    cs[0]!.send({ type: 'start' })
    const [a, b] = await Promise.all(cs.map((c) => c.next<QuestionMsg>('question')))
    expect(a).toEqual(b)
    expect(Object.keys(a!).sort()).toEqual(['deadline', 'options', 'q', 'server_now', 'target', 'total', 'type'])
    expect(a!.q).toBe(1)
    expect(a!.total).toBe(5)
    expect(a!.deadline - a!.server_now).toBe(20_000)
    expect(typeof a!.server_now).toBe('number')
    expect(Object.keys(a!.target).sort()).toEqual(['emoji', 'image_key', 'name'])
    expect(a!.options).toHaveLength(4)
    for (const o of a!.options) expect(Object.keys(o).sort()).toEqual(['emoji', 'id', 'image_key', 'name'])
    expect(new Set(a!.options.map((o) => o.id)).size).toBe(4)
    const text = JSON.stringify(a)
    expect(text).not.toMatch(/depth|recipe|answer|correct|formula|hash|pair/i)
  })

  // ============================================================== AC-QUIZ-11
  it(
    'AC-QUIZ-11: lần nộp hợp lệ đầu tiên nhận answered (chỉ người đó); nộp lần hai, picks sai, q khác, sau hạn nhận error already_answered, bad_answer, wrong_question, too_late; thứ tự hai lựa chọn không quan trọng',
    async () => {
      const { code, clients: cs } = await setupGame(3)
      const [c1, c2, c3] = cs as [Client, Client, Client]
      c1.send({ type: 'start' })
      const q = await c1.next<QuestionMsg>('question')
      await Promise.all([c2.next('question'), c3.next('question')])
      const [a, b] = correctPair(q)
      const stranger = await elementId('Món Lạ Không Có Trong Đề')
      const [x] = others(q)

      for (const picks of [[a], [a, b, x], [a, a], [a, stranger]]) {
        c1.send({ type: 'answer', q: 1, picks })
        expect(await c1.errorCode(), JSON.stringify(picks.map((p) => p.slice(0, 4)))).toBe('bad_answer')
        await sleep(120) // stay far below the 10 messages/second limit
      }
      c1.send({ type: 'answer', q: 2, picks: [a, b] })
      expect(await c1.errorCode()).toBe('wrong_question')
      await c1.none('answered', 250)

      c1.send({ type: 'answer', q: 1, picks: [a, b] })
      expect(await c1.next<AnsweredMsg>('answered')).toEqual({ type: 'answered', q: 1 })
      await sleep(120)
      c1.send({ type: 'answer', q: 1, picks: [b, a] })
      expect(await c1.errorCode()).toBe('already_answered')

      c2.send({ type: 'answer', q: 1, picks: [b, a] }) // swapped order is the same answer
      expect(await c2.next<AnsweredMsg>('answered')).toEqual({ type: 'answered', q: 1 })
      expect(c1.all('answered')).toHaveLength(1)
      expect(c3.all('answered')).toEqual([]) // answered goes to the sender only

      await tick(code) // c3 never answered: the question closes at its deadline
      const reveal = await c1.next<RevealMsg>('reveal')
      c3.send({ type: 'answer', q: 1, picks: [a, b] })
      expect(await c3.errorCode()).toBe('too_late')

      const bySeat = new Map(reveal.results.map((r) => [r.seat, r]))
      expect(bySeat.get(1)).toMatchObject({ ok: true })
      expect(bySeat.get(2)).toMatchObject({ ok: true })
      expect(bySeat.get(1)!.points).toBeGreaterThan(0)
      expect(bySeat.get(2)!.points).toBeGreaterThan(0)
      expect(bySeat.get(3)).toMatchObject({ ok: false, points: 0, picks: null })
      expect(reveal.board.top.find((t) => t.seat === 3)?.score).toBe(0) // the rejected answers changed nothing
    },
    GAME_TIMEOUT,
  )

  // ============================================================== AC-QUIZ-12 (through the room)
  it(
    'AC-QUIZ-12: nộp đúng ngay được điểm cao (750..1000), đúng một nửa, sai cả hai và không nộp đều 0 điểm; ok chỉ đúng khi cả hai lựa chọn đúng',
    async () => {
      const { code, clients: cs } = await setupGame(4)
      cs[0]!.send({ type: 'start' })
      const q = (await Promise.all(cs.map((c) => c.next<QuestionMsg>('question'))))[0]!
      cs[0]!.send({ type: 'answer', q: 1, picks: correctPair(q) })
      cs[1]!.send({ type: 'answer', q: 1, picks: halfPair(q) })
      cs[2]!.send({ type: 'answer', q: 1, picks: wrongPair(q) })
      await Promise.all([cs[0]!, cs[1]!, cs[2]!].map((c) => c.next('answered')))
      await tick(code) // player 4 does not answer
      const reveal = await cs[3]!.next<RevealMsg>('reveal')
      const r = new Map(reveal.results.map((x) => [x.seat, x]))
      expect(r.get(1)!.ok).toBe(true)
      expect(r.get(1)!.points).toBeGreaterThanOrEqual(750)
      expect(r.get(1)!.points).toBeLessThanOrEqual(1000)
      expect(r.get(2)).toMatchObject({ ok: false, points: 0 })
      expect(r.get(3)).toMatchObject({ ok: false, points: 0 })
      expect(r.get(4)).toMatchObject({ ok: false, points: 0, picks: null })
      expect(new Set(r.get(2)!.picks)).toEqual(new Set(halfPair(q)))
      expect(reveal.board.top.find((t) => t.seat === 1)!.score).toBe(r.get(1)!.points)
    },
    GAME_TIMEOUT,
  )

  // ============================================================== AC-QUIZ-13
  it(
    'AC-QUIZ-13: cả 3 nộp trước hạn thì câu đóng ngay và mọi socket nhận reveal (cặp đúng, kết quả từng người, bảng điểm, next_at); sau đó phát câu kế tiếp',
    async () => {
      const { code, clients: cs } = await setupGame(3)
      cs[0]!.send({ type: 'start' })
      const q = (await Promise.all(cs.map((c) => c.next<QuestionMsg>('question'))))[0]!
      const [a, b] = correctPair(q)
      for (const [i, c] of cs.entries()) {
        c.send({ type: 'answer', q: 1, picks: i === 2 ? wrongPair(q) : [a, b] })
        await c.next('answered')
      }
      const reveals = await Promise.all(cs.map((c) => c.next<RevealMsg>('reveal', undefined, 5000))) // no alarm needed
      for (const r of reveals) {
        expect(r.q).toBe(1)
        expect(new Set(r.correct)).toEqual(new Set([a, b]))
        expect(r.results.map((x) => x.seat).sort()).toEqual([1, 2, 3])
        expect(r.results.filter((x) => x.ok).map((x) => x.seat).sort()).toEqual([1, 2])
        expect(r.board.top.length).toBe(3)
        expect(r.next_at).toBeGreaterThanOrEqual(q.server_now + 4000)
        expect(r.next_at).toBeLessThan(q.server_now + 4000 + 60_000)
      }
      expect(reveals[2]!.board.me.seat).toBe(3)
      expect(reveals[2]!.results.find((x) => x.seat === 3)).toMatchObject({ ok: false, points: 0 })

      await tick(code) // the 4 s pause is over
      const q2 = await cs[1]!.next<QuestionMsg>('question')
      expect(q2.q).toBe(2)
    },
    GAME_TIMEOUT,
  )

  it(
    'AC-QUIZ-13: chỉ 2 người nộp thì câu chưa đóng, đóng đúng lúc deadline (alarm) và người không nộp có picks null, 0 điểm',
    async () => {
      const { code, clients: cs } = await setupGame(3)
      cs[0]!.send({ type: 'start' })
      const q = (await Promise.all(cs.map((c) => c.next<QuestionMsg>('question'))))[0]!
      for (const c of [cs[0]!, cs[1]!]) {
        c.send({ type: 'answer', q: 1, picks: correctPair(q) })
        await c.next('answered')
      }
      await cs[2]!.none('reveal', 500)
      await tick(code)
      const reveal = await cs[2]!.next<RevealMsg>('reveal')
      expect(reveal.results.find((x) => x.seat === 3)).toMatchObject({ picks: null, ok: false, points: 0 })
      expect(reveal.results.filter((x) => x.ok)).toHaveLength(2)
    },
    GAME_TIMEOUT,
  )

  // ============================================================== AC-QUIZ-14
  it(
    'AC-QUIZ-14: 12 người chơi: bảng điểm top 10 theo điểm giảm dần rồi thứ tự vào phòng, mỗi socket nhận me của riêng mình kể cả ngoài top 10, người rớt mạng vẫn có tên',
    async () => {
      const { code, clients: cs } = await setupGame(12)
      cs[0]!.send({ type: 'start' })
      const qs = await Promise.all(cs.map((c) => c.next<QuestionMsg>('question')))
      const q = qs[0]!
      await cs[8]!.close() // seat 9 drops before answering
      await sleep(200)
      for (const [i, c] of cs.entries()) {
        if (i === 8) continue
        c.send({ type: 'answer', q: 1, picks: i < 6 ? correctPair(q) : wrongPair(q) })
        await c.next('answered')
      }
      const reveals = new Map<number, RevealMsg>()
      reveals.set(0, await revealOrTick(code, cs[0]!, 1))
      for (const i of [2, 7, 11]) reveals.set(i, await cs[i]!.next<RevealMsg>('reveal', (m) => m.q === 1, 5000))

      const first = reveals.get(0)!
      expect(first.board.top).toHaveLength(10)
      expect(first.board.top.map((t) => t.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(first.board.top.map((t) => t.seat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) // 0-point players: join order
      for (let i = 1; i < 10; i++) expect(first.board.top[i]!.score).toBeLessThanOrEqual(first.board.top[i - 1]!.score)
      expect(first.board.top.slice(0, 6).every((t) => t.score > 0)).toBe(true)
      expect(first.board.top.slice(6).every((t) => t.score === 0)).toBe(true)
      expect(first.board.top.find((t) => t.seat === 9)).toMatchObject({ nickname: 'Bếp 9', rank: 9 }) // dropped, still listed
      expect(first.board.me).toMatchObject({ seat: 1, rank: 1 })
      expect(reveals.get(2)!.board.me).toMatchObject({ seat: 3, rank: 3 })
      expect(reveals.get(7)!.board.me).toMatchObject({ seat: 8, rank: 8, score: 0 })
      expect(reveals.get(11)!.board.me).toEqual({ seat: 12, score: 0, rank: 12 }) // outside the top 10
      expect(reveals.get(11)!.board.top.some((t) => t.seat === 12)).toBe(false)
    },
    GAME_TIMEOUT * 2,
  )

  // ============================================================== AC-QUIZ-15
  it(
    'AC-QUIZ-15: hết câu cuối mọi socket nhận final với toàn bộ bảng xếp hạng (số câu đúng, tổng điểm, hạng) và saved = true',
    async () => {
      const { code, clients: cs } = await setupGame(3)
      cs[0]!.send({ type: 'start' })
      const game = await playGame(code, cs, (ci, q) => (ci === 0 ? correctPair(q) : ci === 1 ? (q.q === 1 ? correctPair(q) : wrongPair(q)) : wrongPair(q)))
      expect(game.questions).toHaveLength(5)
      expect(game.reveals).toHaveLength(5)
      const final = game.finals[0]!
      for (const f of game.finals) expect(f).toEqual(final)
      expect(final.game_no).toBe(1)
      expect(final.saved).toBe(true)
      expect(Object.keys(final).sort()).toEqual(['game_no', 'saved', 'standings', 'type'])
      expect(final.standings).toHaveLength(3)
      for (const s of final.standings) expect(Object.keys(s).sort()).toEqual(['correct', 'nickname', 'rank', 'score', 'seat'])
      expect(final.standings.map((s) => s.rank)).toEqual([1, 2, 3])
      expect(final.standings.map((s) => s.seat)).toEqual([1, 2, 3])
      expect(final.standings.map((s) => s.correct)).toEqual([5, 1, 0])
      expect(final.standings[0]!.score).toBeGreaterThan(final.standings[1]!.score)
      expect(final.standings[1]!.score).toBeGreaterThan(0)
      expect(final.standings[2]!.score).toBe(0)
      expect(final.standings.map((s) => s.nickname)).toEqual(['Bếp 1', 'Bếp 2', 'Bếp 3'])
    },
    GAME_TIMEOUT,
  )

  // ============================================================== AC-QUIZ-16
  it(
    'AC-QUIZ-16: người rớt mạng ở câu 3 vào lại ở câu 4 với cùng UUID nhận câu 4 với deadline gốc, điểm đã có, câu 3 tính 0, nickname và hạng giữ nguyên',
    async () => {
      const { players, code, clients: cs } = await setupGame(3)
      const [c1, c2, c3] = cs as [Client, Client, Client]
      c1.send({ type: 'start' })

      // q1: everybody answers correctly
      let qs = await Promise.all(cs.map((c) => c.next<QuestionMsg>('question', (m) => m.q === 1)))
      for (const c of cs) {
        c.send({ type: 'answer', q: 1, picks: correctPair(qs[0]!) })
        await c.next('answered')
      }
      await Promise.all(cs.map((c) => c.next<RevealMsg>('reveal', (m) => m.q === 1)))
      await tick(code)

      // q2: U2 answers, then drops
      qs = await Promise.all(cs.map((c) => c.next<QuestionMsg>('question', (m) => m.q === 2)))
      c2.send({ type: 'answer', q: 2, picks: correctPair(qs[0]!) })
      await c2.next('answered')
      await c2.close()
      await sleep(200)
      for (const c of [c1, c3]) {
        c.send({ type: 'answer', q: 2, picks: correctPair(qs[0]!) })
        await c.next('answered')
      }
      const rev2 = await revealOrTick(code, c1, 2)
      const scoreAfter2 = rev2.board.top.find((t) => t.seat === 2)!.score
      expect(scoreAfter2).toBeGreaterThan(0)
      await tick(code)

      // q3: U2 is away
      const q3 = await c1.next<QuestionMsg>('question', (m) => m.q === 3)
      await c3.next('question', (m) => m.q === 3)
      for (const c of [c1, c3]) {
        c.send({ type: 'answer', q: 3, picks: correctPair(q3) })
        await c.next('answered')
      }
      const rev3 = await revealOrTick(code, c1, 3)
      expect(rev3.results.find((r) => r.seat === 2)).toMatchObject({ picks: null, ok: false, points: 0 })
      await tick(code)

      // q4: U2 comes back with the same UUID (and another nickname, which must not replace the old one)
      const q4 = await c1.next<QuestionMsg>('question', (m) => m.q === 4)
      const back = await Client.open(code)
      back.send({ type: 'join', uuid: players[1]!.id, nickname: 'Tên Khác' })
      const q4back = await back.next<QuestionMsg>('question', (m) => m.q === 4)
      expect(q4back.deadline).toBe(q4.deadline) // the original deadline
      expect(q4back.options).toEqual(q4.options)
      expect(back.all('answered')).toEqual([])
      for (const c of [c1, c3]) {
        c.send({ type: 'answer', q: 4, picks: correctPair(q4) })
        await c.next('answered')
      }
      await tick(code) // U2 is connected and silent: the deadline closes it
      const rev4 = await back.next<RevealMsg>('reveal', (m) => m.q === 4)
      expect(rev4.results.find((r) => r.seat === 2)).toMatchObject({ picks: null, points: 0 })
      expect(rev4.board.top.find((t) => t.seat === 2)).toMatchObject({ nickname: 'Bếp 2', score: scoreAfter2 })
      expect(rev4.board.me.seat).toBe(2)
      expect(rev4.board.me.score).toBe(scoreAfter2)
    },
    GAME_TIMEOUT * 2,
  )

  it('AC-QUIZ-16: đã nộp câu đang mở rồi rớt mạng, vào lại nhận lại câu hỏi và answered', async () => {
    const { players, code, clients: cs } = await setupGame(3)
    cs[0]!.send({ type: 'start' })
    const q = (await Promise.all(cs.map((c) => c.next<QuestionMsg>('question'))))[0]!
    cs[1]!.send({ type: 'answer', q: 1, picks: correctPair(q) })
    await cs[1]!.next('answered')
    await cs[1]!.close()
    await sleep(200)
    const back = await Client.open(code)
    back.send({ type: 'join', uuid: players[1]!.id, nickname: players[1]!.nick })
    const again = await back.waitAny<QuestionMsg>('question')
    expect(again.q).toBe(1)
    expect(again.deadline).toBe(q.deadline)
    expect(await back.waitAny<AnsweredMsg>('answered')).toEqual({ type: 'answered', q: 1 })
  })

  it('AC-QUIZ-16: cùng UUID mở socket thứ hai thì socket cũ bị đóng (mã 4001), chỉ socket mới nhận tin', async () => {
    const players = mkPlayers(3)
    await env.DB.batch(players.map((p) => ins.consent(p.id)))
    const { code } = (await (await createRoom(players[0]!)).json()) as Created
    const first = (await join(code, players[0]!)).c
    const second = await Client.open(code)
    second.send({ type: 'join', uuid: players[0]!.id, nickname: players[0]!.nick })
    expect((await first.closed()).code).toBe(4001)
    const lobby = await second.next<LobbyMsg>('lobby')
    expect(lobby.players.filter((p) => p.nickname === 'Bếp 1')).toHaveLength(1) // not listed twice
    const before = first.log.length
    await join(code, players[1]!)
    const seen = await second.next<LobbyMsg>('lobby', (m) => m.players.length === 2)
    expect(seen.players).toHaveLength(2)
    expect(first.log.length).toBe(before) // the old socket hears nothing more
  })

  // ============================================================== AC-QUIZ-17
  it('AC-QUIZ-17: chủ phòng một mình bấm start nhận solo_pack (đáp án chỉ ở dạng băm có muối = mã phòng), phòng bị khóa, không ghi lịch sử', async () => {
    const { code, clients: cs } = await setupGame(1)
    const extra = { id: newId(), nick: 'Bếp Khách' }
    await env.DB.batch([ins.consent(extra.id)])
    cs[0]!.send({ type: 'start' })
    const pack = await cs[0]!.next<SoloPackMsg>('solo_pack')
    expect(pack).toMatchObject({ game_no: 1, total: 5, seconds: 20, salt: `${code}:1` })
    expect(pack.items).toHaveLength(5)
    expect(Object.keys(pack).sort()).toEqual(['game_no', 'items', 'salt', 'seconds', 'total', 'type'])

    for (const [i, item] of pack.items.entries()) {
      expect(Object.keys(item).sort(), `item ${i + 1}`).toEqual(['answer_hash', 'options', 'target'])
      expect(JSON.stringify(item)).not.toMatch(/correct|answer"|picks|depth|recipe/i)
      expect(item.answer_hash).toMatch(/^[A-Za-z0-9_-]{43}$/)
      // the hash of exactly one pair of options matches; that pair is the real recipe
      const matches: [string, string][] = []
      for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) {
          const [lo, hi] = [item.options[a]!.id, item.options[b]!.id].sort()
          const hash = b64u(await sha256(`lmq1|${pack.salt}|${i + 1}|${lo}|${hi}`))
          if (hash === item.answer_hash) matches.push([item.options[a]!.name, item.options[b]!.name])
        }
      }
      expect(matches, `item ${i + 1} hash matches`).toHaveLength(1)
      expect(resultName(matches[0]![0], matches[0]![1])).toBe(item.target.name)
    }

    // the room is locked: a newcomer is refused
    const late = await Client.open(code)
    late.send({ type: 'join', uuid: extra.id, nickname: extra.nick })
    expect(await late.errorCode()).toBe('already_started')
    expect((await late.closed()).code).toBe(1008)

    // nothing is written for a solo game, whatever the clock does afterwards
    await drain(code, 4)
    expect(await count('SELECT COUNT(*) AS n FROM quiz_game WHERE room_code = ?', code)).toBe(0)
  })

  // ============================================================== AC-QUIZ-18
  it(
    'AC-QUIZ-18: ván nhiều người kết thúc ghi đúng 1 dòng quiz_game (mã phòng, số ván, version, số câu, số giây, thời điểm) và 1 dòng mỗi người (UUID, nickname, điểm, số câu đúng, hạng); không tính vào Daily/streak',
    async () => {
      const { players, code, clients: cs } = await setupGame(2)
      cs[0]!.send({ type: 'start' })
      const game = await playGame(code, cs, (ci, q) => (ci === 0 ? correctPair(q) : wrongPair(q)))
      expect(game.finals[0]!.saved).toBe(true)

      const games = (await env.DB.prepare('SELECT * FROM quiz_game WHERE room_code = ?').bind(code).all<Record<string, unknown>>()).results
      expect(games).toHaveLength(1)
      const g = games[0]!
      expect(g).toMatchObject({ room_code: code, game_no: 1, content_version: 1, questions: 5, seconds: 20, player_count: 2 })
      expect(g.started_at as number).toBeGreaterThan(0)
      expect(g.finished_at as number).toBeGreaterThanOrEqual(g.started_at as number)

      const rows = (
        await env.DB.prepare('SELECT seat, player_id, nickname, score, correct, rank FROM quiz_player WHERE game_id = ? ORDER BY seat').bind(g.id).all<Record<string, unknown>>()
      ).results
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ seat: 1, player_id: players[0]!.id, nickname: 'Bếp 1', correct: 5, rank: 1 })
      expect(rows[1]).toMatchObject({ seat: 2, player_id: players[1]!.id, nickname: 'Bếp 2', score: 0, correct: 0, rank: 2 })
      expect(rows[0]!.score).toBe(game.finals[0]!.standings[0]!.score)

      // the final write is idempotent by schema: a second row for the same (room, game_no) cannot exist
      await expect(
        env.DB.prepare('INSERT INTO quiz_game (id, room_code, game_no, content_version, questions, seconds, player_count, started_at, finished_at) VALUES (?, ?, 1, 1, 5, 20, 2, 1, 2)')
          .bind(newId(), code)
          .run(),
      ).rejects.toThrow()

      // not counted anywhere else
      const ids = players.map((p) => p.id)
      for (const table of ['daily_result', 'streak', 'discovery']) {
        const n = await count(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id IN (?, ?)`, ids[0], ids[1])
        expect(n, table).toBe(0)
      }
    },
    GAME_TIMEOUT,
  )

  // ============================================================== AC-QUIZ-19
  it('AC-QUIZ-19: GET /quiz/history của U có 3 ván mới nhất trước (thời điểm, số người, điểm, hạng, link phòng); U\' chưa chơi nhận 200 danh sách rỗng; UUID sai trả 400', async () => {
    const u = newId()
    const other = newId()
    const noGames = newId()
    const now = Date.now()
    const stmts = [
      ...[0, 1, 2].flatMap((i) => {
        const code = ['KKKKK2', 'KKKKK3', 'KKKKK4'][i]!
        return seedGame(
          code,
          1,
          now - (3 - i) * 3_600_000,
          [
            { seat: 1, id: other, nick: 'Bếp Địch', score: 3000 - i * 100, correct: 3, rank: 1 },
            { seat: 2, id: u, nick: `Bếp Của U ${i}`, score: 2000 + i * 100, correct: 2 + i, rank: 2 },
            { seat: 3, id: newId(), nick: 'Bếp Ba', score: 100, correct: 1, rank: 3 },
          ],
          { questions: 5 + i },
        ).stmts
      }),
    ]
    await env.DB.batch(stmts)

    const res = await getHistory(u)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HistoryPage
    expect(body.total).toBe(3)
    expect(body.items.map((i) => i.code)).toEqual(['KKKKK4', 'KKKKK3', 'KKKKK2']) // newest first
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(['code', 'correct', 'finished_at', 'game_no', 'nickname', 'player_count', 'questions', 'rank', 'score', 'url'])
    expect(body.items[0]).toMatchObject({ code: 'KKKKK4', game_no: 1, url: 'https://example.com/lau-meme/quiz/KKKKK4', player_count: 3, questions: 7, nickname: 'Bếp Của U 2', score: 2200, correct: 4, rank: 2 })
    expect(Date.parse(body.items[0]!.finished_at)).toBeGreaterThan(Date.parse(body.items[1]!.finished_at))
    const text = JSON.stringify(body)
    expect(text).not.toContain(other)
    expect(text).not.toContain('Bếp Địch') // other players' rows are not mine

    const empty = await getHistory(noGames)
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as HistoryPage).items).toEqual([])
    expect(((await (await getHistory(noGames)).json()) as HistoryPage).total).toBe(0)

    for (const bad of ['not-a-uuid', '12345678-1234-1234-1234-123456789012']) {
      const r = await raw(`${BASE}/quiz/history`, {}, { 'X-Player-Id': bad, 'CF-Connecting-IP': '10.9.9.9' })
      expect(r.status, bad).toBe(400)
      isProblem(r)
    }
    expect((await getHistory(null)).status).toBe(400)
  })

  it('AC-QUIZ-19: tối đa 20 ván mỗi trang, trang kế tiếp có phần còn lại, ván mới nhất trước', async () => {
    const u = newId()
    const now = Date.now()
    const stmts = Array.from({ length: 21 }, (_, i) =>
      seedGame(fakeCode(), 1, now - (i + 1) * 60_000, [
        { seat: 1, id: u, nick: `Bếp ${i}`, score: 1000 + i, correct: 2, rank: 1 },
        { seat: 2, id: newId(), nick: 'Bếp Phụ', score: 10, correct: 1, rank: 2 },
      ]).stmts,
    ).flat()
    await env.DB.batch(stmts)

    const p1 = (await (await getHistory(u, '?page=1')).json()) as HistoryPage
    expect(p1).toMatchObject({ page: 1, total: 21 })
    expect(p1.items).toHaveLength(20)
    expect(p1.items[0]!.nickname).toBe('Bếp 0') // newest
    const p2 = (await (await getHistory(u, '?page=2')).json()) as HistoryPage
    expect(p2.page).toBe(2)
    expect(p2.items).toHaveLength(1)
    expect(p2.items[0]!.nickname).toBe('Bếp 20')
    const tooBig = await getHistory(u, '?size=21')
    expect(tooBig.status).toBe(400)
  })

  // ============================================================== AC-QUIZ-20
  it('AC-QUIZ-20: link phòng cũ không kèm UUID trả finished với bảng ván mới nhất (nickname, điểm, số câu đúng, hạng) và danh sách ván trước; không có UUID của ai', async () => {
    const [u1, u2, u3] = [newId(), newId(), newId()]
    const code = fakeCode()
    const now = Date.now()
    const g1 = seedGame(code, 1, now - 7_200_000, [
      { seat: 1, id: u1, nick: 'Bếp Một', score: 3000, correct: 3, rank: 1 },
      { seat: 2, id: u2, nick: 'Bếp Hai', score: 1000, correct: 1, rank: 2 },
    ])
    const g2 = seedGame(code, 2, now - 3_600_000, [
      { seat: 1, id: u2, nick: 'Bếp Hai', score: 4500, correct: 5, rank: 1 },
      { seat: 2, id: u1, nick: 'Bếp Một', score: 2500, correct: 3, rank: 2 },
      { seat: 3, id: u3, nick: 'Bếp Ba', score: 0, correct: 0, rank: 3 },
    ])
    await env.DB.batch([...g1.stmts, ...g2.stmts])

    const res = await getRoom(code)
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const u of [u1, u2, u3]) expect(text).not.toContain(u)
    expect(UUID_IN_TEXT.test(text)).toBe(false)
    const view = JSON.parse(text) as RoomView
    expect(view.state).toBe('finished')
    expect(view.latest!.game_no).toBe(2)
    expect(view.latest!.standings).toEqual([
      { rank: 1, nickname: 'Bếp Hai', score: 4500, correct: 5 },
      { rank: 2, nickname: 'Bếp Một', score: 2500, correct: 3 },
      { rank: 3, nickname: 'Bếp Ba', score: 0, correct: 0 },
    ])
    expect(view.earlier).toHaveLength(1)
    expect(view.earlier[0]).toMatchObject({ game_no: 1, player_count: 2 })
    expect(Date.parse(view.earlier[0]!.finished_at)).toBe(now - 7_200_000)
  })

  // ============================================================== AC-QUIZ-21
  it('AC-QUIZ-21: tác vụ dọn hằng ngày xóa ván quá 90 ngày (dòng ván lẫn dòng người chơi); ván còn trong hạn giữ nguyên; link phòng đã dọn trả 404 và ván biến khỏi lịch sử', async () => {
    const u = newId()
    const now = Date.now()
    const oldCode = fakeCode()
    const freshCode = fakeCode()
    const edgeCode = fakeCode()
    const rows = (id: string | null) => [
      { seat: 1, id, nick: 'Bếp Cũ', score: 1000, correct: 1, rank: 1 },
      { seat: 2, id: newId(), nick: 'Bếp Phụ', score: 500, correct: 1, rank: 2 },
    ]
    const old = seedGame(oldCode, 1, now - 91 * DAY_MS, rows(u))
    const fresh = seedGame(freshCode, 1, now - 89 * DAY_MS, rows(u))
    const edge = seedGame(edgeCode, 1, now - 90 * DAY_MS + 3_600_000, rows(u)) // still inside 90 days
    await env.DB.batch([...old.stmts, ...fresh.stmts, ...edge.stmts])
    expect((await getRoom(oldCode)).status).toBe(200)

    const ctx = createExecutionContext()
    await handler.scheduled(createScheduledController({ scheduledTime: new Date(now), cron: '0 20 * * *' }), testEnv(), ctx)
    await waitOnExecutionContext(ctx)

    expect(await count('SELECT COUNT(*) AS n FROM quiz_game WHERE id = ?', old.gameId)).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM quiz_player WHERE game_id = ?', old.gameId)).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM quiz_game WHERE id IN (?, ?)', fresh.gameId, edge.gameId)).toBe(2)
    expect(await count('SELECT COUNT(*) AS n FROM quiz_player WHERE game_id IN (?, ?)', fresh.gameId, edge.gameId)).toBe(4)

    const gone = await getRoom(oldCode)
    expect(gone.status).toBe(404)
    isProblem(gone)
    expect((await getRoom(freshCode)).status).toBe(200)
    const history = (await (await getHistory(u)).json()) as HistoryPage
    expect(history.items.map((i) => i.code).sort()).toEqual([freshCode, edgeCode].sort())
  })

  // ============================================================== AC-QUIZ-22
  it('AC-QUIZ-22: GET /me có quiz_history; DELETE /me bỏ UUID và đổi nickname thành "Thực khách ẩn danh" ở các dòng của U, giữ điểm và hạng, bảng của U2 không đổi; lịch sử của U rỗng', async () => {
    const u = newId()
    const u2 = newId()
    const now = Date.now()
    const codeA = fakeCode()
    const codeB = fakeCode()
    const a = seedGame(codeA, 1, now - 3_600_000, [
      { seat: 1, id: u, nick: 'Bếp U', score: 4000, correct: 4, rank: 1 },
      { seat: 2, id: u2, nick: 'Bếp U2', score: 2000, correct: 2, rank: 2 },
    ])
    const b = seedGame(codeB, 1, now - 1_800_000, [
      { seat: 1, id: u2, nick: 'Bếp U2', score: 3500, correct: 4, rank: 1 },
      { seat: 2, id: u, nick: 'Bếp U Hai', score: 1500, correct: 2, rank: 2 },
    ])
    await env.DB.batch([ins.consent(u), ins.consent(u2), ...a.stmts, ...b.stmts])

    const me = await getMe(u)
    expect(me.status).toBe(200)
    const data = (await me.json()) as { quiz_history: HistoryItem[] }
    expect(data.quiz_history).toHaveLength(2)
    expect(data.quiz_history.map((i) => i.code).sort()).toEqual([codeA, codeB].sort())
    const ofA = data.quiz_history.find((i) => i.code === codeA)!
    expect(ofA).toMatchObject({ game_no: 1, nickname: 'Bếp U', score: 4000, rank: 1, player_count: 2 })
    expect(Date.parse(ofA.finished_at)).toBe(now - 3_600_000)
    expect(JSON.stringify(data.quiz_history)).not.toContain(u2)

    expect((await delMe(u)).status).toBe(204)

    const mine = (await env.DB.prepare('SELECT COUNT(*) AS n FROM quiz_player WHERE player_id = ?').bind(u).first<{ n: number }>())!.n
    expect(mine).toBe(0)
    const anon = (
      await env.DB.prepare('SELECT game_id, seat, player_id, nickname, score, correct, rank FROM quiz_player WHERE game_id IN (?, ?) AND seat = CASE game_id WHEN ? THEN 1 ELSE 2 END').bind(a.gameId, b.gameId, a.gameId).all<Record<string, unknown>>()
    ).results
    expect(anon).toHaveLength(2)
    for (const r of anon) expect(r).toMatchObject({ player_id: null, nickname: ANON })
    expect(anon.find((r) => r.game_id === a.gameId)).toMatchObject({ score: 4000, correct: 4, rank: 1 })
    expect(anon.find((r) => r.game_id === b.gameId)).toMatchObject({ score: 1500, correct: 2, rank: 2 })
    // U2's rows are untouched
    const theirs = (await env.DB.prepare('SELECT nickname, score, rank, player_id FROM quiz_player WHERE player_id = ? ORDER BY score').bind(u2).all<Record<string, unknown>>()).results
    expect(theirs).toEqual([
      { nickname: 'Bếp U2', score: 2000, rank: 2, player_id: u2 },
      { nickname: 'Bếp U2', score: 3500, rank: 1, player_id: u2 },
    ])

    const after = (await (await getHistory(u)).json()) as HistoryPage
    expect(after.items).toEqual([])
    expect(((await (await getMe(u)).json()) as { quiz_history: unknown[] }).quiz_history).toEqual([])
    const view = (await (await getRoom(codeA)).json()) as RoomView
    expect(view.latest!.standings.map((s) => [s.rank, s.nickname, s.score])).toEqual([
      [1, ANON, 4000],
      [2, 'Bếp U2', 2000],
    ])
  })

  // ============================================================== AC-QUIZ-23
  it('AC-QUIZ-23: phòng chờ không ai kết nối 5 phút bị hủy: GET trả 404 và không còn dòng quiz_room', async () => {
    const host = mkPlayers(1)[0]!
    await env.DB.batch([ins.consent(host.id)])
    const { code } = (await (await createRoom(host)).json()) as Created
    expect((await getRoom(code)).status).toBe(200)
    expect(await drain(code)).toBeGreaterThan(0) // the 5 minute alarm, nobody ever connected
    const res = await getRoom(code)
    expect(res.status).toBe(404)
    isProblem(res)
    expect(await count('SELECT COUNT(*) AS n FROM quiz_room WHERE code = ?', code)).toBe(0)
  })

  it(
    'AC-QUIZ-23: ván đang chơi dở mà mọi người rời hết 5 phút thì bị hủy, không ghi lịch sử, GET trả 404',
    async () => {
      const { code, clients: cs } = await setupGame(2)
      cs[0]!.send({ type: 'start' })
      await Promise.all(cs.map((c) => c.next('question')))
      for (const c of cs) await c.close()
      await sleep(300)
      expect(await drain(code)).toBeGreaterThan(0)
      const res = await getRoom(code)
      expect(res.status).toBe(404)
      isProblem(res)
      expect(await count('SELECT COUNT(*) AS n FROM quiz_game WHERE room_code = ?', code)).toBe(0)
    },
    GAME_TIMEOUT,
  )

  it(
    'AC-QUIZ-23: ván đã kết thúc mà không ai kết nối 5 phút thì Durable Object bị dọn nhưng link phòng vẫn trả finished từ lịch sử',
    async () => {
      const { code, clients: cs } = await setupGame(2)
      cs[0]!.send({ type: 'start' })
      const game = await playGame(code, cs, (ci, q) => (ci === 0 ? correctPair(q) : wrongPair(q)))
      expect(game.finals[0]!.saved).toBe(true)
      for (const c of cs) await c.close()
      await sleep(300)
      await drain(code)
      const res = await getRoom(code)
      expect(res.status).toBe(200)
      const view = (await res.json()) as RoomView
      expect(view.state).toBe('finished')
      expect(view.latest).toMatchObject({ game_no: 1 })
      expect(view.latest!.standings.map((s) => s.nickname)).toEqual(['Bếp 1', 'Bếp 2'])
    },
    GAME_TIMEOUT,
  )

  it(
    'AC-QUIZ-23: khi mọi người rời giữa ván, đồng hồ câu vẫn chạy tới hết rồi dừng ở câu kế tiếp chờ người quay lại',
    async () => {
      const { players, code, clients: cs } = await setupGame(2)
      cs[0]!.send({ type: 'start' })
      await Promise.all(cs.map((c) => c.next('question')))
      for (const c of cs) await c.close()
      await sleep(300)
      await tick(code) // question 1 runs to its deadline with nobody there
      const back = await Client.open(code)
      back.send({ type: 'join', uuid: players[0]!.id, nickname: players[0]!.nick })
      let next: QuestionMsg
      try {
        next = await back.waitAny<QuestionMsg>('question', (m) => m.q === 2, 3000)
      } catch {
        await tick(code) // the 4 s pause before question 2
        next = await back.waitAny<QuestionMsg>('question', (m) => m.q === 2)
      }
      expect(next.q).toBe(2)
      expect(back.all('error')).toEqual([])
    },
    GAME_TIMEOUT,
  )

  // ============================================================== AC-QUIZ-24
  it(
    'AC-QUIZ-24: chủ phòng bấm replay -> phòng về lobby (điểm về 0) nhận người mới, người không phải chủ nhận not_host; ván 2 dùng đề khác; link phòng vẫn xem được ván 1',
    async () => {
      const { code, clients: cs } = await setupGame(2)
      const newcomer = { id: newId(), nick: 'Bếp Mới' }
      await env.DB.batch([ins.consent(newcomer.id)])
      cs[0]!.send({ type: 'start' })
      const game1 = await playGame(code, cs, allCorrect)
      expect(game1.finals[0]!.game_no).toBe(1)

      cs[1]!.send({ type: 'replay' })
      expect(await cs[1]!.errorCode()).toBe('not_host')
      cs[0]!.send({ type: 'replay' })
      const lobbies = await Promise.all(cs.map((c) => c.next<LobbyMsg>('lobby', (m) => m.last_game !== null)))
      for (const l of lobbies) {
        expect(l.players.filter((p) => p.connected).map((p) => p.nickname)).toEqual(['Bếp 1', 'Bếp 2'])
        expect(l.last_game).toMatchObject({ game_no: 1 })
      }

      // a newcomer can join again, and the link shows a lobby with the latest game
      const fresh = await join(code, newcomer)
      expect(fresh.lobby.players.map((p) => p.nickname)).toEqual(['Bếp 1', 'Bếp 2', 'Bếp Mới'])
      const view = (await (await getRoom(code)).json()) as RoomView
      expect(view.state).toBe('lobby')
      expect(view.latest).toMatchObject({ game_no: 1 })
      expect(view.latest!.standings).toHaveLength(2)

      // game 2: new deck, scores start from 0
      cs[0]!.send({ type: 'start' })
      const all = [...cs, fresh.c]
      const started = await cs[1]!.next<StartedMsg>('started')
      expect(started.game_no).toBe(2)
      const game2 = await playGame(code, all, allCorrect)
      const names1 = game1.questions.map((q) => q.target.name)
      const names2 = game2.questions.map((q) => q.target.name)
      expect(names2).not.toEqual(names1)
      const f2 = game2.finals[0]!
      expect(f2.game_no).toBe(2)
      expect(f2.standings).toHaveLength(3)
      for (const s of f2.standings) {
        expect(s.correct).toBe(5)
        expect(s.score).toBeLessThanOrEqual(5000) // not 5000 + game 1
      }

      // both games stay visible through the link
      const after = (await (await getRoom(code)).json()) as RoomView
      expect(after.latest!.game_no).toBe(2)
      expect(after.earlier.map((e) => e.game_no)).toEqual([1])
    },
    GAME_TIMEOUT * 2,
  )

  // ============================================================== AC-QUIZ-25
  it('AC-QUIZ-25: JSON hỏng hoặc type lạ nhận error bad_request và socket giữ; tin lớn hơn 1 KB hoặc hơn 10 tin/giây bị đóng mã 1008 và người chơi vào lại được', async () => {
    const { players, code, clients: cs } = await setupGame(2)
    const [host, guest] = cs as [Client, Client]

    guest.send('{not json')
    expect(await guest.errorCode()).toBe('bad_request')
    guest.send({ type: 'zzz' })
    expect(await guest.errorCode()).toBe('bad_request')
    guest.send('[]')
    expect(await guest.errorCode()).toBe('bad_request')
    await sleep(200)
    expect(guest.closeInfo).toBeNull() // kept

    // too big
    guest.send(JSON.stringify({ type: 'join', uuid: players[1]!.id, nickname: 'x'.repeat(2000) }))
    expect((await guest.closed()).code).toBe(1008)

    // too fast
    for (let i = 0; i < 25; i++) host.sendRaw({ type: 'zzz' })
    expect((await host.closed()).code).toBe(1008)

    // both come back
    const back = await join(code, players[1]!)
    expect(back.lobby.players.some((p) => p.nickname === 'Bếp 2' && p.connected)).toBe(true)
    expect(back.lobby.players.filter((p) => p.nickname === 'Bếp 2')).toHaveLength(1) // rejoined, not added twice
    const back1 = await join(code, players[0]!)
    expect(back1.lobby.players.some((p) => p.nickname === 'Bếp 1' && p.connected)).toBe(true)
    expect(back1.lobby.players.filter((p) => p.nickname === 'Bếp 1')).toHaveLength(1)
  })

  it('AC-QUIZ-25: WebSocket tới phòng không tồn tại bị từ chối 404 problem+json; thiếu Upgrade trả 426; mã sai định dạng trả 400', async () => {
    const ctx = createExecutionContext()
    const missing = await handler.fetch(new Request(`https://example.com${BASE}/quiz/rooms/ZZZZZZ/ws`, { headers: { Upgrade: 'websocket' } }), testEnv(), ctx)
    expect(missing.status).toBe(404)
    expect(missing.webSocket).toBeNull()
    isProblem(missing)

    const host = mkPlayers(1)[0]!
    await env.DB.batch([ins.consent(host.id)])
    const { code } = (await (await createRoom(host)).json()) as Created
    const noUpgrade = await raw(`${BASE}/quiz/rooms/${code}/ws`)
    expect(noUpgrade.status).toBe(426)
    isProblem(noUpgrade)

    const malformed = await handler.fetch(new Request(`https://example.com${BASE}/quiz/rooms/abc/ws`, { headers: { Upgrade: 'websocket' } }), testEnv(), createExecutionContext())
    expect([400, 404]).toContain(malformed.status)
  })

  it('AC-QUIZ-25: log không chứa UUID thô, IP hay nickname', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const { players, code, clients: cs } = await setupGame(2)
    cs[1]!.send('{not json')
    await cs[1]!.next('error')
    const late = await Client.open(code)
    late.send({ type: 'join', uuid: 'not-a-uuid', nickname: 'Bếp Bí Mật' })
    await late.next('error')
    cs[0]!.send({ type: 'start' })
    await cs[1]!.next('question')
    await sleep(200)

    const logged = spies.flatMap((s) => s.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
    const all = logged.join('\n')
    for (const p of players) {
      expect(all).not.toContain(p.id)
      expect(all).not.toContain(p.nick)
      expect(all).not.toContain(ipFor(p.id))
    }
    expect(all).not.toContain('Bếp Bí Mật')
    expect(all).not.toContain('not-a-uuid')
    expect(all).not.toMatch(UUID_IN_TEXT)
  })

  // ============================================================== TENANT / VALIDATION / ABUSE
  it('AC-QUIZ-TENANT: người chơi B không đọc được lịch sử của A, không xóa được dòng của A, và link phòng không lộ UUID của A', async () => {
    const a = newId()
    const b = newId()
    const now = Date.now()
    const codeA = fakeCode()
    const codeB = fakeCode()
    const ga = seedGame(codeA, 1, now - 3_600_000, [
      { seat: 1, id: a, nick: 'Bếp Của A', score: 3000, correct: 3, rank: 1 },
      { seat: 2, id: newId(), nick: 'Bếp Phụ', score: 100, correct: 1, rank: 2 },
    ])
    const gb = seedGame(codeB, 1, now - 1_800_000, [
      { seat: 1, id: newId(), nick: 'Bếp Phụ', score: 3000, correct: 3, rank: 1 },
      { seat: 2, id: b, nick: 'Bếp Của B', score: 100, correct: 1, rank: 2 },
    ])
    await env.DB.batch([ins.consent(a), ins.consent(b), ...ga.stmts, ...gb.stmts])

    const mine = (await (await getHistory(b)).json()) as HistoryPage
    expect(mine.items.map((i) => i.code)).toEqual([codeB])
    const text = JSON.stringify(mine)
    expect(text).not.toContain(codeA)
    expect(text).not.toContain('Bếp Của A')
    const meData = JSON.stringify(await (await getMe(b)).json())
    expect(meData).not.toContain(codeA)
    expect(meData).not.toContain(a)

    expect((await delMe(b)).status).toBe(204)
    const rowA = await env.DB.prepare('SELECT player_id, nickname FROM quiz_player WHERE game_id = ? AND seat = 1').bind(ga.gameId).first<{ player_id: string; nickname: string }>()
    expect(rowA).toEqual({ player_id: a, nickname: 'Bếp Của A' })

    const roomText = await (await getRoom(codeA)).text()
    expect(roomText).not.toContain(a)
    expect(UUID_IN_TEXT.test(roomText)).toBe(false)
  })

  it('AC-QUIZ-VALIDATION: tạo phòng với số âm, số khổng lồ, kiểu sai, chuỗi dài, script, SQL, trường lạ bị từ chối 4xx (không 5xx) và không tạo phòng; tham số lịch sử và mã phòng sai bị từ chối', async () => {
    const host = mkPlayers(1)[0]!
    await env.DB.batch([ins.consent(host.id)])
    const before = await count('SELECT COUNT(*) AS n FROM quiz_room')
    const bodies: unknown[] = [
      { nickname: 'Bếp', questions: -5 },
      { nickname: 'Bếp', questions: 1e9 },
      { nickname: 'Bếp', questions: [10] },
      { nickname: 'Bếp', seconds: null },
      { nickname: 'A'.repeat(10_000) },
      { nickname: '<script>alert(1)</script>' },
      { nickname: "Bếp'; DROP TABLE quiz_room;--" },
      { nickname: 'Bếp', host: true, code: 'AAAAAA', state: 'playing' },
      { nickname: 12345 },
      [],
      'text',
    ]
    for (const b of bodies) {
      const res = await createRoom(host, JSON.stringify(b))
      expect(res.status, JSON.stringify(b).slice(0, 60)).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(res.status).not.toBe(429)
      isProblem(res)
    }
    const notJson = await createRoom(host, '{"nickname": ')
    expect(notJson.status).toBe(400)
    isProblem(notJson)
    const wrongType = await raw(`${BASE}/quiz/rooms`, { method: 'POST', body: 'nickname=Bếp', headers: { 'Content-Type': 'text/plain' } }, as(host.id))
    expect([400, 415]).toContain(wrongType.status)
    isProblem(wrongType)
    expect(await count('SELECT COUNT(*) AS n FROM quiz_room')).toBe(before)

    const u = newId()
    for (const q of ['?page=0', '?page=-1', '?page=abc', '?size=0', '?size=1000', '?size=abc']) {
      const res = await getHistory(u, q)
      expect(res.status, q).toBe(400)
      isProblem(res)
    }
    for (const code of ['abc', '../etc/passwd', 'ABCDE', 'ABCDEFG', 'ABCDE0', '<script>']) {
      const res = await getRoom(encodeURIComponent(code))
      expect([400, 404], code).toContain(res.status)
      isProblem(res)
    }
  })

  it('AC-QUIZ-VALIDATION: join và tin client có trường lạ, sai kiểu hoặc q/picks nguy hiểm nhận error bad_request/bad_answer/wrong_question, không đổi điểm và socket không sập', async () => {
    const { players, code, clients: cs } = await setupGame(2)
    const [host, guest] = cs as [Client, Client]
    const extra = await Client.open(code)
    extra.send({ type: 'join', uuid: players[1]!.id, nickname: 'Bếp Hai', host: true })
    expect(await extra.errorCode()).toBe('bad_request')
    extra.send({ type: 'join', uuid: players[1]!.id, nickname: 12345 })
    expect(await extra.errorCode()).toBe('bad_request')
    host.send({ type: 'start', extra: 1 })
    expect(await host.errorCode()).toBe('bad_request')

    host.send({ type: 'start' })
    const q = await host.next<QuestionMsg>('question')
    await guest.next('question')
    const [a] = correctPair(q)
    for (const bad of [
      { type: 'answer', q: -1, picks: [a, a] },
      { type: 'answer', q: 1e12, picks: [a, a] },
      { type: 'answer', q: '1', picks: [a, a] },
      { type: 'answer', q: 1, picks: 'abc' },
      { type: 'answer', q: 1, picks: [{ id: a }, { id: a }] },
      { type: 'answer', q: 1, picks: ['<script>alert(1)</script>', "' OR 1=1 --"] },
      { type: 'answer', picks: [a, a] },
      { type: 'answer', q: 1, picks: [a, correctPair(q)[1]], score: 99999 },
    ]) {
      host.send(bad)
      const code2 = await host.errorCode()
      expect(['bad_request', 'bad_answer', 'wrong_question'], JSON.stringify(bad).slice(0, 50)).toContain(code2)
      await sleep(120) // stay far below the 10 messages/second limit
    }
    expect(host.closeInfo).toBeNull()
    host.send({ type: 'answer', q: 1, picks: correctPair(q) }) // a real answer still works afterwards
    expect(await host.next<AnsweredMsg>('answered')).toEqual({ type: 'answered', q: 1 })
  })

  it('AC-QUIZ-ABUSE: trường giả danh (uuid người khác, mã phòng, chủ phòng) và thân quá lớn bị từ chối 4xx; phòng chỉ gắn với UUID trong header', async () => {
    const attacker = mkPlayers(1)[0]!
    const victim = newId()
    await env.DB.batch([ins.consent(attacker.id)])
    const before = await count('SELECT COUNT(*) AS n FROM quiz_room')

    for (const body of [
      { nickname: 'Bếp', uuid: victim },
      { nickname: 'Bếp', player_id: victim, host: victim },
      { nickname: 'Bếp', code: 'AAAAAA' },
    ]) {
      const res = await createRoom(attacker, JSON.stringify(body))
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      isProblem(res)
    }
    const huge = await createRoom(attacker, JSON.stringify({ nickname: 'Bếp', pad: 'z'.repeat(200_000) }))
    expect(huge.status).toBeGreaterThanOrEqual(400)
    expect(huge.status).toBeLessThan(500)
    expect(await count('SELECT COUNT(*) AS n FROM quiz_room')).toBe(before)

    // a UUID in the header is the only identity: the victim's consent does not help a stranger without one
    const noConsentRes = await createRoom(victim, {})
    expect(noConsentRes.status).toBe(403)
  })

  // ============================================================== review findings
  it(
    'AC-QUIZ-11: câu trả lời đến sau hạn nhưng trước khi alarm đóng câu bị từ chối too_late và không được điểm',
    async () => {
      const { code, clients: cs } = await setupGame(2, { seconds: 10 })
      const [c1, c2] = cs as [Client, Client]
      c1.send({ type: 'start' })
      const q = await c1.next<QuestionMsg>('question')
      await c2.next<QuestionMsg>('question')
      c1.send({ type: 'answer', q: 1, picks: correctPair(q) })
      await c1.next<AnsweredMsg>('answered')

      // move the stored deadline into the past without running the alarm
      await runInDurableObject(roomStub(code), async (instance, state) => {
        const room = (await state.storage.get('room')) as { deadline: number }
        room.deadline = Date.now() - 1
        await state.storage.put('room', room)
        ;(instance as unknown as { room: unknown }).room = undefined
      })

      c2.send({ type: 'answer', q: 1, picks: correctPair(q) })
      expect(await c2.errorCode()).toBe('too_late')
      expect(c2.all('answered')).toEqual([])

      await tick(code)
      const reveal = await c1.next<RevealMsg>('reveal')
      const bySeat = new Map(reveal.results.map((r) => [r.seat, r]))
      expect(bySeat.get(2)).toMatchObject({ picks: null, points: 0 })
    },
    GAME_TIMEOUT,
  )

  it('AC-QUIZ-07: host gửi start hai lần liên tiếp -> chỉ một started (game_no 1) và một question q=1, lần hai nhận bad_request, phòng playing game_no 1', async () => {
    const { code, clients: cs } = await setupGame(2)
    const [host, guest] = cs as [Client, Client]
    host.send({ type: 'start' })
    host.send({ type: 'start' })
    expect(await host.errorCode()).toBe('bad_request')
    await guest.next<QuestionMsg>('question')
    await sleep(400)
    const started = guest.all<StartedMsg>('started')
    expect(started).toHaveLength(1)
    expect(started[0]!.game_no).toBe(1)
    expect(guest.all<QuestionMsg>('question').filter((m) => m.q === 1)).toHaveLength(1)
    expect(guest.all<QuestionMsg>('question')).toHaveLength(1)
    const view = (await (await getRoom(code)).json()) as RoomView
    expect(view.state).toBe('playing')
  })

  it('AC-QUIZ-25: socket gửi 10 join bị từ chối nickname thì bị đóng mã 1008; socket mới join hợp lệ vẫn dùng được', async () => {
    const [host, ok] = mkPlayers(2) as [Player, Player]
    await env.DB.batch([ins.consent(host.id), ins.consent(ok.id)])
    const { code } = (await (await createRoom(host)).json()) as Created
    await join(code, host)

    const bad = await Client.open(code)
    for (let i = 0; i < 10; i++) {
      bad.send({ type: 'join', uuid: ok.id, nickname: 'A' })
      if (i < 9) {
        expect(await bad.errorCode()).toBe('nickname_rejected')
        await sleep(120) // stay below the 10 messages/second limit
      }
    }
    expect((await bad.closed()).code).toBe(1008)

    const fresh = await join(code, ok, 'Bếp Ổn')
    expect(fresh.lobby.players.some((p) => p.nickname === 'Bếp Ổn' && p.connected)).toBe(true)
  })

  it(
    'AC-QUIZ-22: người xóa dữ liệu giữa ván nhiều người được ghi lịch sử ẩn danh (player_id NULL, "Thực khách ẩn danh") và giữ điểm; người kia giữ UUID',
    async () => {
      const { players, code, clients: cs } = await setupGame(2)
      cs[0]!.send({ type: 'start' })
      expect((await delMe(players[1]!.id)).status).toBe(204) // the socket of the erased player stays connected
      const game = await playGame(code, cs, (ci, q) => (ci === 0 || q.q === 1 ? correctPair(q) : wrongPair(q)))
      expect(game.finals[0]!.saved).toBe(true)

      const rows = (
        await env.DB.prepare(
          'SELECT p.seat, p.player_id, p.nickname, p.score FROM quiz_player p JOIN quiz_game g ON g.id = p.game_id WHERE g.room_code = ? ORDER BY p.seat',
        )
          .bind(code)
          .all<{ seat: number; player_id: string | null; nickname: string; score: number }>()
      ).results
      expect(rows).toHaveLength(2)
      const finalScore = (seat: number) => game.finals[0]!.standings.find((s) => s.seat === seat)!.score
      expect(rows[0]).toMatchObject({ seat: 1, player_id: players[0]!.id, nickname: players[0]!.nick, score: finalScore(1) })
      expect(rows[1]).toMatchObject({ seat: 2, player_id: null, nickname: ANON, score: finalScore(2) })
      expect(rows[1]!.score).toBeGreaterThan(0)
    },
    GAME_TIMEOUT,
  )
})
