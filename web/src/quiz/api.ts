import { SITE_URL, withBase } from '../base'
import { getMyData } from '../privacy/client'
import { getPlayerId } from '../privacy/player'
import { storageKey } from '../storage'

/** mQuiz HTTP calls (contract 0.10.0, ADR 0021). The WebSocket messages are in docs/api/quiz-ws.md. */
export type Item = { id: string; name: string; emoji: string; image_key: string | null }
export type Standing = { rank: number; nickname: string; score: number; correct: number }
export type GameSummary = { game_no: number; questions: number; seconds: number; started_at: string; finished_at: string; standings: Standing[] }
export type RoomView = {
  code: string
  state: 'lobby' | 'playing' | 'finished'
  questions: number
  seconds: number
  players: string[]
  latest: GameSummary | null
  earlier: { game_no: number; finished_at: string; player_count: number }[]
}
export type HistoryItem = {
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

/** A problem+json reply: its title is shown as is (titles are Vietnamese). */
export class QuizError extends Error {
  constructor(
    readonly status: number,
    title: string,
  ) {
    super(title)
  }
}

async function reply<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  let title = 'Có lỗi, thử lại sau'
  try {
    title = ((await res.json()) as { title?: string }).title ?? title
  } catch {
    // not JSON
  }
  throw new QuizError(res.status, title)
}

export async function createRoom(storage: Storage | null, body: { nickname: string; questions: number; seconds: number }) {
  const res = await fetch(withBase('api/quiz/rooms'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Player-Id': getPlayerId(storage) },
    body: JSON.stringify(body),
  })
  return reply<{ code: string; url: string }>(res)
}

export async function getRoom(code: string): Promise<RoomView | null> {
  const res = await fetch(withBase(`api/quiz/rooms/${code}`))
  if (res.status === 404) return null
  return reply<RoomView>(res)
}

export async function getHistory(storage: Storage | null) {
  const res = await fetch(withBase('api/quiz/history'), { headers: { 'X-Player-Id': getPlayerId(storage) } })
  return reply<{ items: HistoryItem[] }>(res)
}

/** ws(s)://<host>/lau-meme/api/quiz/rooms/<code>/ws on the page's own origin. */
export function socketUrl(code: string): string {
  const url = new URL(withBase(`api/quiz/rooms/${code}/ws`), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

/** The room's public link (AC-QUIZ-01, AC-SUBPATH-10). */
export const roomLink = (code: string): string => `${SITE_URL}quiz/${code}`

/** The nickname saved at Bàn lẩu (AC-QUIZ-04), or null; a failed read only leaves the field empty. */
export async function savedNickname(storage: Storage | null): Promise<string | null> {
  try {
    return (await getMyData(storage)).nickname ?? null
  } catch {
    return null
  }
}

/** The nickname this device joined a room with: after a reload during a game it joins again at once. */
export const joinedKey = (code: string) => storageKey(`quiz:joined:${code}`)
/** Set once by "Tạo phòng": the host enters the lobby with that nickname, not through the guests' join screen. */
export const hostKey = (code: string) => storageKey(`quiz:host:${code}`)

export function rememberHost(storage: Storage | null, code: string, nickname: string): void {
  try {
    storage?.setItem(hostKey(code), JSON.stringify(nickname))
  } catch {
    // storage blocked: the host then types the nickname again on the join screen
  }
}
