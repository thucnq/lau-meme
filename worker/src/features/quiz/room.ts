import { DurableObject } from 'cloudflare:workers'
import { problem } from '../../http'
import { fold } from '../../ids'
import { uuidv7 } from '../../uuid'
import { type ConsentRow, playConsentStatement, requirePlayConsent } from '../player/consent'
import { generateQuiz, type QuizContent } from './questions'
import { bannedTermsStatement, isBanned, roomNickname } from './nickname'
import { questionPoints, rankPlayers, soloAnswerHash } from './scoring'

/**
 * One mQuiz room (ADR 0021, docs/api/quiz-ws.md). The whole room is one storage value; the alarm is the room clock and
 * always runs the room's next step whatever the time it fires at (tests fire it early).
 */
const MAX_PLAYERS = 50
const MIN_QUESTIONS = 5
const PAUSE_MS = 4_000
const HOST_GRACE_MS = 30_000
const IDLE_MS = 5 * 60_000 // open question 92
const MAX_MESSAGE = 1024
const MAX_RATE = 10 // messages per second per socket
const CLOSE_POLICY = 1008
const CLOSE_REPLACED = 4001
const TOP = 10
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Item = { id: string; name: string; emoji: string; image_key: string | null }
type Question = { target: Omit<Item, 'id'>; options: Item[]; answer: [string, string] }
type Seat = { seat: number; uuid: string; nickname: string; score: number; correct: number; correct_ms: number }
type Answer = { picks: [string, string]; at: number }
type Standing = { rank: number; nickname: string; score: number; correct: number }
type GameSummary = { game_no: number; questions: number; seconds: number; started_at: string; finished_at: string; standings: Standing[] }
type Phase = 'lobby' | 'question' | 'reveal' | 'held' | 'finished' | 'solo'
type Room = {
  code: string
  questions: number
  seconds: number
  host: number
  next_seat: number
  players: Seat[]
  phase: Phase
  game_no: number
  deck: Question[]
  cur: number // 1-based number of the last opened question, 0 before the first
  sent_at: number
  deadline: number
  next_at: number
  answers: Record<string, Answer>
  content_version: number
  started_at: number
  host_left_at: number | null
  idle_since: number | null
  last_game: GameSummary | null
  last_reveal: Record<string, unknown> | null
  last_final: Record<string, unknown> | null
  solo_pack: Record<string, unknown> | null
}
type Attachment = { uuid?: string; seat?: number }
type Msg = Record<string, unknown>

class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly close = false,
  ) {
    super(code)
  }
}

const MESSAGES: Record<string, string> = {
  bad_request: 'Tin nhắn không hợp lệ',
  not_joined: 'Cần vào phòng trước',
  consent_required: 'Cần đồng ý với chính sách dữ liệu trước khi chơi',
  nickname_rejected: 'Nickname không hợp lệ',
  room_full: 'Phòng đã đủ 50 người',
  already_started: 'Phòng đã bắt đầu',
  not_host: 'Chỉ chủ phòng làm được việc này',
  not_enough_questions: 'Không đủ câu hỏi để bắt đầu',
  already_answered: 'Bạn đã chốt câu này',
  bad_answer: 'Cần chọn đúng 2 trong 4 lựa chọn',
  wrong_question: 'Không phải câu đang mở',
  too_late: 'Đã hết giờ câu này',
}

const iso = (ms: number) => new Date(ms).toISOString()

function keys(m: Msg, allowed: string[]): void {
  if (Object.keys(m).some((k) => !allowed.includes(k))) throw new Refusal('bad_request')
}

export class QuizRoom extends DurableObject<Env> {
  private room: Room | null | undefined
  private rate = new Map<WebSocket, number[]>()

  private async load(): Promise<Room | null> {
    if (this.room === undefined) this.room = (await this.ctx.storage.get<Room>('room')) ?? null
    return this.room
  }

  /** Stores the room and sets the alarm to its next step. */
  private async save(room: Room): Promise<void> {
    this.room = room
    const at = this.nextStep(room)
    await this.ctx.storage.put('room', room)
    if (at === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(at)
  }

  // ------------------------------------------------------------------ HTTP from the Worker
  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/init' && req.method === 'POST') return this.init((await req.json()) as Msg)
    const room = await this.load()
    if (!room) return problem(404, 'Không tìm thấy phòng')
    if (path === '/view') return Response.json(this.view(room))
    if (path === '/ws') {
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({} satisfies Attachment)
      return new Response(null, { status: 101, webSocket: client })
    }
    return problem(404, 'Không tìm thấy')
  }

  private async init(m: Msg): Promise<Response> {
    if (await this.load()) return problem(409, 'Phòng đã tồn tại')
    const now = Date.now()
    await this.save({
      code: String(m.code),
      questions: Number(m.questions),
      seconds: Number(m.seconds),
      host: 1,
      next_seat: 2,
      players: [{ seat: 1, uuid: String(m.uuid), nickname: String(m.nickname), score: 0, correct: 0, correct_ms: 0 }],
      phase: 'lobby',
      game_no: 0,
      deck: [],
      cur: 0,
      sent_at: 0,
      deadline: 0,
      next_at: 0,
      answers: {},
      content_version: 0,
      started_at: 0,
      host_left_at: now,
      idle_since: now,
      last_game: null,
      last_reveal: null,
      last_final: null,
      solo_pack: null,
    })
    return new Response(null, { status: 204 })
  }

  private view(room: Room) {
    const state = room.phase === 'lobby' ? 'lobby' : room.phase === 'finished' ? 'finished' : 'playing'
    return {
      code: room.code,
      state,
      questions: room.questions,
      seconds: room.seconds,
      players: state === 'finished' ? [] : room.players.map((p) => p.nickname),
    }
  }

  // ------------------------------------------------------------------ sockets
  private sockets(except?: WebSocket): Array<{ ws: WebSocket; seat: number }> {
    const out: Array<{ ws: WebSocket; seat: number }> = []
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue
      const seat = (ws.deserializeAttachment() as Attachment | null)?.seat
      if (seat !== undefined) out.push({ ws, seat })
    }
    return out
  }

  private connectedSeats(except?: WebSocket): Set<number> {
    return new Set(this.sockets(except).map((s) => s.seat))
  }

  private send(ws: WebSocket, m: Msg): void {
    try {
      ws.send(JSON.stringify(m))
    } catch {
      // the socket went away; its close event does the rest
    }
  }

  private broadcast(make: (seat: number) => Msg, except?: WebSocket): void {
    for (const { ws, seat } of this.sockets(except)) this.send(ws, make(seat))
  }

  private refuse(ws: WebSocket, code: string, close: boolean): void {
    this.send(ws, { type: 'error', code, message: MESSAGES[code] ?? MESSAGES.bad_request })
    if (close) ws.close(CLOSE_POLICY, code)
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const size = typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength
    const now = Date.now()
    const recent = (this.rate.get(ws) ?? []).filter((t) => now - t < 1000)
    recent.push(now)
    this.rate.set(ws, recent)
    if (size > MAX_MESSAGE || recent.length > MAX_RATE) {
      ws.close(CLOSE_POLICY, 'policy')
      await this.disconnected(ws)
      return
    }
    const room = await this.load()
    if (!room) {
      ws.close(1000, 'gone')
      return
    }
    try {
      let m: unknown
      try {
        m = typeof data === 'string' ? JSON.parse(data) : null
      } catch {
        throw new Refusal('bad_request')
      }
      if (typeof m !== 'object' || m === null || Array.isArray(m) || typeof (m as Msg).type !== 'string') throw new Refusal('bad_request')
      const msg = m as Msg
      const att = (ws.deserializeAttachment() as Attachment | null) ?? {}
      if (att.seat === undefined) {
        if (msg.type !== 'join') {
          if (['start', 'answer', 'replay', 'leave'].includes(msg.type as string)) throw new Refusal('not_joined', true)
          throw new Refusal('bad_request')
        }
        await this.join(room, ws, msg)
        return
      }
      const seat = att.seat
      switch (msg.type) {
        case 'start':
          keys(msg, ['type'])
          return await this.start(room, ws, seat)
        case 'answer':
          return await this.answer(room, ws, seat, msg)
        case 'replay':
          keys(msg, ['type'])
          return await this.replay(room, seat)
        case 'leave':
          keys(msg, ['type'])
          ws.close(1000, 'leave')
          return await this.disconnected(ws)
        default:
          throw new Refusal('bad_request')
      }
    } catch (err) {
      if (err instanceof Refusal) return this.refuse(ws, err.code, err.close)
      // never the message, UUID or nickname (AC-QUIZ-25, AC-PRIV-07)
      console.error('quiz room', err instanceof Error ? err.name : 'unknown')
      this.refuse(ws, 'bad_request', false)
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye')
    } catch {
      // already closed
    }
    await this.disconnected(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnected(ws)
  }

  /** A socket left: in the lobby a player leaves the list (the host stays for HOST_GRACE_MS); in a game nobody leaves. */
  private async disconnected(ws: WebSocket): Promise<void> {
    this.rate.delete(ws)
    const room = await this.load()
    const seat = (ws.deserializeAttachment() as Attachment | null)?.seat
    ws.serializeAttachment({} satisfies Attachment)
    if (!room || seat === undefined) return
    const connected = this.connectedSeats(ws)
    if (connected.has(seat)) return // replaced by a newer socket of the same player
    const now = Date.now()
    if (room.phase === 'lobby') {
      if (seat === room.host) room.host_left_at = now
      else room.players = room.players.filter((p) => p.seat !== seat)
      this.broadcastLobby(room, ws)
    } else if (room.phase === 'question' && this.allAnswered(room, connected)) {
      await this.closeQuestion(room)
      return
    }
    await this.save(room)
  }

  // ------------------------------------------------------------------ join
  private async join(room: Room, ws: WebSocket, m: Msg): Promise<void> {
    if (typeof m.uuid !== 'string' || !UUID_V4.test(m.uuid)) throw new Refusal('bad_request', true)
    keys(m, ['type', 'uuid', 'nickname'])
    if (typeof m.nickname !== 'string' || m.nickname.length > 100) throw new Refusal('bad_request')
    const uuid = m.uuid.toLowerCase()
    const db = this.env.DB
    const [consent, banned] = await db.batch([playConsentStatement(db, uuid), bannedTermsStatement(db)])
    try {
      requirePlayConsent(this.env, consent?.results[0] as ConsentRow | undefined)
    } catch {
      throw new Refusal('consent_required', true)
    }
    const now = Date.now()
    const existing = room.players.find((p) => p.uuid === uuid)
    if (!existing) {
      if (room.phase !== 'lobby') throw new Refusal('already_started', true)
      if (room.players.length >= MAX_PLAYERS) throw new Refusal('room_full', true)
      const base = roomNickname(m.nickname)
      if (base === null || isBanned(base, banned)) throw new Refusal('nickname_rejected')
      const taken = new Set(room.players.map((p) => fold(p.nickname)))
      let nickname = base
      for (let n = 2; taken.has(fold(nickname)); n++) nickname = `${base} ${n}`
      room.players.push({ seat: room.next_seat++, uuid, nickname, score: 0, correct: 0, correct_ms: 0 })
    }
    const seat = existing?.seat ?? room.players[room.players.length - 1]!.seat
    // one socket per player: the older one is closed (AC-QUIZ-16)
    for (const s of this.sockets(ws)) if (s.seat === seat) {
      s.ws.serializeAttachment({} satisfies Attachment)
      s.ws.close(CLOSE_REPLACED, 'replaced')
    }
    ws.serializeAttachment({ uuid, seat } satisfies Attachment)
    if (seat === room.host) room.host_left_at = null

    switch (room.phase) {
      case 'lobby':
        this.broadcastLobby(room)
        break
      case 'solo':
        if (room.solo_pack) this.send(ws, room.solo_pack)
        break
      case 'finished':
        this.send(ws, this.lobbyMessage(room, seat))
        if (room.last_final) this.send(ws, room.last_final)
        break
      default:
        this.send(ws, this.startedMessage(room, now))
        if (room.phase === 'question') {
          this.send(ws, this.questionMessage(room, now))
          if (room.answers[seat]) this.send(ws, { type: 'answered', q: room.cur })
        } else if (room.phase === 'reveal' && room.last_reveal) {
          this.send(ws, this.revealFor(room, seat))
        } else if (room.phase === 'held') {
          await this.openQuestion(room, room.cur + 1)
          return
        }
    }
    await this.save(room)
  }

  private lobbyMessage(room: Room, seat: number): Msg {
    const connected = this.connectedSeats()
    return {
      type: 'lobby',
      code: room.code,
      questions: room.questions,
      seconds: room.seconds,
      host_seat: room.host,
      you: seat,
      players: room.players.map((p) => ({ seat: p.seat, nickname: p.nickname, connected: connected.has(p.seat) })),
      last_game: room.last_game,
      server_now: Date.now(),
    }
  }

  private broadcastLobby(room: Room, except?: WebSocket): void {
    this.broadcast((seat) => this.lobbyMessage(room, seat), except)
  }

  // ------------------------------------------------------------------ game
  private async start(room: Room, ws: WebSocket, seat: number): Promise<void> {
    if (seat !== room.host) throw new Refusal('not_host')
    if (room.phase !== 'lobby') throw new Refusal('bad_request')
    const db = this.env.DB
    const [current, blocks] = await db.batch([
      db.prepare(
        `SELECT c.version, c.server_json FROM batch_content c
         WHERE c.version = (SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'current_version')`,
      ),
      db.prepare("SELECT kind, target_id FROM block WHERE kind IN ('element', 'recipe', 'image')"),
    ])
    const batch = current?.results[0] as { version: number; server_json: string } | undefined
    if (!batch) throw new Refusal('not_enough_questions')
    const blocked = (blocks?.results ?? []) as Array<{ kind: string; target_id: string }>
    const ids = (kind: string) => blocked.filter((b) => b.kind === kind).map((b) => b.target_id)
    const content = JSON.parse(batch.server_json) as QuizContent
    const gameNo = room.game_no + 1
    const deck = generateQuiz(content, { elements: ids('element'), recipes: ids('recipe') }, `${room.code}:${gameNo}`, room.questions)
    if (deck.length < MIN_QUESTIONS) throw new Refusal('not_enough_questions')

    const used = [...new Set(deck.flatMap((q) => [q.target, ...q.options]))]
    const rows = (
      await db.prepare('SELECT id, name, emoji, image_key FROM element WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(used)).all<Item>()
    ).results
    const hiddenImages = new Set(ids('image'))
    const items = new Map(rows.map((r) => [r.id, { ...r, image_key: hiddenImages.has(r.id) ? null : r.image_key }]))
    const item = (id: string): Item => items.get(id) ?? { id, name: '?', emoji: '❓', image_key: null }
    const questions: Question[] = deck.map((q) => {
      const { name, emoji, image_key } = item(q.target)
      return { target: { name, emoji, image_key }, options: q.options.map(item), answer: q.answer }
    })

    const connected = this.connectedSeats()
    room.game_no = gameNo
    room.content_version = batch.version
    room.started_at = Date.now()
    if (connected.size === 1) {
      // one player: the whole deck once, answers only as salted hashes (AC-QUIZ-17); never saved
      const salt = `${room.code}:${gameNo}`
      room.phase = 'solo'
      room.solo_pack = {
        type: 'solo_pack',
        game_no: gameNo,
        total: questions.length,
        seconds: room.seconds,
        salt,
        items: await Promise.all(
          questions.map(async (q, i) => ({ target: q.target, options: q.options, answer_hash: await soloAnswerHash(salt, i + 1, ...q.answer) })),
        ),
      }
      this.send(ws, room.solo_pack)
      await this.save(room)
      return
    }
    room.players = room.players.filter((p) => connected.has(p.seat)).map((p) => ({ ...p, score: 0, correct: 0, correct_ms: 0 }))
    room.deck = questions
    room.last_reveal = null
    room.last_final = null
    this.broadcast(() => this.startedMessage(room, Date.now()))
    await this.openQuestion(room, 1)
  }

  private startedMessage(room: Room, now: number): Msg {
    return { type: 'started', game_no: room.game_no, total: room.deck.length, seconds: room.seconds, server_now: now }
  }

  private questionMessage(room: Room, now: number): Msg {
    const q = room.deck[room.cur - 1]!
    return { type: 'question', q: room.cur, total: room.deck.length, target: q.target, options: q.options, server_now: now, deadline: room.deadline }
  }

  private async openQuestion(room: Room, n: number): Promise<void> {
    const now = Date.now()
    room.phase = 'question'
    room.cur = n
    room.sent_at = now
    room.deadline = now + room.seconds * 1000
    room.answers = {}
    const m = this.questionMessage(room, now)
    this.broadcast(() => m)
    await this.save(room)
  }

  private allAnswered(room: Room, connected: Set<number>): boolean {
    return connected.size > 0 && [...connected].every((seat) => room.answers[seat] !== undefined)
  }

  private async answer(room: Room, ws: WebSocket, seat: number, m: Msg): Promise<void> {
    keys(m, ['type', 'q', 'picks'])
    if (typeof m.q !== 'number' || !Number.isInteger(m.q) || m.q < 1 || !Array.isArray(m.picks)) throw new Refusal('bad_request')
    if (room.phase !== 'question' || m.q !== room.cur) {
      throw new Refusal(room.cur > 0 && m.q <= room.cur && room.phase !== 'lobby' && room.phase !== 'solo' ? 'too_late' : 'wrong_question')
    }
    if (room.answers[seat]) throw new Refusal('already_answered')
    const options = new Set(room.deck[room.cur - 1]!.options.map((o) => o.id))
    const picks = m.picks as unknown[]
    if (picks.length !== 2 || picks[0] === picks[1] || !picks.every((p) => typeof p === 'string' && options.has(p))) throw new Refusal('bad_answer')
    room.answers[seat] = { picks: picks as [string, string], at: Date.now() }
    this.send(ws, { type: 'answered', q: room.cur })
    if (this.allAnswered(room, this.connectedSeats())) await this.closeQuestion(room)
    else await this.save(room)
  }

  private board(room: Room) {
    return rankPlayers(room.players)
  }

  private revealFor(room: Room, seat: number): Msg {
    const ranked = this.board(room)
    const me = ranked.find((p) => p.seat === seat)
    return {
      ...room.last_reveal,
      board: {
        top: ranked.slice(0, TOP).map((p) => ({ seat: p.seat, nickname: p.nickname, score: p.score, rank: p.rank })),
        me: me ? { seat: me.seat, score: me.score, rank: me.rank } : { seat, score: 0, rank: ranked.length + 1 },
      },
    }
  }

  private async closeQuestion(room: Room): Promise<void> {
    const q = room.deck[room.cur - 1]!
    const answer = new Set(q.answer)
    const results = room.players.map((p) => {
      const a = room.answers[p.seat]
      const ok = !!a && a.picks.every((id) => answer.has(id))
      const points = a ? questionPoints(ok, a.at - room.sent_at, room.seconds) : 0
      if (ok) {
        p.score += points
        p.correct += 1
        p.correct_ms += Math.max(0, a!.at - room.sent_at)
      }
      return { seat: p.seat, picks: a?.picks ?? null, ok, points }
    })
    const now = Date.now()
    room.phase = 'reveal'
    room.next_at = now + PAUSE_MS
    room.last_reveal = { type: 'reveal', q: room.cur, correct: q.answer, results, next_at: room.next_at }
    this.broadcast((seat) => this.revealFor(room, seat))
    await this.save(room)
  }

  private async afterPause(room: Room): Promise<void> {
    if (room.cur >= room.deck.length) return this.finish(room)
    if (this.connectedSeats().size === 0) {
      // nobody here: wait at the next question until someone comes back (AC-QUIZ-23)
      room.phase = 'held'
      await this.save(room)
      return
    }
    await this.openQuestion(room, room.cur + 1)
  }

  private async finish(room: Room): Promise<void> {
    const now = Date.now()
    const ranked = this.board(room)
    const db = this.env.DB
    let saved = true
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO quiz_game (id, room_code, game_no, content_version, questions, seconds, player_count, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (room_code, game_no) DO NOTHING`,
          )
          .bind(uuidv7(now), room.code, room.game_no, room.content_version, room.deck.length, room.seconds, room.players.length, room.started_at, now),
        ...ranked.map((p) =>
          db
            .prepare(
              `INSERT OR IGNORE INTO quiz_player (game_id, seat, player_id, nickname, score, correct, correct_ms, rank)
               SELECT id, ?, ?, ?, ?, ?, ?, ? FROM quiz_game WHERE room_code = ? AND game_no = ?`,
            )
            .bind(p.seat, p.uuid, p.nickname, p.score, p.correct, p.correct_ms, p.rank, room.code, room.game_no),
        ),
      ])
    } catch (err) {
      saved = false
      console.error('quiz history', err instanceof Error ? err.name : 'unknown')
    }
    room.phase = 'finished'
    room.last_game = {
      game_no: room.game_no,
      questions: room.deck.length,
      seconds: room.seconds,
      started_at: iso(room.started_at),
      finished_at: iso(now),
      standings: ranked.map((p) => ({ rank: p.rank, nickname: p.nickname, score: p.score, correct: p.correct })),
    }
    room.last_final = {
      type: 'final',
      game_no: room.game_no,
      standings: ranked.map((p) => ({ seat: p.seat, nickname: p.nickname, score: p.score, correct: p.correct, rank: p.rank })),
      saved,
    }
    const final = room.last_final
    this.broadcast(() => final)
    await this.save(room)
  }

  private async replay(room: Room, seat: number): Promise<void> {
    if (seat !== room.host) throw new Refusal('not_host')
    if (room.phase !== 'finished') throw new Refusal('bad_request')
    const connected = this.connectedSeats()
    room.players = room.players.filter((p) => connected.has(p.seat)).map((p) => ({ ...p, score: 0, correct: 0, correct_ms: 0 }))
    room.phase = 'lobby'
    room.deck = []
    room.cur = 0
    room.answers = {}
    room.last_reveal = null
    room.last_final = null
    this.broadcastLobby(room)
    await this.save(room)
  }

  // ------------------------------------------------------------------ clock
  /** When the alarm must fire next: question deadline, end of the pause, host hand-over, or idle cancel. */
  private nextStep(room: Room): number | null {
    const idle = this.connectedSeats().size === 0
    if (idle) room.idle_since ??= Date.now()
    else room.idle_since = null
    if (room.phase === 'question') return room.deadline
    if (room.phase === 'reveal') return room.next_at
    if (idle) return room.idle_since! + IDLE_MS
    if (room.phase === 'lobby' && room.host_left_at !== null) return room.host_left_at + HOST_GRACE_MS
    return null
  }

  override async alarm(): Promise<void> {
    const room = await this.load()
    if (!room) return
    if (room.phase === 'question') return this.closeQuestion(room)
    if (room.phase === 'reveal') return this.afterPause(room)
    if (this.connectedSeats().size === 0) return this.cancel(room)
    if (room.phase === 'lobby' && room.host_left_at !== null) {
      // the host stayed away: the earliest connected player takes over (AC-QUIZ-07)
      const connected = this.connectedSeats()
      room.players = room.players.filter((p) => p.seat !== room.host)
      room.host = room.players.find((p) => connected.has(p.seat))!.seat
      room.host_left_at = null
      this.broadcastLobby(room)
    }
    await this.save(room)
  }

  /** Nobody for IDLE_MS (AC-QUIZ-23): the room state goes; its code stays only while it has history. */
  private async cancel(room: Room): Promise<void> {
    const db = this.env.DB
    await db.batch([
      db
        .prepare('UPDATE quiz_room SET closed_at = ? WHERE code = ? AND EXISTS (SELECT 1 FROM quiz_game WHERE room_code = ?)')
        .bind(Date.now(), room.code, room.code),
      db.prepare('DELETE FROM quiz_room WHERE code = ? AND NOT EXISTS (SELECT 1 FROM quiz_game WHERE room_code = ?)').bind(room.code, room.code),
    ])
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'cancelled')
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.room = null
  }
}
