// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests for docs/acceptance/quiz.md, section "Giao diện kiểu game quiz (thêm 2026-10-30)":
 * AC-QUIZ-29..36, the UI part of AC-QUIZ-37 (the server part is in worker/test/quiz.test.ts), AC-QUIZ-38 and AC-QUIZ-39.
 * Same harness as quiz.ui.test.tsx: fetch stub + fake global WebSocket, server messages as in docs/api/quiz-ws.md (0.11.0).
 *
 * PUBLIC SURFACE THIS FILE REQUIRES ON TOP OF quiz.ui.test.tsx (the acceptance text does not fix the DOM; chosen here)
 *   - option buttons: accessible name contains the symbol and the option name, symbols in order ▲ ◆ ● ■; aria-pressed="false"
 *     before picking and "true" after; a picked button shows ✓ in its text; the 4 buttons have 4 different class lists
 *   - countdown: element role="progressbar" with a numeric aria-valuenow (seconds left, decreasing); the seconds are written
 *     in text as "<n> s" or "<n> giây"; data-urgent="true" on the progressbar once <= 5 s are left; after `answered` the text
 *     "Đã chốt, chờ mọi người" is visible and the bar keeps running
 *   - reveal screen: a role="progressbar" (the 4 s pause) with the text "Câu kế tiếp" (last question: "Kết quả chung cuộc")
 *   - question title "Câu <q> / <total>" carries data-emphasis="true" for at most 600 ms after a new question arrives
 *   - result strip: role="status" with "Chuẩn! +<points>", "Trượt rồi" or "Hết giờ", and "🔥 <n> câu liên tiếp" when n >= 2
 *   - board rows: "▲ <n>" / "▼ <n>" for a rank change, nothing when unchanged; scores count up (not instantly) unless reduced motion
 *   - podium: element aria-label="Bục nhận giải" containing one listitem per medal in DOM order rank 2, rank 1, rank 3
 *     (each with 🥈/🥇/🥉, nickname, score); confetti is a <canvas> that disappears within 3 s
 *   - lobby: text "<n> người đã vào"; each player card is an <li> with an emoji and the nickname; a card that just appeared has
 *     data-entering="true"
 *   - progress: text "<answered>/<total> người đã chốt"
 *   - QR: element role="img" with aria-label "Mã QR vào phòng <code>" containing an <svg>; built from the `qrcode-generator`
 *     module (mocked below: it records what is encoded) and never from a network call
 *   - sound: a button whose name contains 🔊 (on) or 🔇 (off), on the lobby and the question screen, hidden without Web Audio;
 *     choice persisted in localStorage under a key starting with "laumeme:"; sound is Web Audio only (oscillator.start)
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold } from '../graph/crypto'
import { saveConsent } from '../privacy/consent'
import { QuizRoom } from './QuizRoom'

// ---------------------------------------------------------------- QR module mock (records what is encoded)
const qr = vi.hoisted(() => ({ encoded: [] as string[] }))
vi.mock('qrcode-generator', () => {
  const factory = () => {
    let data = ''
    return {
      addData: (d: string) => {
        data = d
        qr.encoded.push(d)
      },
      make: () => undefined,
      getModuleCount: () => 21,
      isDark: (r: number, c: number) => (r + c + data.length) % 2 === 0,
      createSvgTag: () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21"/></svg>',
      createDataURL: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      createImgTag: () => '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
      createASCII: () => '',
    }
  }
  return { default: factory }
})

// ---------------------------------------------------------------- fixtures (same ids as quiz.ui.test.tsx)
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-30T03:00:00.000Z')
const CODE = 'ABC234'
const SERVER_T0 = 1_900_000_000_000

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

let fetchMock: ReturnType<typeof vi.fn>
function installNet(): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input).split('?')[0]!
    const method = (init?.method ?? 'GET').toUpperCase()
    if (/\/quiz\/rooms\/[A-Z0-9]{6}$/.test(url) && method === 'GET') {
      return json({ code: CODE, state: 'lobby', questions: 5, seconds: 20, players: ['Bếp Chủ'], latest: null, earlier: [] })
    }
    if (url.endsWith('/api/me')) return json({ nickname: null })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

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
  push(msg: Record<string, unknown>): void {
    act(() => this.emit('message', { data: JSON.stringify(msg) }))
  }
}
const sock = (): FakeWebSocket => {
  const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  if (!s) throw new Error('no WebSocket was opened')
  return s
}

// ---------------------------------------------------------------- fake Web Audio, vibrate, matchMedia, canvas
class FakeAudioContext {
  static created = 0
  static starts = 0
  static frequencies: number[] = []
  state = 'running'
  currentTime = 0
  destination = {}
  constructor() {
    FakeAudioContext.created++
  }
  private param(): Record<string, unknown> {
    const p: Record<string, unknown> = { value: 0 }
    for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues']) {
      p[m] = (v?: number) => {
        if (m === 'setValueAtTime' && typeof v === 'number') FakeAudioContext.frequencies.push(v)
        return p
      }
    }
    return p
  }
  createOscillator() {
    const frequency = this.param()
    return {
      type: 'sine',
      frequency,
      connect: () => undefined,
      disconnect: () => undefined,
      start: () => void FakeAudioContext.starts++,
      stop: () => undefined,
      addEventListener: () => undefined,
      onended: null,
    }
  }
  createGain() {
    return { gain: this.param(), connect: () => undefined, disconnect: () => undefined }
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}
const resetAudio = () => {
  FakeAudioContext.created = 0
  FakeAudioContext.starts = 0
  FakeAudioContext.frequencies = []
}
const withAudio = () => vi.stubGlobal('AudioContext', FakeAudioContext)
const audioNotConstructed = vi.fn()

let vibrate: ReturnType<typeof vi.fn>
function setReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && /prefers-reduced-motion:\s*reduce/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
}

// ---------------------------------------------------------------- server messages and helpers
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
type Row = { seat: number; nickname: string; score: number; rank: number }
const revealMsg = (
  q: number,
  results: Array<{ seat: number; picks: [string, string] | null; ok: boolean; points: number }>,
  top: Row[],
  me: { seat: number; score: number; rank: number },
) => ({ type: 'reveal', q, correct: [OPT.a.id, OPT.b.id], results, board: { top, me }, next_at: SERVER_T0 + 4000 })
const finalMsg = (names: string[]) => ({
  type: 'final',
  game_no: 1,
  saved: true,
  standings: names.map((nickname, i) => ({ seat: i + 1, nickname, score: 5000 - i * 700, correct: 5 - i, rank: i + 1 })),
})

const optionButtons = (): HTMLButtonElement[] =>
  OPTIONS.map((o) => screen.getByRole('button', { name: new RegExp(o.name) }) as HTMLButtonElement)
const optionButton = (name: string): HTMLButtonElement => screen.getByRole('button', { name: new RegExp(name) }) as HTMLButtonElement
const chot = (): HTMLButtonElement => screen.getByRole('button', { name: 'Chốt' }) as HTMLButtonElement
const bodyText = (): string => document.body.textContent ?? ''
const statusText = (): string =>
  screen
    .queryAllByRole('status')
    .map((e) => e.textContent ?? '')
    .join(' | ')
const soundButton = (): HTMLButtonElement | null => screen.queryByRole('button', { name: /🔊|🔇/ }) as HTMLButtonElement | null
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
const consent = () => saveConsent(localStorage, 1, 'granted')

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

/** In the room, a question is open and the player is seat `you`. */
async function openQuestion(q = 1, total = 5, names = ['Bếp Tôi', 'Bếp Hai']) {
  const ws = await enterRoom(1, 1, names)
  ws.push({ type: 'started', game_no: 1, total, seconds: 20, server_now: SERVER_T0 })
  ws.push(questionMsg(q, total))
  await screen.findByText('Lẩu Thái')
  return ws
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  FakeWebSocket.instances = []
  qr.encoded.length = 0
  resetAudio()
  audioNotConstructed.mockReset()
  installNet()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('Audio', class {
    constructor() {
      audioNotConstructed()
    }
  })
  setReducedMotion(false)
  vibrate = vi.fn(() => true)
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } })
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
  const noop = new Proxy({}, { get: () => () => undefined, set: () => true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => noop) as unknown as HTMLCanvasElement['getContext'])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined })
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ AC-QUIZ-29
describe('quiz game ui: ô lựa chọn', () => {
  it('AC-QUIZ-29: 4 ô theo thứ tự có ký hiệu ▲ ◆ ● ■ trong tên truy cập của nút và 4 lớp hiển thị khác nhau', async () => {
    await openQuestion()
    const buttons = optionButtons()
    const symbols = ['▲', '◆', '●', '■']
    buttons.forEach((b, i) => {
      expect(b.getAttribute('aria-label') ?? b.textContent ?? '', `ô ${i + 1}`).toContain(symbols[i]!)
      expect(screen.getByRole('button', { name: new RegExp(`${symbols[i]!}.*${OPTIONS[i]!.name}|${OPTIONS[i]!.name}.*${symbols[i]!}`) })).toBe(b)
    })
    expect(new Set(buttons.map((b) => b.className)).size, 'mỗi ô một màu (lớp) riêng').toBe(4)
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false'])
  })

  it('AC-QUIZ-29: chọn ô có dấu ✓ và aria-pressed="true"; bấm lại thì bỏ chọn; luật 2 ô rồi "Chốt" như AC-QUIZ-11', async () => {
    const ws = await openQuestion()
    expect(chot().disabled).toBe(true)
    fireEvent.click(optionButton('Mì Gói'))
    expect(optionButton('Mì Gói').getAttribute('aria-pressed')).toBe('true')
    expect(optionButton('Mì Gói').textContent).toContain('✓')
    expect(optionButton('Trà Đá').textContent).not.toContain('✓')
    expect(chot().disabled).toBe(true)

    fireEvent.click(optionButton('Cà Phê'))
    expect(optionButton('Cà Phê').getAttribute('aria-pressed')).toBe('true')
    expect(chot().disabled).toBe(false)

    fireEvent.click(optionButton('Mì Gói')) // click again: unpick
    expect(optionButton('Mì Gói').getAttribute('aria-pressed')).toBe('false')
    expect(optionButton('Mì Gói').textContent).not.toContain('✓')
    expect(chot().disabled).toBe(true)

    fireEvent.click(optionButton('Mì Gói'))
    fireEvent.click(chot())
    const answers = ws.sent.filter((m) => m.type === 'answer')
    expect(answers).toHaveLength(1)
    expect(new Set(answers[0]!.picks as string[])).toEqual(new Set([OPT.a.id, OPT.c.id]))
  })
})

// ================================================================ AC-QUIZ-30
describe('quiz game ui: đồng hồ dạng thanh', () => {
  it('AC-QUIZ-30: đồng hồ là thanh role="progressbar" ngắn dần theo thời gian còn lại, có số giây còn lại bằng chữ', async () => {
    await openQuestion()
    const bar = screen.getByRole('progressbar')
    const start = Number(bar.getAttribute('aria-valuenow'))
    expect(start).toBeGreaterThan(0)
    expect(bodyText()).toMatch(/\b20\s*(s|giây)/)
    await advance(10_000)
    const mid = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))
    expect(mid).toBeLessThan(start)
    expect(mid).toBeGreaterThan(0)
    expect(bodyText()).toMatch(/\b(9|10)\s*(s|giây)/)
    await advance(10_000)
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeLessThanOrEqual(0)
  })

  it('AC-QUIZ-30: còn 5 s thì thanh chuyển sang trạng thái gấp (data-urgent) và máy rung đúng 1 lần', async () => {
    await openQuestion()
    await advance(13_000) // about 7 s left
    expect(screen.getByRole('progressbar').getAttribute('data-urgent')).not.toBe('true')
    expect(vibrate).not.toHaveBeenCalled()
    await advance(2_500) // about 4.5 s left
    expect(screen.getByRole('progressbar').getAttribute('data-urgent')).toBe('true')
    expect(vibrate).toHaveBeenCalledTimes(1)
    await advance(4_000)
    expect(vibrate).toHaveBeenCalledTimes(1)
  })

  it('AC-QUIZ-30: người chơi đã tắt âm thanh và rung (nút 🔊 -> 🔇) thì còn 5 s không rung', async () => {
    withAudio()
    await openQuestion()
    fireEvent.click(soundButton()!)
    expect(soundButton()!.textContent ?? soundButton()!.getAttribute('aria-label')).toMatch(/🔇/)
    await advance(16_000)
    expect(screen.getByRole('progressbar').getAttribute('data-urgent')).toBe('true') // the visual change stays
    expect(vibrate).not.toHaveBeenCalled()
  })

  it('AC-QUIZ-30: đã chốt thì thanh vẫn chạy nhưng hiện "Đã chốt, chờ mọi người"', async () => {
    const ws = await openQuestion()
    fireEvent.click(optionButton('Mì Gói'))
    fireEvent.click(optionButton('Cà Phê'))
    fireEvent.click(chot())
    expect(bodyText()).not.toContain('Đã chốt, chờ mọi người')
    ws.push({ type: 'answered', q: 1 })
    await waitFor(() => expect(bodyText()).toContain('Đã chốt, chờ mọi người'))
    const before = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))
    await advance(5_000)
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeLessThan(before)
  })
})

// ================================================================ AC-QUIZ-31
describe('quiz game ui: chuyển cảnh', () => {
  it('AC-QUIZ-31: màn lộ đáp án có thanh đếm ngược 4 s ghi "Câu kế tiếp"', async () => {
    const ws = await openQuestion(2, 5)
    ws.push(revealMsg(2, [], [{ seat: 1, nickname: 'Bếp Tôi', score: 0, rank: 1 }], { seat: 1, score: 0, rank: 1 }))
    await waitFor(() => expect(optionButton('Mì Gói').dataset.state).toBe('correct'))
    expect(screen.getByRole('progressbar')).toBeTruthy()
    expect(bodyText()).toContain('Câu kế tiếp')
    expect(bodyText()).not.toContain('Kết quả chung cuộc')
  })

  it('AC-QUIZ-31: câu cuối thì thanh đếm ngược ghi "Kết quả chung cuộc"', async () => {
    const ws = await openQuestion(5, 5)
    ws.push(revealMsg(5, [], [{ seat: 1, nickname: 'Bếp Tôi', score: 0, rank: 1 }], { seat: 1, score: 0, rank: 1 }))
    await waitFor(() => expect(optionButton('Mì Gói').dataset.state).toBe('correct'))
    expect(bodyText()).toContain('Kết quả chung cuộc')
    expect(bodyText()).not.toContain('Câu kế tiếp')
  })

  it('AC-QUIZ-31: câu mới tới thì tiêu đề "Câu i + 1 / n" nổi bật tối đa 600 ms rồi thu về, không chặn bấm ô', async () => {
    const ws = await openQuestion(1, 5)
    ws.push(revealMsg(1, [], [{ seat: 1, nickname: 'Bếp Tôi', score: 0, rank: 1 }], { seat: 1, score: 0, rank: 1 }))
    await waitFor(() => expect(optionButton('Mì Gói').dataset.state).toBe('correct'))
    ws.push(questionMsg(2, 5))
    const title = await screen.findByText(/Câu\s*2\s*\/\s*5/)
    expect(title.getAttribute('data-emphasis')).toBe('true')
    // the effect does not block clicks
    fireEvent.click(optionButton('Mì Gói'))
    fireEvent.click(optionButton('Cà Phê'))
    expect(chot().disabled).toBe(false)
    await advance(700)
    expect(screen.getByText(/Câu\s*2\s*\/\s*5/).getAttribute('data-emphasis')).not.toBe('true')
    // the deadline still comes from the server
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(17)
  })
})

// ================================================================ AC-QUIZ-32
describe('quiz game ui: phản hồi đúng/sai và chuỗi đúng', () => {
  const meScore = (score: number) => ({ top: [{ seat: 1, nickname: 'Bếp Tôi', score, rank: 1 }], me: { seat: 1, score, rank: 1 } })
  const reveal = (ws: FakeWebSocket, q: number, r: { picks: [string, string] | null; ok: boolean; points: number }, score: number) => {
    ws.push(questionMsg(q, 5))
    const b = meScore(score)
    ws.push(revealMsg(q, [{ seat: 1, ...r }], b.top, b.me))
  }

  it('AC-QUIZ-32: đúng thì dải role="status" "Chuẩn! +750"; hai câu đúng liên tiếp thì "Chuẩn! +900" kèm "🔥 2 câu liên tiếp"; đúng một nửa "Trượt rồi" và chuỗi về 0; không nộp "Hết giờ"', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    ws.push({ type: 'started', game_no: 1, total: 5, seconds: 20, server_now: SERVER_T0 })

    reveal(ws, 1, { picks: [OPT.a.id, OPT.b.id], ok: true, points: 750 }, 750)
    await waitFor(() => expect(statusText()).toContain('Chuẩn! +750'))
    expect(statusText()).not.toContain('🔥')

    reveal(ws, 2, { picks: [OPT.a.id, OPT.b.id], ok: true, points: 900 }, 1650)
    await waitFor(() => expect(statusText()).toContain('Chuẩn! +900'))
    expect(statusText()).toContain('🔥 2 câu liên tiếp')

    reveal(ws, 3, { picks: [OPT.a.id, OPT.c.id], ok: false, points: 0 }, 1650)
    await waitFor(() => expect(statusText()).toContain('Trượt rồi'))
    expect(statusText()).not.toContain('Chuẩn')
    expect(statusText()).not.toContain('🔥')

    reveal(ws, 4, { picks: null, ok: false, points: 0 }, 1650)
    await waitFor(() => expect(statusText()).toContain('Hết giờ'))
    expect(statusText()).not.toContain('🔥')
  })

  it('AC-QUIZ-32: chuỗi đúng bị ngắt bởi câu trượt rồi tính lại từ 1 (câu đúng kế tiếp không có "🔥")', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    reveal(ws, 1, { picks: [OPT.a.id, OPT.b.id], ok: true, points: 800 }, 800)
    reveal(ws, 2, { picks: [OPT.a.id, OPT.c.id], ok: false, points: 0 }, 800)
    await waitFor(() => expect(statusText()).toContain('Trượt rồi'))
    reveal(ws, 3, { picks: [OPT.a.id, OPT.b.id], ok: true, points: 700 }, 1500)
    await waitFor(() => expect(statusText()).toContain('Chuẩn! +700'))
    expect(statusText()).not.toContain('🔥')
  })

  it('AC-QUIZ-32: vào lại sau khi rớt mạng thì chuỗi tính lại từ 0 (câu đúng đầu tiên sau khi vào lại không có "🔥")', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    reveal(ws, 1, { picks: [OPT.a.id, OPT.b.id], ok: true, points: 800 }, 800)
    reveal(ws, 2, { picks: [OPT.a.id, OPT.b.id], ok: true, points: 800 }, 1600)
    await waitFor(() => expect(statusText()).toContain('🔥 2 câu liên tiếp'))

    cleanup()
    FakeWebSocket.instances = []
    const ws2 = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    reveal(ws2, 3, { picks: [OPT.a.id, OPT.b.id], ok: true, points: 800 }, 2400)
    await waitFor(() => expect(statusText()).toContain('Chuẩn! +800'))
    expect(statusText()).not.toContain('🔥')
  })
})

// ================================================================ AC-QUIZ-33
describe('quiz game ui: bảng điểm động', () => {
  const after1: Row[] = [
    { seat: 1, nickname: 'Bếp Tôi', score: 1000, rank: 1 },
    { seat: 2, nickname: 'Bếp Y', score: 900, rank: 2 },
    { seat: 3, nickname: 'Bếp Z', score: 800, rank: 3 },
    { seat: 4, nickname: 'Bếp X', score: 700, rank: 4 },
  ]
  const after2: Row[] = [
    { seat: 1, nickname: 'Bếp Tôi', score: 2000, rank: 1 },
    { seat: 4, nickname: 'Bếp X', score: 1900, rank: 2 },
    { seat: 2, nickname: 'Bếp Y', score: 1700, rank: 3 },
    { seat: 3, nickname: 'Bếp Z', score: 1600, rank: 4 },
  ]
  const names = ['Bếp Tôi', 'Bếp Y', 'Bếp Z', 'Bếp X']
  const rowOf = (name: string): HTMLElement =>
    within(screen.getByRole('list', { name: 'Bảng điểm' }))
      .getAllByRole('listitem')
      .find((r) => (r.textContent ?? '').includes(name))!

  async function playTwoReveals(ws: FakeWebSocket) {
    ws.push({ type: 'started', game_no: 1, total: 5, seconds: 20, server_now: SERVER_T0 })
    ws.push(questionMsg(1, 5))
    ws.push(revealMsg(1, [], after1, { seat: 1, score: 1000, rank: 1 }))
    await screen.findByRole('list', { name: 'Bảng điểm' })
    ws.push(questionMsg(2, 5))
    ws.push(revealMsg(2, [], after2, { seat: 1, score: 2000, rank: 1 }))
    await screen.findByRole('list', { name: 'Bảng điểm' })
  }

  it('AC-QUIZ-33: dòng lên hạng có "▲ 2", dòng xuống hạng có "▼ 1", dòng không đổi hạng không có mũi tên; thứ tự theo hạng mới', async () => {
    const ws = await enterRoom(1, 1, names)
    await playTwoReveals(ws)
    expect(rowOf('Bếp X').textContent).toMatch(/▲\s*2/)
    expect(rowOf('Bếp Y').textContent).toMatch(/▼\s*1/)
    expect(rowOf('Bếp Tôi').textContent).not.toMatch(/[▲▼]/)
    const order = within(screen.getByRole('list', { name: 'Bảng điểm' }))
      .getAllByRole('listitem')
      .map((r) => names.find((n) => (r.textContent ?? '').includes(n)))
    expect(order).toEqual(['Bếp Tôi', 'Bếp X', 'Bếp Y', 'Bếp Z'])
  })

  it('AC-QUIZ-33: tổng điểm chạy số từ giá trị cũ tới giá trị mới (không nhảy ngay), xong thì hiện đúng giá trị mới', async () => {
    const ws = await enterRoom(1, 1, names)
    await playTwoReveals(ws)
    expect(rowOf('Bếp X').textContent).not.toContain('1900')
    await advance(1500)
    expect(rowOf('Bếp X').textContent).toContain('1900')
    expect(rowOf('Bếp Y').textContent).toContain('1700')
  })

  it('AC-QUIZ-33: lần lộ đáp án đầu tiên (chưa có hạng cũ) không hiện mũi tên', async () => {
    const ws = await enterRoom(1, 1, names)
    ws.push(questionMsg(1, 5))
    ws.push(revealMsg(1, [], after1, { seat: 1, score: 1000, rank: 1 }))
    await screen.findByRole('list', { name: 'Bảng điểm' })
    for (const r of within(screen.getByRole('list', { name: 'Bảng điểm' })).getAllByRole('listitem')) expect(r.textContent).not.toMatch(/[▲▼]/)
  })
})

// ================================================================ AC-QUIZ-34
describe('quiz game ui: bục nhận giải', () => {
  const five = ['Bếp Một', 'Bếp Tôi', 'Bếp Ba', 'Bếp Tư', 'Bếp Năm']

  it('AC-QUIZ-34: 5 người, 3 hạng đầu đứng trên bục theo thứ tự trái sang phải hạng 2, hạng 1, hạng 3, mỗi bậc có huy chương, nickname và điểm; bên dưới là bảng đầy đủ', async () => {
    const ws = await enterRoom(2, 1, five)
    ws.push(finalMsg(five))
    const podium = await screen.findByLabelText('Bục nhận giải')
    const steps = within(podium).getAllByRole('listitem')
    expect(steps).toHaveLength(3)
    expect(steps[0]!.textContent).toContain('🥈')
    expect(steps[0]!.textContent).toContain('Bếp Tôi')
    expect(steps[0]!.textContent).toContain('4300')
    expect(steps[1]!.textContent).toContain('🥇')
    expect(steps[1]!.textContent).toContain('Bếp Một')
    expect(steps[1]!.textContent).toContain('5000')
    expect(steps[2]!.textContent).toContain('🥉')
    expect(steps[2]!.textContent).toContain('Bếp Ba')
    expect(steps[2]!.textContent).toContain('3600')
    const board = screen.getByRole('list', { name: 'Bảng xếp hạng' })
    expect(within(board).getAllByRole('listitem')).toHaveLength(5)
    expect(within(board).getAllByRole('listitem').filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Chia sẻ kết quả' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Chơi lại' })).toBeNull() // seat 2 is not the host
  })

  it('AC-QUIZ-34: chủ phòng thấy nút "Chơi lại" dưới bục', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    ws.push(finalMsg(['Bếp Tôi', 'Bếp Hai']))
    expect(await screen.findByRole('button', { name: 'Chơi lại' })).toBeTruthy()
  })

  it('AC-QUIZ-34: chỉ 2 người chơi thì bục chỉ có 2 bậc (hạng 2 bên trái, hạng 1 bên phải)', async () => {
    const two = ['Bếp Một', 'Bếp Hai']
    const ws = await enterRoom(1, 1, two)
    ws.push(finalMsg(two))
    const podium = await screen.findByLabelText('Bục nhận giải')
    const steps = within(podium).getAllByRole('listitem')
    expect(steps).toHaveLength(2)
    expect(steps[0]!.textContent).toContain('🥈')
    expect(steps[0]!.textContent).toContain('Bếp Hai')
    expect(steps[1]!.textContent).toContain('🥇')
    expect(steps[1]!.textContent).toContain('Bếp Một')
    expect(within(podium).queryByText(/🥉/)).toBeNull()
  })

  it('AC-QUIZ-34: pháo giấy (canvas) chạy 1 lần rồi dừng trong vòng 3 giây', async () => {
    const ws = await enterRoom(2, 1, five)
    expect(document.querySelector('canvas')).toBeNull()
    ws.push(finalMsg(five))
    await screen.findByLabelText('Bục nhận giải')
    await waitFor(() => expect(document.querySelector('canvas')).not.toBeNull())
    await advance(3500)
    expect(document.querySelector('canvas')).toBeNull()
    await advance(3000)
    expect(document.querySelector('canvas')).toBeNull() // it does not start again
  })
})

// ================================================================ AC-QUIZ-35
describe('quiz game ui: phòng chờ sinh động', () => {
  const cardOf = (name: string): HTMLElement => screen.getByText(new RegExp(name)).closest('li') as HTMLElement
  const EMOJI = /\p{Extended_Pictographic}/u

  it('AC-QUIZ-35: mã phòng hiện, dòng đếm "2 người đã vào" rồi "3 người đã vào" khi người thứ 3 vào; chủ phòng có nút "Bắt đầu"', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    expect(bodyText()).toContain(CODE)
    expect(bodyText()).toMatch(/2 người đã vào/)
    expect(screen.getByRole('button', { name: 'Bắt đầu' })).toBeTruthy()
    ws.push(lobbyMsg(1, 1, ['Bếp Tôi', 'Bếp Hai', 'Bếp Ba']))
    await waitFor(() => expect(bodyText()).toMatch(/3 người đã vào/))
    expect(bodyText()).not.toMatch(/2 người đã vào/)
  })

  it('AC-QUIZ-35: mỗi người chơi là một thẻ có emoji và nickname; cùng nickname luôn ra cùng emoji', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai', 'Bếp Ba'])
    const emojiOf = (name: string) => cardOf(name).textContent!.match(EMOJI)?.[0]
    for (const n of ['Bếp Tôi', 'Bếp Hai', 'Bếp Ba']) expect(emojiOf(n), n).toBeTruthy()
    const first = emojiOf('Bếp Hai')
    // the lobby is sent again in another order: the same nickname keeps its emoji
    ws.push(lobbyMsg(1, 1, ['Bếp Tôi', 'Bếp Ba', 'Bếp Hai']))
    await flush()
    expect(emojiOf('Bếp Hai')).toBe(first)
    // and in a brand new session
    cleanup()
    FakeWebSocket.instances = []
    await enterRoom(1, 1, ['Bếp Hai', 'Bếp Tôi'], 'Bếp Hai')
    expect(emojiOf('Bếp Hai')).toBe(first)
  })

  it('AC-QUIZ-35: thẻ người mới vào có hiệu ứng xuất hiện (data-entering), thẻ cũ thì không', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    ws.push(lobbyMsg(1, 1, ['Bếp Tôi', 'Bếp Hai', 'Bếp Ba']))
    await waitFor(() => expect(cardOf('Bếp Ba').getAttribute('data-entering')).toBe('true'))
    expect(cardOf('Bếp Hai').getAttribute('data-entering')).not.toBe('true')
    expect(cardOf('Bếp Tôi').getAttribute('data-entering')).not.toBe('true')
  })
})

// ================================================================ AC-QUIZ-36
describe('quiz game ui: giảm chuyển động', () => {
  it('AC-QUIZ-36: với prefers-reduced-motion: reduce, cả ván không có pháo giấy, hiệu ứng xuất hiện, tiêu đề nổi bật, và số điểm hiện ngay; mọi thông tin vẫn đủ', async () => {
    setReducedMotion(true)
    const names = ['Bếp Tôi', 'Bếp Y', 'Bếp Z', 'Bếp X']
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Y'])

    // lobby: new card without the entering effect
    ws.push(lobbyMsg(1, 1, ['Bếp Tôi', 'Bếp Y', 'Bếp Z']))
    await waitFor(() => expect(bodyText()).toMatch(/3 người đã vào/))
    expect(document.querySelector('[data-entering="true"]')).toBeNull()
    ws.push(lobbyMsg(1, 1, names))

    // question: no emphasis on the title, the timer is still there
    ws.push({ type: 'started', game_no: 1, total: 5, seconds: 20, server_now: SERVER_T0 })
    ws.push(questionMsg(1, 5))
    const title1 = await screen.findByText(/Câu\s*1\s*\/\s*5/)
    expect(title1.getAttribute('data-emphasis')).not.toBe('true')
    expect(screen.getByRole('progressbar')).toBeTruthy()

    // reveal 1 then 2: the new score is shown at once, arrows and the result strip are still there
    const after1: Row[] = [
      { seat: 1, nickname: 'Bếp Tôi', score: 1000, rank: 1 },
      { seat: 2, nickname: 'Bếp Y', score: 900, rank: 2 },
      { seat: 3, nickname: 'Bếp Z', score: 800, rank: 3 },
      { seat: 4, nickname: 'Bếp X', score: 700, rank: 4 },
    ]
    const after2: Row[] = [
      { seat: 1, nickname: 'Bếp Tôi', score: 2000, rank: 1 },
      { seat: 4, nickname: 'Bếp X', score: 1900, rank: 2 },
      { seat: 2, nickname: 'Bếp Y', score: 1700, rank: 3 },
      { seat: 3, nickname: 'Bếp Z', score: 1600, rank: 4 },
    ]
    const win = (points: number) => [{ seat: 1, picks: [OPT.a.id, OPT.b.id] as [string, string], ok: true, points }]
    ws.push(revealMsg(1, win(1000), after1, { seat: 1, score: 1000, rank: 1 }))
    await screen.findByRole('list', { name: 'Bảng điểm' })
    ws.push(questionMsg(2, 5))
    expect((await screen.findByText(/Câu\s*2\s*\/\s*5/)).getAttribute('data-emphasis')).not.toBe('true')
    ws.push(revealMsg(2, win(1000), after2, { seat: 1, score: 2000, rank: 1 }))
    const board = await screen.findByRole('list', { name: 'Bảng điểm' })
    const rowX = within(board).getAllByRole('listitem').find((r) => (r.textContent ?? '').includes('Bếp X'))!
    expect(rowX.textContent).toContain('1900') // immediately, no count-up
    expect(rowX.textContent).toMatch(/▲\s*2/)
    const rowY = within(board).getAllByRole('listitem').find((r) => (r.textContent ?? '').includes('Bếp Y'))!
    expect(rowY.textContent).toMatch(/▼\s*1/)
    expect(statusText()).toContain('Chuẩn! +1000')
    expect(statusText()).toContain('🔥 2 câu liên tiếp')

    // final: the podium is shown, no confetti canvas at any time
    ws.push(finalMsg(names))
    const podium = await screen.findByLabelText('Bục nhận giải')
    expect(within(podium).getAllByRole('listitem')).toHaveLength(3)
    expect(document.querySelector('canvas')).toBeNull()
    await advance(1000)
    expect(document.querySelector('canvas')).toBeNull()
  })

  it('AC-QUIZ-36: không bật reduced motion thì (đối chứng) pháo giấy có chạy ở bảng chung cuộc', async () => {
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    ws.push(finalMsg(['Bếp Tôi', 'Bếp Hai']))
    await screen.findByLabelText('Bục nhận giải')
    await waitFor(() => expect(document.querySelector('canvas')).not.toBeNull())
  })
})

// ================================================================ AC-QUIZ-37 (UI)
describe('quiz game ui: đếm người đã chốt', () => {
  it('AC-QUIZ-37: nhận progress { q, answered: 3, total: 5 } thì hiện "3/5 người đã chốt", cập nhật khi có tin mới', async () => {
    const ws = await openQuestion()
    ws.push({ type: 'progress', q: 1, answered: 3, total: 5 })
    await waitFor(() => expect(bodyText()).toMatch(/3\s*\/\s*5 người đã chốt/))
    ws.push({ type: 'progress', q: 1, answered: 3, total: 4 })
    await waitFor(() => expect(bodyText()).toMatch(/3\s*\/\s*4 người đã chốt/))
    expect(bodyText()).not.toMatch(/3\s*\/\s*5 người đã chốt/)
  })

  it('AC-QUIZ-37: tin progress của câu khác câu đang mở bị bỏ qua', async () => {
    const ws = await openQuestion(2, 5)
    ws.push({ type: 'progress', q: 1, answered: 4, total: 5 })
    ws.push({ type: 'progress', q: 3, answered: 4, total: 5 })
    await flush()
    expect(bodyText()).not.toMatch(/4\s*\/\s*5 người đã chốt/)
    ws.push({ type: 'progress', q: 2, answered: 2, total: 5 })
    await waitFor(() => expect(bodyText()).toMatch(/2\s*\/\s*5 người đã chốt/))
  })

  it('AC-QUIZ-37: tin progress của câu đã đóng (sau reveal) bị bỏ qua', async () => {
    const ws = await openQuestion(1, 5)
    ws.push({ type: 'progress', q: 1, answered: 2, total: 5 })
    await waitFor(() => expect(bodyText()).toMatch(/2\s*\/\s*5 người đã chốt/))
    ws.push(revealMsg(1, [], [{ seat: 1, nickname: 'Bếp Tôi', score: 0, rank: 1 }], { seat: 1, score: 0, rank: 1 }))
    await waitFor(() => expect(optionButton('Mì Gói').dataset.state).toBe('correct'))
    ws.push({ type: 'progress', q: 1, answered: 5, total: 5 })
    await flush()
    expect(bodyText()).not.toMatch(/5\s*\/\s*5 người đã chốt/)
  })

  it('AC-QUIZ-37: câu mới thì bộ đếm của câu trước không còn hiện', async () => {
    const ws = await openQuestion(1, 5)
    ws.push({ type: 'progress', q: 1, answered: 3, total: 5 })
    await waitFor(() => expect(bodyText()).toMatch(/3\s*\/\s*5 người đã chốt/))
    ws.push(revealMsg(1, [], [{ seat: 1, nickname: 'Bếp Tôi', score: 0, rank: 1 }], { seat: 1, score: 0, rank: 1 }))
    ws.push(questionMsg(2, 5))
    await screen.findByText(/Câu\s*2\s*\/\s*5/)
    expect(bodyText()).not.toMatch(/3\s*\/\s*5 người đã chốt/)
  })
})

// ================================================================ AC-QUIZ-38
describe('quiz game ui: mã QR trong phòng chờ (Tùy chọn)', () => {
  it('AC-QUIZ-38: phòng chờ có mã QR tên truy cập "Mã QR vào phòng <mã>" là SVG, mã hóa đúng link tuyệt đối như "Sao chép link"', async () => {
    await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    const img = await screen.findByRole('img', { name: `Mã QR vào phòng ${CODE}` })
    expect(img.tagName.toLowerCase() === 'svg' || img.querySelector('svg') !== null).toBe(true)
    await waitFor(() => expect(qr.encoded.length).toBeGreaterThan(0))
    expect(qr.encoded[qr.encoded.length - 1]).toMatch(new RegExp(`^https://[^/]+/lau-meme/quiz/${CODE}$`))

    const clip = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép link' }))
    await waitFor(() => expect(clip).toHaveBeenCalledTimes(1))
    expect(clip.mock.calls[0]![0]).toBe(qr.encoded[qr.encoded.length - 1])
  })

  it('AC-QUIZ-38: mã QR tạo ngay trên trình duyệt, không gọi dịch vụ ngoài và không dùng ảnh từ mạng', async () => {
    await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    await screen.findByRole('img', { name: `Mã QR vào phòng ${CODE}` })
    const external = fetchMock.mock.calls.map((c) => urlOf(c[0] as RequestInfo)).filter((u) => /^https?:\/\//.test(u) && !u.includes('/lau-meme/api/'))
    expect(external).toEqual([])
    const srcs = Array.from(document.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '')
    expect(srcs.filter((s) => /^https?:/.test(s))).toEqual([])
  })
})

// ================================================================ AC-QUIZ-39
describe('quiz game ui: âm thanh và rung (Tùy chọn)', () => {
  it('AC-QUIZ-39: chưa từng đặt thì mặc định bật (🔊) ở phòng chờ và ở màn câu hỏi; Web Audio chưa được dùng trước thao tác nào', async () => {
    withAudio()
    consent()
    render(<QuizRoom code={CODE} />)
    await screen.findByRole('button', { name: 'Vào phòng' })
    expect(FakeAudioContext.created).toBe(0) // no gesture yet: nothing is created, nothing plays
    expect(FakeAudioContext.starts).toBe(0)
    cleanup()
    FakeWebSocket.instances = []
    const ws = await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    expect(soundButton()).not.toBeNull()
    expect(`${soundButton()!.textContent}${soundButton()!.getAttribute('aria-label')}`).toContain('🔊')
    ws.push(questionMsg(1, 5))
    await screen.findByText('Lẩu Thái')
    expect(`${soundButton()!.textContent}${soundButton()!.getAttribute('aria-label')}`).toContain('🔊')
  })

  it('AC-QUIZ-39: sau thao tác của người dùng, tiếng tích tắc 5 s cuối, tiếng đúng, tiếng sai và nhạc chung cuộc đều phát bằng Web Audio, không dùng file âm thanh', async () => {
    withAudio()
    const ws = await openQuestion(1, 5)
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    const base = FakeAudioContext.starts

    await advance(16_000) // inside the last 5 s
    const afterTick = FakeAudioContext.starts
    expect(afterTick, 'tiếng tích tắc').toBeGreaterThan(base)

    const row = [{ seat: 1, nickname: 'Bếp Tôi', score: 700, rank: 1 }]
    ws.push(revealMsg(1, [{ seat: 1, picks: [OPT.a.id, OPT.b.id], ok: true, points: 700 }], row, { seat: 1, score: 700, rank: 1 }))
    await screen.findByRole('list', { name: 'Bảng điểm' })
    const afterRight = FakeAudioContext.starts
    expect(afterRight, 'tiếng đúng').toBeGreaterThan(afterTick)
    const rightTone = FakeAudioContext.frequencies.slice()

    ws.push(questionMsg(2, 5))
    ws.push(revealMsg(2, [{ seat: 1, picks: [OPT.a.id, OPT.c.id], ok: false, points: 0 }], row, { seat: 1, score: 700, rank: 1 }))
    await waitFor(() => expect(statusText()).toContain('Trượt rồi'))
    expect(FakeAudioContext.starts, 'tiếng sai').toBeGreaterThan(afterRight)
    expect(FakeAudioContext.frequencies.length).toBeGreaterThan(rightTone.length)

    const beforeFinal = FakeAudioContext.starts
    ws.push(finalMsg(['Bếp Tôi', 'Bếp Hai']))
    await screen.findByLabelText('Bục nhận giải')
    expect(FakeAudioContext.starts, 'nhạc chung cuộc').toBeGreaterThan(beforeFinal)

    expect(audioNotConstructed).not.toHaveBeenCalled() // no <audio>/new Audio()
    const files = fetchMock.mock.calls.map((c) => urlOf(c[0] as RequestInfo)).filter((u) => /\.(mp3|ogg|wav|m4a|aac)(\?|$)/i.test(u))
    expect(files).toEqual([])
    expect(document.querySelector('audio')).toBeNull()
  })

  it('AC-QUIZ-39: bấm 🔊 để tắt thì nút thành 🔇, không phát tiếng và không rung; lựa chọn lưu trong localStorage (khóa "laumeme:") và giữ sau khi tải lại', async () => {
    withAudio()
    const ws = await openQuestion(1, 5)
    const before = Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i)!, localStorage.getItem(localStorage.key(i)!)]))
    fireEvent.click(soundButton()!) // also the first user gesture
    expect(`${soundButton()!.textContent}${soundButton()!.getAttribute('aria-label')}`).toContain('🔇')
    const after = Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i)!, localStorage.getItem(localStorage.key(i)!)]))
    const changed = Object.keys(after).filter((k) => before[k] !== after[k])
    expect(changed.some((k) => k.startsWith('laumeme:')), 'lựa chọn lưu dưới khóa laumeme:').toBe(true)

    const base = FakeAudioContext.starts
    await advance(16_000)
    ws.push(revealMsg(1, [{ seat: 1, picks: [OPT.a.id, OPT.b.id], ok: true, points: 700 }], [{ seat: 1, nickname: 'Bếp Tôi', score: 700, rank: 1 }], { seat: 1, score: 700, rank: 1 }))
    await screen.findByRole('list', { name: 'Bảng điểm' })
    expect(FakeAudioContext.starts).toBe(base)
    expect(vibrate).not.toHaveBeenCalled()

    // reload
    cleanup()
    FakeWebSocket.instances = []
    await enterRoom(1, 1, ['Bếp Tôi', 'Bếp Hai'])
    expect(`${soundButton()!.textContent}${soundButton()!.getAttribute('aria-label')}`).toContain('🔇')
  })

  it('AC-QUIZ-39: không có Web Audio thì nút 🔊/🔇 ẩn và game vẫn chạy bình thường', async () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    const ws = await openQuestion(1, 5)
    expect(soundButton()).toBeNull()
    fireEvent.click(optionButton('Mì Gói'))
    fireEvent.click(optionButton('Cà Phê'))
    expect(chot().disabled).toBe(false)
    ws.push(revealMsg(1, [], [{ seat: 1, nickname: 'Bếp Tôi', score: 0, rank: 1 }], { seat: 1, score: 0, rank: 1 }))
    await waitFor(() => expect(optionButton('Mì Gói').dataset.state).toBe('correct'))
  })

  it('AC-QUIZ-39: localStorage bị lỗi (chặn ghi) thì bấm nút âm thanh không làm hỏng game', async () => {
    withAudio()
    await openQuestion(1, 5)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => fireEvent.click(soundButton()!)).not.toThrow()
    expect(screen.getByText('Lẩu Thái')).toBeTruthy()
    expect(chot()).toBeTruthy()
  })
})
