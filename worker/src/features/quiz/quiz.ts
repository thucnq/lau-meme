import { HttpError, ResponseError, json, problem, readJson } from '../../http'
import { playerId } from '../../player'
import { rateCounters, type Limit } from '../../ratelimit'
import { type ConsentRow, playConsentStatement, requirePlayConsent } from '../player/consent'
import { INVALID_NICKNAME } from '../player/me'
import { bannedTermsStatement, isBanned, roomNickname } from './nickname'

/** mQuiz over HTTP (ADR 0021): create a room, read it, open its WebSocket, my history. The room itself is QuizRoom. */
const ROOM_LIMIT: Limit = { scope: 'quiz_room', windowMs: 3_600_000, perPlayer: 5, perIp: 20 } // open question 92
const HISTORY_LIMIT: Limit = { scope: 'quiz_history', windowMs: 60_000, perPlayer: 60, perIp: 120 }
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE = /^[2-9A-HJKMNP-Z]{6}$/
const CODE_TRIES = 5
const HISTORY_PAGE = 20

const iso = (ms: number) => new Date(ms).toISOString()
const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[]
const bad = (detail: string): never => {
  throw new HttpError(400, 'Dữ liệu không hợp lệ', detail)
}

function roomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

function codeParam(raw: string | undefined): string {
  if (!raw || !CODE.test(raw)) throw new HttpError(400, 'Mã phòng không hợp lệ', '6 ký tự 2-9, A-Z (không I, L, O).')
  return raw
}

const roomUrl = (req: Request, env: Env, code: string) => `${new URL(req.url).origin}${env.BASE_PATH}/quiz/${code}`
const stub = (env: Env, code: string) => env.QUIZ_ROOM.get(env.QUIZ_ROOM.idFromName(code))

/** POST /api/quiz/rooms (AC-QUIZ-01/02): everything is checked before the rate counter, so bad input never costs a room. */
export async function createQuizRoom(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  if (!(req.headers.get('Content-Type') ?? '').startsWith('application/json')) {
    return problem(415, 'Cần application/json')
  }
  const b = await readJson(req)
  for (const k of Object.keys(b)) if (!['nickname', 'questions', 'seconds'].includes(k)) bad(`${k}: trường không được phép`)
  if (typeof b.nickname !== 'string' || b.nickname.length > 100) bad('nickname: chuỗi tối đa 100 ký tự')
  const questions = 'questions' in b ? b.questions : 10
  const seconds = 'seconds' in b ? b.seconds : 20
  if (![5, 10, 15].includes(questions as number)) bad('questions: 5, 10 hoặc 15')
  if (![10, 20, 30].includes(seconds as number)) bad('seconds: 10, 20 hoặc 30')
  const nickname = roomNickname(b.nickname as string)
  if (nickname === null) throw new HttpError(422, INVALID_NICKNAME)

  const db = env.DB
  const [consent, banned] = await db.batch([playConsentStatement(db, player), bannedTermsStatement(db)])
  requirePlayConsent(env, consent?.results[0] as ConsentRow | undefined)
  if (isBanned(nickname, banned)) throw new HttpError(422, INVALID_NICKNAME)
  const limit = await rateCounters(req, env, ROOM_LIMIT, player)
  const over = limit.verdict(await db.batch(limit.statements))
  if (over) throw new ResponseError(over)

  const now = Date.now()
  for (let i = 0; i < CODE_TRIES; i++) {
    const code = roomCode()
    const inserted = await db.prepare('INSERT INTO quiz_room (code, created_at) VALUES (?, ?) ON CONFLICT (code) DO NOTHING').bind(code, now).run()
    if ((inserted.meta.changes ?? 0) !== 1) continue
    const init = await stub(env, code).fetch('https://quiz-room/init', {
      method: 'POST',
      body: JSON.stringify({ code, uuid: player, nickname, questions, seconds }),
    })
    if (!init.ok) throw new Error(`room init ${init.status}`)
    return json({ code, url: roomUrl(req, env, code), state: 'lobby', questions, seconds }, { status: 201 })
  }
  return problem(503, 'Chưa tạo được phòng', 'Thử lại sau ít phút.')
}

type GameRow = { id: string; game_no: number; questions: number; seconds: number; player_count: number; started_at: number; finished_at: number }

/** GET /api/quiz/rooms/{code} (AC-QUIZ-03/20): live state from the room, finished games from D1; never a UUID. */
export async function getQuizRoom(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const code = codeParam(params[0])
  const db = env.DB
  const [room, games, standings] = await db.batch([
    db.prepare('SELECT closed_at FROM quiz_room WHERE code = ?').bind(code),
    db
      .prepare('SELECT id, game_no, questions, seconds, player_count, started_at, finished_at FROM quiz_game WHERE room_code = ? ORDER BY game_no DESC')
      .bind(code),
    db
      .prepare(
        `SELECT rank, nickname, score, correct FROM quiz_player
         WHERE game_id = (SELECT id FROM quiz_game WHERE room_code = ? ORDER BY game_no DESC LIMIT 1) ORDER BY rank, seat`,
      )
      .bind(code),
  ])
  const row = rows<{ closed_at: number | null }>(room)[0]
  if (!row) return problem(404, 'Không tìm thấy phòng')
  const [latest, ...earlier] = rows<GameRow>(games)
  const history = {
    latest: latest
      ? {
          game_no: latest.game_no,
          questions: latest.questions,
          seconds: latest.seconds,
          started_at: iso(latest.started_at),
          finished_at: iso(latest.finished_at),
          standings: rows<{ rank: number; nickname: string; score: number; correct: number }>(standings),
        }
      : null,
    earlier: earlier.map((g) => ({ game_no: g.game_no, finished_at: iso(g.finished_at), player_count: g.player_count })),
  }
  if (row.closed_at === null) {
    const live = await stub(env, code).fetch('https://quiz-room/view')
    if (live.ok) return json({ ...((await live.json()) as object), ...history })
  }
  if (!latest) return problem(404, 'Không tìm thấy phòng')
  return json({ code, state: 'finished', questions: latest.questions, seconds: latest.seconds, players: [], ...history })
}

/** GET /api/quiz/rooms/{code}/ws (AC-QUIZ-25): only a live room gets the upgrade; the room checks every message. */
export async function connectQuizRoom(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const code = codeParam(params[0])
  if ((req.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') return problem(426, 'Cần nâng cấp WebSocket')
  const live = await env.DB.prepare('SELECT 1 AS x FROM quiz_room WHERE code = ? AND closed_at IS NULL').bind(code).first()
  if (!live) return problem(404, 'Không tìm thấy phòng')
  return stub(env, code).fetch('https://quiz-room/ws', { headers: { Upgrade: 'websocket' } })
}

type HistoryRow = {
  code: string
  game_no: number
  finished_at: number
  player_count: number
  questions: number
  nickname: string
  score: number
  correct: number
  rank: number
}

/** The player's rows in finished multiplayer games, newest first (AC-QUIZ-19/22). */
export function historyStatement(db: D1Database, player: string, limit = -1, offset = 0): D1PreparedStatement {
  return db
    .prepare(
      `SELECT g.room_code AS code, g.game_no, g.finished_at, g.player_count, g.questions, p.nickname, p.score, p.correct, p.rank
       FROM quiz_player p JOIN quiz_game g ON g.id = p.game_id
       WHERE p.player_id = ? ORDER BY g.finished_at DESC, g.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(player, limit, offset)
}

export function historyItems(req: Request, env: Env, result: D1Result | undefined) {
  return rows<HistoryRow>(result).map((r) => ({ ...r, url: roomUrl(req, env, r.code), finished_at: iso(r.finished_at) }))
}

function pageParam(raw: string | null, name: string, max: number, fallback: number): number {
  if (raw === null) return fallback
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1 || n > max) bad(`${name}: số nguyên 1–${max}`)
  return n
}

/** GET /api/quiz/history - X-Player-Id only; at most 20 games per page. */
export async function listMyQuizHistory(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const params = new URL(req.url).searchParams
  const page = pageParam(params.get('page'), 'page', 1_000_000, 1)
  const size = pageParam(params.get('size'), 'size', HISTORY_PAGE, HISTORY_PAGE)
  const db = env.DB
  const limit = await rateCounters(req, env, HISTORY_LIMIT, player)
  const results = await db.batch([
    ...limit.statements,
    db.prepare('SELECT COUNT(*) AS n FROM quiz_player WHERE player_id = ?').bind(player),
    historyStatement(db, player, size, (page - 1) * size),
  ])
  const over = limit.verdict(results)
  if (over) return over
  const [total, items] = results.slice(limit.statements.length)
  return json({ page, size, total: rows<{ n: number }>(total)[0]?.n ?? 0, items: historyItems(req, env, items) })
}
