// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests for docs/acceptance/quiz.md, the mQuiz UI: AC-QUIZ-26 (entry and screens), and the UI side of
 * AC-QUIZ-01/03/04/06/07/10/11/13/14/15/17/19/28. The server is a fetch stub plus a fake global WebSocket; messages follow
 * docs/api/quiz-ws.md.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES (chosen here because the acceptance text does not fix the DOM)
 *   ./QuizPanel:  QuizPanel({ onOpenRoom?: (code: string) => void })
 *     - labelled controls "Số câu" (select 5/10/15, default 10) and "Số giây" (select 10/20/30, default 20), textbox "Nickname"
 *     - button "Tạo phòng": not consented -> shows an invitation mentioning "đồng ý" and sends nothing; consented ->
 *       POST /lau-meme/api/quiz/rooms (header X-Player-Id, body { nickname, questions, seconds }), then onOpenRoom(code)
 *     - section "Lịch sử mQuiz": GET /lau-meme/api/quiz/history, rows show nickname, score and rank and open the room
 *       (onOpenRoom(code)) when clicked; empty -> "Bạn chưa chơi ván mQuiz nào"
 *   ./QuizRoom:  QuizRoom({ code })
 *     - GET /lau-meme/api/quiz/rooms/<code>: 404 -> "Không tìm thấy phòng" + button "Tạo phòng mới"; playing and not in the room
 *       -> "Phòng đã bắt đầu"; finished -> the final board; lobby -> textbox "Nickname" + button "Vào phòng"
 *     - "Vào phòng" opens the WebSocket <api>/quiz/rooms/<code>/ws and sends { type: 'join', uuid, nickname } when it opens
 *     - lobby: nicknames listed, button "Bắt đầu" (host only, sends { type: 'start' }), button "Sao chép link" (copies
 *       https://<host>/lau-meme/quiz/<code>, then shows "Đã chép")
 *     - question: target name, 4 option buttons (by name), element role="timer" counting down from deadline - server_now,
 *       text "<q> / <total>", button "Chốt" disabled until exactly 2 options are picked, sends { type: 'answer', q, picks };
 *       after `answered` the options and "Chốt" are disabled
 *     - reveal: each option button gets data-state="correct" (the 2 right ones) or "wrong" (a picked wrong one)
 *     - board: list aria-label "Bảng điểm", one listitem per row (top 10 + my own row when outside), my row has aria-current="true"
 *     - final: list aria-label "Bảng xếp hạng" with 🥇🥈🥉 on ranks 1-3, my row aria-current="true", button "Chơi lại" (host
 *       only, sends { type: 'replay' }), button "Chia sẻ kết quả" (AC-QUIZ-28, optional)
 *     - solo: after `solo_pack` the client runs the clock and scoring itself (no `answer` sent), keeps the pack and progress
 *       under a localStorage key that starts with "laumeme:" and contains "quiz", and resumes at the next question after a reload
 *   ../privacy/consent: saveConsent(storage, version, 'granted' | 'declined');  ../privacy/player: getPlayerId(storage)
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold } from '../graph/crypto'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { QuizPanel } from './QuizPanel'
import { QuizRoom } from './QuizRoom'

// ---------------------------------------------------------------- fixtures
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-28T03:00:00.000Z')
const CODE = 'ABC234'
const SERVER_T0 = 1_900_000_000_000 // far from the browser clock: the countdown must use deadline - server_now

const OPT = {
  a: { id: eid('Mì Gói'), name: 'Mì Gói', emoji: '🍜', image_key: null },
  b: { id: eid('Trà Đá'), name: 'Trà Đá', emoji: '🧋', image_key: null },
  c: { id: eid('Cà Phê'), name: 'Cà Phê', emoji: '☕', image_key: null },
  d: { id: eid('Bánh Tráng'), name: 'Bánh Tráng', emoji: '🫓', image_key: null },
}
const OPTIONS = [OPT.a, OPT.b, OPT.c, OPT.d]
const TARGET = { name: 'Lẩu Thái', emoji: '🍲', image_key: null }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

let fetchMock: ReturnType<typeof vi.fn>
let roomReply: () => Response
let createReply: () => Response
let historyReply: () => Response

const roomView = (state: 'lobby' | 'playing' | 'finished', extra: Record<string, unknown> = {}) => ({
  code: CODE,
  state,
  questions: 5,
  seconds: 20,
  players: state === 'finished' ? [] : ['Bếp Chủ'],
  latest: null,
  earlier: [],
  ...extra,
})

function installNet(): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input).split('?')[0]!
    const method = methodOf(input, init)
    if (url.endsWith('/quiz/history')) return historyReply()
    if (url.endsWith('/quiz/rooms') && method === 'POST') return createReply()
    if (/\/quiz\/rooms\/[A-Z0-9]{6}$/.test(url) && method === 'GET') return roomReply()
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const calls = () =>
  fetchMock.mock.calls.map((c) => ({
    url: urlOf(c[0] as RequestInfo),
    method: methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined),
    player: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id'),
    body: (c[1] as RequestInit | undefined)?.body as string | undefined,
  }))
const roomPosts = () => calls().filter((c) => c.method === 'POST' && c.url.endsWith('/quiz/rooms'))

// ---------------------------------------------------------------- fake WebSocket
type Listener = (e: unknown) => void
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null
  private listeners = new Map<string, Listener[]>()
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
    void Promise.resolve().then(() => {
      this.readyState = 1
      this.emit('open', {})
    })
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn))
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', { code, reason: '', wasClean: true })
  }
  private emit(type: string, event: Record<string, unknown>): void {
    const own = (this as unknown as Record<string, Listener | null>)[`on${type}`]
    own?.(event)
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
  /** The server sends a message (inside act, so React flushes). */
  push(msg: Record<string, unknown>): void {
    act(() => this.emit('message', { data: JSON.stringify(msg) }))
  }
}
const sock = (): FakeWebSocket => {
  const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  if (!s) throw new Error('no WebSocket was opened')
  return s
}
const sentOf = (type: string) => sock().sent.filter((m) => m.type === type)

// ---------------------------------------------------------------- server messages
const lobbyMsg = (you: number, hostSeat: number, names: string[]) => ({
  type: 'lobby',
  code: CODE,
  questions: 5,
  seconds: 20,
  host_seat: hostSeat,
  you,
  players: names.map((nickname, i) => ({ seat: i + 1, nickname, connected: true })),
  last_game: null,
  server_now: SERVER_T0,
})
const questionMsg = (q: number, total = 5, seconds = 20) => ({
  type: 'question',
  q,
  total,
  target: TARGET,
  options: OPTIONS,
  server_now: SERVER_T0,
  deadline: SERVER_T0 + seconds * 1000,
})
const optionButton = (name: string): HTMLButtonElement => screen.getByRole('button', { name: new RegExp(name) }) as HTMLButtonElement
const chot = (): HTMLButtonElement => screen.getByRole('button', { name: 'Chốt' }) as HTMLButtonElement
const hasText = (t: string): boolean => Array.from(document.body.querySelectorAll('*')).some((e) => e.textContent?.trim() === t)
const seeText = (t: string) => waitFor(() => expect(hasText(t), `thiếu dòng "${t}"`).toBe(true))
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const flush = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}
const clipboardWrites: string[] = []

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  FakeWebSocket.instances = []
  clipboardWrites.length = 0
  roomReply = () => json(roomView('lobby'))
  createReply = () => json({ code: CODE, url: `https://dinoduct.fun/lau-meme/quiz/${CODE}`, state: 'lobby', questions: 10, seconds: 20 }, 201)
  historyReply = () => json({ page: 1, size: 20, total: 0, items: [] })
  installNet()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => void clipboardWrites.push(t)) },
  })
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

const consent = () => saveConsent(localStorage, 1, 'granted')

/** Opens the room page as a player: types a nickname, joins, and returns the socket after the first `lobby`. */
async function enterRoom(you: number, hostSeat: number, names: string[], nickname = 'Bếp Tôi'): Promise<FakeWebSocket> {
  consent()
  render(<QuizRoom code={CODE} />)
  const box = await screen.findByRole('textbox', { name: /nickname/i })
  fireEvent.change(box, { target: { value: nickname } })
  fireEvent.click(screen.getByRole('button', { name: 'Vào phòng' }))
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
  await flush()
  await flush()
  sock().push(lobbyMsg(you, hostSeat, names))
  return sock()
}

// ================================================================ AC-QUIZ-26 / AC-QUIZ-01: panel
describe('quiz ui: tab mQuiz', () => {
  it('AC-QUIZ-26: tab có nút "Tạo phòng", chọn số câu 5/10/15 (mặc định 10), số giây 10/20/30 (mặc định 20) và mục "Lịch sử mQuiz"', async () => {
    consent()
    render(<QuizPanel />)
    expect(screen.getByRole('button', { name: 'Tạo phòng' })).toBeTruthy()
    const questions = screen.getByLabelText(/Số câu/i) as HTMLSelectElement
    const seconds = screen.getByLabelText(/Số giây/i) as HTMLSelectElement
    expect(questions.value).toBe('10')
    expect(seconds.value).toBe('20')
    expect(within(questions).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['5', '10', '15'])
    expect(within(seconds).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['10', '20', '30'])
    expect(screen.getByText('Lịch sử mQuiz')).toBeTruthy()
  })

  it('AC-QUIZ-26: chưa đồng ý gửi dữ liệu thì bấm "Tạo phòng" hiện lời mời đồng ý và không gửi gì', async () => {
    saveConsent(localStorage, 1, 'declined')
    render(<QuizPanel onOpenRoom={vi.fn()} />)
    await flush()
    const before = calls().length
    fireEvent.change(screen.getByRole('textbox', { name: /nickname/i }), { target: { value: 'Bếp Trưởng' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng' }))
    await flush()
    expect(await screen.findByText(/đồng ý/i)).toBeTruthy()
    expect(roomPosts()).toEqual([])
    expect(calls().slice(before)).toEqual([])
    expect(calls().filter((c) => c.player !== null)).toEqual([])
  })

  it('AC-QUIZ-01: đã đồng ý, bấm "Tạo phòng" gửi POST /quiz/rooms với X-Player-Id và { nickname, questions, seconds } rồi mở phòng vừa tạo', async () => {
    consent()
    const onOpen = vi.fn()
    render(<QuizPanel onOpenRoom={onOpen} />)
    fireEvent.change(screen.getByRole('textbox', { name: /nickname/i }), { target: { value: 'Bếp Trưởng' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng' }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(CODE))
    const post = roomPosts()
    expect(post).toHaveLength(1)
    expect(post[0]!.url).toContain('/lau-meme/api/quiz/rooms')
    expect(post[0]!.player).toBe(getPlayerId(localStorage))
    expect(JSON.parse(post[0]!.body!)).toEqual({ nickname: 'Bếp Trưởng', questions: 10, seconds: 20 })

    fireEvent.change(screen.getByLabelText(/Số câu/i), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText(/Số giây/i), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng' }))
    await waitFor(() => expect(roomPosts()).toHaveLength(2))
    expect(JSON.parse(roomPosts()[1]!.body!)).toEqual({ nickname: 'Bếp Trưởng', questions: 5, seconds: 30 })
  })

  it('AC-QUIZ-02: máy chủ trả lỗi (422 nickname bị từ chối, 429 quá nhiều) thì hiện lỗi, không mở phòng', async () => {
    consent()
    const onOpen = vi.fn()
    createReply = () => json({ type: 'about:blank', title: 'Nickname không hợp lệ', status: 422 }, 422)
    render(<QuizPanel onOpenRoom={onOpen} />)
    fireEvent.change(screen.getByRole('textbox', { name: /nickname/i }), { target: { value: 'Bếp Trưởng' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    createReply = () => json({ type: 'about:blank', title: 'Quá nhanh', status: 429 }, 429)
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng' }))
    await waitFor(() => expect(roomPosts()).toHaveLength(2))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })
})

// ================================================================ AC-QUIZ-19: history list
describe('quiz ui: lịch sử mQuiz', () => {
  it('AC-QUIZ-19: ván của tôi hiện nickname, điểm, hạng; bấm một ván mở bảng chung cuộc của phòng đó', async () => {
    consent()
    historyReply = () =>
      json({
        page: 1,
        size: 20,
        total: 2,
        items: [
          { code: 'KKKKK4', game_no: 1, url: 'https://dinoduct.fun/lau-meme/quiz/KKKKK4', finished_at: '2026-10-28T02:00:00.000Z', player_count: 3, questions: 7, nickname: 'Bếp Của U', score: 2200, correct: 4, rank: 2 },
          { code: 'KKKKK3', game_no: 2, url: 'https://dinoduct.fun/lau-meme/quiz/KKKKK3', finished_at: '2026-10-27T02:00:00.000Z', player_count: 4, questions: 5, nickname: 'Bếp Của U', score: 1700, correct: 3, rank: 1 },
        ],
      })
    const onOpen = vi.fn()
    render(<QuizPanel onOpenRoom={onOpen} />)
    await screen.findByText(/2200/)
    expect(screen.getByText(/1700/)).toBeTruthy()
    const get = calls().filter((c) => c.method === 'GET' && c.url.includes('/lau-meme/api/quiz/history'))
    expect(get.length).toBeGreaterThan(0)
    expect(get[0]!.player).toBe(getPlayerId(localStorage))
    fireEvent.click(screen.getByText(/2200/))
    expect(onOpen).toHaveBeenCalledWith('KKKKK4')
  })

  it('AC-QUIZ-19: chưa chơi ván nào thì hiện "Bạn chưa chơi ván mQuiz nào"', async () => {
    consent()
    render(<QuizPanel />)
    expect(await screen.findByText('Bạn chưa chơi ván mQuiz nào')).toBeTruthy()
  })
})

// ================================================================ AC-QUIZ-03 / 06 / 20: opening a room link
describe('quiz ui: mở link phòng', () => {
  it('AC-QUIZ-03: mã không tồn tại (404) hiện "Không tìm thấy phòng" và nút "Tạo phòng mới"', async () => {
    roomReply = () => json({ type: 'about:blank', title: 'Không tìm thấy phòng', status: 404 }, 404)
    render(<QuizRoom code="ZZZZZZ" />)
    expect(await screen.findByText('Không tìm thấy phòng')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tạo phòng mới' })).toBeTruthy()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('AC-QUIZ-06: phòng đang chơi mà mình chưa từng vào hiện "Phòng đã bắt đầu"', async () => {
    consent()
    roomReply = () => json(roomView('playing'))
    render(<QuizRoom code={CODE} />)
    expect(await screen.findByText('Phòng đã bắt đầu')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Vào phòng' })).toBeNull()
  })

  it('AC-QUIZ-20: phòng đã kết thúc hiện bảng chung cuộc của ván mới nhất (nickname, điểm) mà không cần vào phòng', async () => {
    roomReply = () =>
      json(
        roomView('finished', {
          latest: {
            game_no: 2,
            questions: 5,
            seconds: 20,
            started_at: '2026-10-28T02:00:00.000Z',
            finished_at: '2026-10-28T02:05:00.000Z',
            standings: [
              { rank: 1, nickname: 'Bếp Hai', score: 4500, correct: 5 },
              { rank: 2, nickname: 'Bếp Một', score: 2500, correct: 3 },
            ],
          },
          earlier: [{ game_no: 1, finished_at: '2026-10-28T01:00:00.000Z', player_count: 2 }],
        }),
      )
    render(<QuizRoom code={CODE} />)
    expect(await screen.findByText(/Bếp Hai/)).toBeTruthy()
    expect(screen.getByText(/Bếp Một/)).toBeTruthy()
    expect(screen.getByText(/4500/)).toBeTruthy()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

// ================================================================ AC-QUIZ-04 / 07 / 26: lobby
describe('quiz ui: phòng chờ', () => {
  it('AC-QUIZ-04: nhập nickname, "Vào phòng" mở WebSocket của phòng và gửi join { uuid, nickname }; lobby hiện danh sách người chơi', async () => {
    const ws = await enterRoom(2, 1, ['Bếp Chủ', 'Bếp Tôi'])
    expect(ws.url).toContain(`/lau-meme/api/quiz/rooms/${CODE}/ws`)
    expect(ws.sent[0]).toEqual({ type: 'join', uuid: getPlayerId(localStorage), nickname: 'Bếp Tôi' })
    expect(await screen.findByText(/Bếp Chủ/)).toBeTruthy()
    expect(screen.getByText(/Bếp Tôi/)).toBeTruthy()
  })

  it('AC-QUIZ-04: máy chủ trả nickname_rejected thì hiện lỗi và vẫn cho nhập lại nickname khác', async () => {
    consent()
    render(<QuizRoom code={CODE} />)
    fireEvent.change(await screen.findByRole('textbox', { name: /nickname/i }), { target: { value: 'Từ Cấm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Vào phòng' }))
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
    await flush()
    sock().push({ type: 'error', code: 'nickname_rejected', message: 'Nickname không hợp lệ' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    const box = screen.getByRole('textbox', { name: /nickname/i })
    fireEvent.change(box, { target: { value: 'Tên Mới' } })
    fireEvent.click(screen.getByRole('button', { name: 'Vào phòng' }))
    await waitFor(() => expect(sentOf('join').length).toBeGreaterThanOrEqual(2))
    expect(sentOf('join')[sentOf('join').length - 1]).toMatchObject({ nickname: 'Tên Mới' })
  })

  it('AC-QUIZ-07: chỉ chủ phòng thấy nút "Bắt đầu" (bấm gửi start); người chơi thường không có nút', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Khách'])
    fireEvent.click(await screen.findByRole('button', { name: 'Bắt đầu' }))
    expect(ws.sent.filter((m) => m.type === 'start')).toEqual([{ type: 'start' }])
    cleanup()
    FakeWebSocket.instances = []
    await enterRoom(2, 1, ['Bếp Chủ', 'Bếp Tôi'])
    await screen.findByText(/Bếp Chủ/)
    expect(screen.queryByRole('button', { name: 'Bắt đầu' })).toBeNull()
  })

  it('AC-QUIZ-26: "Sao chép link" chép link tuyệt đối của phòng và báo "Đã chép"', async () => {
    await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Khách'])
    fireEvent.click(await screen.findByRole('button', { name: 'Sao chép link' }))
    await seeText('Đã chép')
    expect(clipboardWrites).toHaveLength(1)
    expect(clipboardWrites[0]).toMatch(new RegExp(`^https://[^/]+/lau-meme/quiz/${CODE}$`))
  })
})

// ================================================================ AC-QUIZ-10 / 11 / 13 / 14: question, answer, reveal
describe('quiz ui: câu hỏi, nộp bài, đáp án', () => {
  it('AC-QUIZ-10: màn câu hỏi hiện meme đề, 4 lựa chọn, số câu và đồng hồ đếm theo deadline - server_now (không theo giờ máy)', async () => {
    const ws = await enterRoom(2, 1, ['Bếp Chủ', 'Bếp Tôi'])
    ws.push({ type: 'started', game_no: 1, total: 5, seconds: 20, server_now: SERVER_T0 })
    ws.push(questionMsg(1))
    expect(await screen.findByText('Lẩu Thái')).toBeTruthy()
    for (const o of OPTIONS) expect(optionButton(o.name)).toBeTruthy()
    expect(document.body.textContent).toMatch(/1\s*\/\s*5/)
    const timer = screen.getByRole('timer')
    expect(timer.textContent).toMatch(/\b20\b/)
    await advance(5000)
    expect(screen.getByRole('timer').textContent).toMatch(/\b1[45]\b/)
  })

  it('AC-QUIZ-11: "Chốt" bị khóa tới khi chọn đủ 2 ô; bấm gửi answer { q, picks } (không có điểm hay thời gian); đã chốt thì không đổi được', async () => {
    const ws = await enterRoom(2, 1, ['Bếp Chủ', 'Bếp Tôi'])
    ws.push(questionMsg(1))
    await screen.findByText('Lẩu Thái')
    expect(chot().disabled).toBe(true)
    fireEvent.click(optionButton('Mì Gói'))
    expect(chot().disabled).toBe(true)
    fireEvent.click(optionButton('Cà Phê'))
    expect(chot().disabled).toBe(false)
    fireEvent.click(chot())
    const answers = sentOf('answer')
    expect(answers).toHaveLength(1)
    expect(Object.keys(answers[0]!).sort()).toEqual(['picks', 'q', 'type'])
    expect(answers[0]!.q).toBe(1)
    expect(new Set(answers[0]!.picks as string[])).toEqual(new Set([OPT.a.id, OPT.c.id]))

    ws.push({ type: 'answered', q: 1 })
    await waitFor(() => expect(chot().disabled).toBe(true))
    fireEvent.click(optionButton('Trà Đá'))
    fireEvent.click(chot())
    expect(sentOf('answer')).toHaveLength(1)
  })

  it('AC-QUIZ-13: reveal tô đúng 2 ô đúng (correct) và ô sai người chơi đã chọn (wrong)', async () => {
    const ws = await enterRoom(2, 1, ['Bếp Chủ', 'Bếp Tôi'])
    ws.push(questionMsg(1))
    await screen.findByText('Lẩu Thái')
    fireEvent.click(optionButton('Mì Gói'))
    fireEvent.click(optionButton('Cà Phê'))
    fireEvent.click(chot())
    ws.push({ type: 'answered', q: 1 })
    ws.push({
      type: 'reveal',
      q: 1,
      correct: [OPT.a.id, OPT.b.id],
      results: [
        { seat: 1, picks: [OPT.a.id, OPT.b.id], ok: true, points: 900 },
        { seat: 2, picks: [OPT.a.id, OPT.c.id], ok: false, points: 0 },
      ],
      board: {
        top: [
          { seat: 1, nickname: 'Bếp Chủ', score: 900, rank: 1 },
          { seat: 2, nickname: 'Bếp Tôi', score: 0, rank: 2 },
        ],
        me: { seat: 2, score: 0, rank: 2 },
      },
      next_at: SERVER_T0 + 4000,
    })
    await waitFor(() => expect(optionButton('Mì Gói').dataset.state).toBe('correct'))
    expect(optionButton('Trà Đá').dataset.state).toBe('correct')
    expect(optionButton('Cà Phê').dataset.state).toBe('wrong')
    expect(optionButton('Bánh Tráng').dataset.state ?? '').not.toMatch(/correct|wrong/)
  })

  it('AC-QUIZ-14: bảng điểm hiện top 10 và dòng của tôi (tô nổi, kèm hạng) khi tôi ngoài top 10', async () => {
    const ws = await enterRoom(12, 1, ['Bếp Chủ', 'Bếp Tôi'])
    ws.push(questionMsg(1))
    await screen.findByText('Lẩu Thái')
    const top = Array.from({ length: 10 }, (_, i) => ({ seat: i + 1, nickname: `Người ${i + 1}`, score: 1000 - i * 50, rank: i + 1 }))
    ws.push({
      type: 'reveal',
      q: 1,
      correct: [OPT.a.id, OPT.b.id],
      results: [],
      board: { top, me: { seat: 12, score: 0, rank: 12 } },
      next_at: SERVER_T0 + 4000,
    })
    const board = await screen.findByRole('list', { name: 'Bảng điểm' })
    const rows = within(board).getAllByRole('listitem')
    expect(rows).toHaveLength(11)
    const mine = rows[rows.length - 1]!
    expect(mine.getAttribute('aria-current')).toBe('true')
    expect(mine.textContent).toMatch(/12/)
    expect(rows.filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(1)
  })
})

// ================================================================ AC-QUIZ-15 / 07 / 28: final board
describe('quiz ui: bảng xếp hạng chung cuộc', () => {
  const finalMsg = {
    type: 'final',
    game_no: 1,
    saved: true,
    standings: [
      { seat: 1, nickname: 'Bếp Chủ', score: 4500, correct: 5, rank: 1 },
      { seat: 2, nickname: 'Bếp Tôi', score: 3000, correct: 4, rank: 2 },
      { seat: 3, nickname: 'Bếp Ba', score: 2000, correct: 3, rank: 3 },
      { seat: 4, nickname: 'Bếp Tư', score: 100, correct: 1, rank: 4 },
    ],
  }

  it('AC-QUIZ-15: final hiện 🥇🥈🥉 cho 3 hạng đầu, tô dòng của mình; người chơi thường không có nút "Chơi lại"', async () => {
    const ws = await enterRoom(2, 1, ['Bếp Chủ', 'Bếp Tôi', 'Bếp Ba', 'Bếp Tư'])
    ws.push(finalMsg)
    const board = await screen.findByRole('list', { name: 'Bảng xếp hạng' })
    const rows = within(board).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(rows[0]!.textContent).toContain('🥇')
    expect(rows[1]!.textContent).toContain('🥈')
    expect(rows[2]!.textContent).toContain('🥉')
    expect(rows[3]!.textContent).not.toMatch(/[🥇🥈🥉]/u)
    expect(rows.filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.textContent)).toEqual([expect.stringContaining('Bếp Tôi')])
    expect(screen.queryByRole('button', { name: 'Chơi lại' })).toBeNull()
  })

  it('AC-QUIZ-07: chủ phòng thấy nút "Chơi lại" ở bảng cuối và bấm gửi replay', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    ws.push({ ...finalMsg, standings: finalMsg.standings.slice(0, 2).map((s, i) => ({ ...s, nickname: i === 0 ? 'Bếp Tôi' : 'Bếp Hai' })) })
    fireEvent.click(await screen.findByRole('button', { name: 'Chơi lại' }))
    expect(sentOf('replay')).toEqual([{ type: 'replay' }])
  })

  it('AC-QUIZ-28: "Chia sẻ kết quả" chép thẻ chữ có hạng, điểm, số câu đúng / tổng và link phòng, không có đề hay đáp án', async () => {
    const ws = await enterRoom(2, 1, ['Bếp Chủ', 'Bếp Tôi', 'Bếp Ba', 'Bếp Tư'])
    ws.push({ type: 'started', game_no: 1, total: 5, seconds: 20, server_now: SERVER_T0 })
    ws.push(finalMsg)
    fireEvent.click(await screen.findByRole('button', { name: 'Chia sẻ kết quả' }))
    await waitFor(() => expect(clipboardWrites).toHaveLength(1))
    const card = clipboardWrites[0]!
    expect(card).toContain('3000')
    expect(card).toMatch(/4\s*\/\s*5/)
    expect(card).toMatch(/\b2\b/) // rank 2 (🥈 or "#2")
    expect(card).toContain(`/lau-meme/quiz/${CODE}`)
    expect(card).not.toContain('Lẩu Thái')
  })
})

// ================================================================ AC-QUIZ-17: solo, offline
describe('quiz ui: chơi một mình', () => {
  const SALT = `${CODE}:1`
  const pairs: Array<[string, string]> = [
    [OPT.a.id, OPT.b.id],
    [OPT.b.id, OPT.c.id],
    [OPT.c.id, OPT.d.id],
    [OPT.a.id, OPT.d.id],
    [OPT.a.id, OPT.c.id],
  ]
  const hash = (q: number, a: string, b: string) => {
    const [lo, hi] = [a, b].sort()
    return sha(`lmq1|${SALT}|${q}|${lo}|${hi}`)
  }
  const soloPack = () => ({
    type: 'solo_pack',
    game_no: 1,
    total: 5,
    seconds: 20,
    salt: SALT,
    items: pairs.map(([a, b], i) => ({
      target: { name: `Meme ${i + 1}`, emoji: '🍲', image_key: null },
      options: OPTIONS,
      answer_hash: hash(i + 1, a, b),
    })),
  })
  const pick = (a: string, b: string) => {
    const nameOf = (id: string) => OPTIONS.find((o) => o.id === id)!.name
    fireEvent.click(optionButton(nameOf(a)))
    fireEvent.click(optionButton(nameOf(b)))
    fireEvent.click(chot())
  }

  it('AC-QUIZ-17: nhận solo_pack thì client tự chấm và tự đếm giờ (không gửi answer), lộ đáp án tại chỗ, lưu gói đề và tiến độ trong khóa "laumeme:", tải lại thì chơi tiếp từ câu kế tiếp', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi'])
    fireEvent.click(await screen.findByRole('button', { name: 'Bắt đầu' }))
    ws.push(soloPack())
    expect(await screen.findByText('Meme 1')).toBeTruthy()

    pick(...pairs[0]!) // right answer, answered immediately
    expect(sentOf('answer')).toEqual([]) // nothing about answers or scores goes to the server
    await waitFor(() => expect(optionButton('Mì Gói').dataset.state).toBe('correct'))
    expect(optionButton('Trà Đá').dataset.state).toBe('correct')

    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
    expect(keys.some((k) => k.startsWith('laumeme:') && k.includes('quiz'))).toBe(true)
    expect(keys.filter((k) => !k.startsWith('laumeme:') && k.includes('quiz'))).toEqual([])

    await advance(6000) // the local pause between questions
    expect(await screen.findByText('Meme 2')).toBeTruthy()

    // reload: the room is locked on the server, the local pack and progress resume at question 2
    cleanup()
    FakeWebSocket.instances = []
    roomReply = () => json(roomView('playing'))
    render(<QuizRoom code={CODE} />)
    expect(await screen.findByText('Meme 2')).toBeTruthy()
    expect(screen.queryByText('Phòng đã bắt đầu')).toBeNull()
    expect(document.body.textContent).toMatch(/2\s*\/\s*5/)
  })
})
