// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests for docs/acceptance/daily.md, the DailyPanel UI: AC-DAILY-03/04/05/06/08/09/12/13/14/15.
 * Model of 2026-10-21: no challenge board and no step counting; the result is posted automatically for a signed-in
 * account once the Món đặc biệt is solved on the normal board.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES
 *   ./DailyPanel:  DailyPanel({ manifest, storage, solved }: { manifest: Manifest; storage: Storage | null; solved: SolvedDaily | null })
 *     - card (aria-label "Món đặc biệt hôm nay"): emoji + hint + name "???" until `solved`, then `solved.name` and "Đã giải"
 *     - solved + signed in: POST /daily/{v}/results { a, b } once, shows "Hạng #<rank> · Streak <current>"
 *     - solved + signed out: shows "Đăng nhập bằng Google để lên bảng xếp hạng", sends nothing; after sign-in sends at once
 *     - 429: "Gửi quá nhanh, thử lại sau."; 409: shows the stored rank; countdown line as AC-DAILY-12
 *     - button "Bảng xếp hạng" opens a panel with role="tab" "Mẻ này" | "Tuần" | "Tháng"
 *   ../auth/session: setCurrentSession(s | null), getCurrentSession(), useSession()
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentSession } from '../auth/session'
import type { Manifest } from '../game/engine'
import { fold } from '../graph/crypto'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { useState } from 'react'
import { DailyPanel, Leaderboards } from './DailyPanel'

// ---------------------------------------------------------------- fixtures
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const T0 = new Date('2026-10-20T03:00:00.000Z') // W43 / 2026-10
const VERSION = 7
const SOLVED = { a: 'Hết Cứu', b: 'Cay', name: 'Stonks' }
type SessionArg = Parameters<typeof setCurrentSession>[0]
const SESSION = { nickname: null, created_at: '2026-10-20T02:00:00.000Z' } as unknown as SessionArg

function manifestOf(version = VERSION, batchAt = '2026-10-20T00:00:00.000Z'): Manifest {
  return {
    version,
    batch_at: batchAt,
    graph_url: `/api/graph/${version}`,
    starters: [
      { id: eid('Cay'), name: 'Cay', emoji: '🌶️' },
      { id: eid('Cười'), name: 'Cười', emoji: '😂' },
      { id: eid('Toang'), name: 'Toang', emoji: '💀' },
      { id: eid('Deadline'), name: 'Deadline', emoji: '⏰' },
    ],
    miss_lines: ['Nồi trào kiểu 0, khét rồi!'],
    daily: { element_id: eid('Stonks'), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    policy_version: 1,
  } as Manifest
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

const STORED = { version: VERSION, solve_ms: 312_000, rank: 3, streak: { current: 2, longest: 4 }, solved_at: '2026-10-20T05:35:12.000Z' }
const NEW_RESULT = { version: VERSION, solve_ms: 1_805_000, rank: 1, streak: { current: 1, longest: 1 }, solved_at: '2026-10-20T06:00:05.000Z' }
let resultsReply: () => Response
let batchBoardReply: () => Response
let periodBoardReply: (period: string) => Response
let fetchMock: ReturnType<typeof vi.fn>

function installNet(): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.includes('/daily/') && url.endsWith('/results') && method === 'POST') return resultsReply()
    if (url.includes('/daily/leaderboard') && method === 'GET') {
      return periodBoardReply(new URL(url, 'https://example.com').searchParams.get('period') ?? '')
    }
    if (url.includes('/daily/') && url.endsWith('/leaderboard') && method === 'GET') return batchBoardReply()
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
const resultPosts = () => calls().filter((c) => c.method === 'POST' && c.url.includes('/daily/') && c.url.endsWith('/results'))
const batchBoardGets = () => calls().filter((c) => c.method === 'GET' && c.url.includes(`/daily/${VERSION}/leaderboard`))
const periodGets = () => calls().filter((c) => c.method === 'GET' && c.url.includes('/daily/leaderboard'))

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  resultsReply = () => json(NEW_RESULT, 201)
  batchBoardReply = () => json({ version: VERSION, rows: [], me: null })
  periodBoardReply = (period) =>
    json({ period, starts_at: '2026-10-18T17:00:00.000Z', ends_at: '2026-10-25T17:00:00.000Z', batches: 0, rows: [], me: null })
  installNet()
  act(() => setCurrentSession(null))
})
afterEach(() => {
  cleanup()
  act(() => setCurrentSession(null))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ---------------------------------------------------------------- helpers
/** The card, plus the leaderboard screen it opens (AC-DAILY-17 moved the boards out of the card). */
function Panel({ manifest, solved }: { manifest: Manifest; solved: typeof SOLVED | null }) {
  const [board, setBoard] = useState(false)
  return (
    <>
      <DailyPanel manifest={manifest} storage={localStorage} solved={solved} onShowBoard={() => setBoard(true)} />
      {board && <Leaderboards version={manifest.version} />}
    </>
  )
}
function panel(opts: { manifest?: Manifest; solved?: typeof SOLVED | null } = {}) {
  return <Panel manifest={opts.manifest ?? manifestOf()} solved={opts.solved === undefined ? null : opts.solved} />
}
const signIn = () => act(() => setCurrentSession(SESSION))
const signOut = () => act(() => setCurrentSession(null))
const card = (): HTMLElement => screen.getByRole('region', { name: 'Món đặc biệt hôm nay' })
/** True when some element's whole text is exactly `t`. */
const hasText = (t: string): boolean => Array.from(document.body.querySelectorAll('*')).some((e) => e.textContent?.trim() === t)
const hasMatch = (re: RegExp): boolean => Array.from(document.body.querySelectorAll('*')).some((e) => re.test(e.textContent ?? ''))
const seeText = (t: string) => waitFor(() => expect(hasText(t), `thiếu dòng "${t}"`).toBe(true))
const seeMatch = (re: RegExp) => waitFor(() => expect(hasMatch(re), `thiếu ${String(re)}`).toBe(true))
/** A leaderboard row: exactly `t`, after the medal ranks 1-3 carry since AC-DAILY-17. */
const seeRow = (t: string) =>
  seeMatch(new RegExp(`^(?:[🥇🥈🥉] )?${t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'u'))
const INVITE = 'Đăng nhập bằng Google để lên bảng xếp hạng'
const BOARD_INVITE = 'Đăng nhập bằng Google để có tên trên bảng xếp hạng'
async function openBoard(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Xem bảng xếp hạng' }))
  await screen.findByRole('tab', { name: 'Mẻ này' })
}

// ================================================================ AC-DAILY-03 / 04 / 12: card and clock
describe('daily ui: thẻ Món đặc biệt và đồng hồ', () => {
  it('AC-DAILY-03: thẻ hiện emoji, gợi ý và tên "???", không lộ tên món, không có nút "Thử thách" hay bàn thử thách', () => {
    const { container } = render(panel())
    expect(card().textContent).toContain('📈')
    expect(within(card()).getByText('Món lên như diều gặp gió')).toBeTruthy()
    expect(within(card()).getByText('???')).toBeTruthy()
    expect(within(card()).queryByText('Đã giải')).toBeNull()
    expect(container.textContent).not.toContain('Stonks')
    expect(screen.queryByRole('button', { name: /thử thách/i })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Bàn thử thách' })).toBeNull()
    expect(container.textContent).not.toMatch(/Bước:/)
  })

  it('AC-DAILY-04: khi đã giải thẻ lộ tên "Stonks" và hiện "Đã giải", không còn "???"', () => {
    render(panel({ solved: SOLVED }))
    expect(within(card()).getByText('Stonks')).toBeTruthy()
    expect(within(card()).getByText('Đã giải')).toBeTruthy()
    expect(within(card()).queryByText('???')).toBeNull()
    expect(screen.queryByRole('button', { name: /thử thách/i })).toBeNull()
  })

  it('AC-DAILY-12: hiện "Mẻ mới sau h:mm:ss" tính từ batch_at của manifest', () => {
    render(panel()) // batch_at 00:00 UTC, now 03:00 UTC => the 05:00 UTC mark is 2 h away
    expect(screen.getByText(/Mẻ mới sau 2:00:0\d/)).toBeTruthy()
  })

  it('AC-DAILY-12: đã quá mốc mà manifest chưa đổi thì hiện "Mẻ mới sắp lên", không có số âm', () => {
    vi.setSystemTime(new Date('2026-10-20T05:20:00.000Z'))
    render(panel())
    expect(screen.getByText('Mẻ mới sắp lên')).toBeTruthy()
    expect(screen.queryByText(/Mẻ mới sau/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/-\d+:\d\d/)
  })

  it('AC-DAILY-12: batch_at 17:03 UTC (cron trễ), lúc 17:30 UTC hiện 11:30:00 tới mốc 05:00 UTC', () => {
    vi.setSystemTime(new Date('2026-10-20T17:30:00.000Z'))
    render(panel({ manifest: manifestOf(VERSION, '2026-10-20T17:03:00.000Z') }))
    expect(screen.getByText(/Mẻ mới sau 11:30:0\d/)).toBeTruthy()
  })
})

// ================================================================ AC-DAILY-05 / 06 / 08 / 13 / 15: submitting
describe('daily ui: gửi kết quả', () => {
  it('AC-DAILY-15: giải khi chưa đăng nhập thì hiện lời mời đăng nhập, không gửi gì; đăng nhập xong tự gửi ngay (không cần bấm) và hiện "Hạng #… · Streak …"', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(panel({ solved: SOLVED }))
    expect(await screen.findByText(INVITE)).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(resultPosts()).toEqual([])
    expect(screen.queryByText(/Hạng #/)).toBeNull()

    await signIn()
    await seeMatch(/Hạng #1 · Streak 1/)
    expect(resultPosts()).toHaveLength(1)
    expect(screen.queryByText(INVITE)).toBeNull()
    const post = resultPosts()[0]!
    expect(post.url).toContain(`/lau-meme/api/daily/${VERSION}/results`)
    expect(post.player).toBe(getPlayerId(localStorage))
    expect(JSON.parse(post.body!)).toEqual({ a: 'Hết Cứu', b: 'Cay' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(resultPosts()).toHaveLength(1) // only once
  })

  it('AC-DAILY-06: đã đăng nhập sẵn và giải rồi (tải lại trang) thì tự gửi đúng một lần khi dựng thẻ, hiện hạng và streak', async () => {
    saveConsent(localStorage, 1, 'granted')
    await signIn()
    render(panel({ solved: SOLVED }))
    await seeMatch(/Hạng #1 · Streak 1/)
    expect(resultPosts()).toHaveLength(1)
    expect(screen.queryByText(INVITE)).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(resultPosts()).toHaveLength(1)
  })

  it('AC-DAILY-06: chưa giải thì đăng nhập cũng không gửi gì', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(panel())
    await signIn()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(resultPosts()).toEqual([])
    expect(screen.queryByText(/Hạng #/)).toBeNull()
  })

  it('AC-DAILY-06: chưa đồng ý chính sách thì không gửi gì và không có yêu cầu nào mang X-Player-Id', async () => {
    saveConsent(localStorage, 1, 'declined')
    await signIn()
    render(panel({ solved: SOLVED }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(resultPosts()).toEqual([])
    expect(calls().filter((c) => c.player !== null)).toEqual([])
    expect(screen.queryByText(/Hạng #/)).toBeNull()
  })

  it('AC-DAILY-08: máy chủ trả 409 thì hiện hạng và streak của kết quả đã lưu', async () => {
    saveConsent(localStorage, 1, 'granted')
    resultsReply = () => json({ type: 'about:blank', title: 'Đã nộp', status: 409, result: STORED }, 409)
    await signIn()
    render(panel({ solved: SOLVED }))
    await seeMatch(/Hạng #3 · Streak 2/)
    expect(resultPosts()).toHaveLength(1)
  })

  it('AC-DAILY-13: máy chủ trả 429 thì hiện "Gửi quá nhanh, thử lại sau." và không hiện hạng', async () => {
    saveConsent(localStorage, 1, 'granted')
    resultsReply = () => json({ type: 'about:blank', title: 'Quá nhanh', status: 429 }, 429)
    await signIn()
    render(panel({ solved: SOLVED }))
    expect(await screen.findByText('Gửi quá nhanh, thử lại sau.')).toBeTruthy()
    expect(screen.queryByText(/Hạng #/)).toBeNull()
    // still shown as solved, locally kept
    expect(within(card()).getByText('Đã giải')).toBeTruthy()
  })

  it('AC-DAILY-05: thẻ vẫn "Đã giải" kèm tên khi chưa gửi được; dựng lại ở mẻ khác (solved = null) thì lại "???"', () => {
    const first = render(panel({ solved: SOLVED }))
    expect(within(card()).getByText('Stonks')).toBeTruthy()
    first.unmount()
    render(panel({ manifest: manifestOf(VERSION + 1, '2026-10-20T05:04:00.000Z'), solved: null }))
    expect(within(card()).getByText('???')).toBeTruthy()
    expect(within(card()).queryByText('Đã giải')).toBeNull()
  })
})

// ================================================================ AC-DAILY-09 / 14 / 15: leaderboards
describe('daily ui: bảng xếp hạng', () => {
  it('AC-DAILY-15: nút "Bảng xếp hạng" mở panel có 3 thẻ "Mẻ này", "Tuần", "Tháng"; mặc định là "Mẻ này"', async () => {
    render(panel())
    await openBoard()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Mẻ này', 'Tuần', 'Tháng'])
    expect(screen.getByRole('tab', { name: 'Mẻ này' }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(batchBoardGets().length).toBeGreaterThanOrEqual(1))
    expect(batchBoardGets()[0]!.url).toContain(`/lau-meme/api/daily/${VERSION}/leaderboard`)
  })

  it('AC-DAILY-09: thẻ "Mẻ này" liệt kê "#<hạng> <nickname> - <thời gian>" với thời gian "5 phút 12 giây" / "1 giờ 05 phút 12 giây"', async () => {
    batchBoardReply = () =>
      json({
        version: VERSION,
        rows: [
          { rank: 1, nickname: 'Bếp Trưởng', value: 312_000 },
          { rank: 2, nickname: 'Thực khách ẩn danh', value: 3_912_000 },
        ],
        me: null,
      })
    render(panel())
    await openBoard()
    await seeRow('#1 Bếp Trưởng - 5 phút 12 giây')
    await seeRow('#2 Thực khách ẩn danh - 1 giờ 05 phút 12 giây')
  })

  it('AC-DAILY-09: me nằm ngoài rows thì thêm dòng "Bạn: #25 ..."; me đã trong rows hoặc null thì không có dòng "Bạn:"', async () => {
    batchBoardReply = () =>
      json({
        version: VERSION,
        rows: [{ rank: 1, nickname: 'A', value: 4_000 }],
        me: { rank: 25, nickname: 'Bếp Trưởng', value: 3_912_000 },
      })
    const first = render(panel())
    await openBoard()
    await seeMatch(/^Bạn: #25 .*1 giờ 05 phút 12 giây/)
    first.unmount()

    batchBoardReply = () =>
      json({ version: VERSION, rows: [{ rank: 1, nickname: 'A', value: 4_000 }], me: { rank: 1, nickname: 'A', value: 4_000 } })
    const second = render(panel())
    await openBoard()
    await seeRow('#1 A - 0 phút 04 giây')
    expect(hasMatch(/Bạn:/)).toBe(false)
    second.unmount()

    batchBoardReply = () => json({ version: VERSION, rows: [{ rank: 1, nickname: 'A', value: 4_000 }], me: null })
    render(panel())
    await openBoard()
    await seeRow('#1 A - 0 phút 04 giây')
    expect(hasMatch(/Bạn:/)).toBe(false)
  })

  it('AC-DAILY-15: bảng mẻ rỗng hiện "Chưa có ai giải món này", không để trống', async () => {
    render(panel())
    await openBoard()
    await seeText('Chưa có ai giải món này')
  })

  it('AC-DAILY-14: thẻ "Tuần" tải ?period=2026-W43 và liệt kê "#1 <nickname> - <đã giải>/<số mẻ> mẻ - <tổng thời gian>"; có "Bạn:" khi me ngoài rows', async () => {
    periodBoardReply = (period) =>
      json({
        period,
        starts_at: '2026-10-18T17:00:00.000Z',
        ends_at: '2026-10-25T17:00:00.000Z',
        batches: 4,
        rows: [
          { rank: 1, nickname: 'Bếp Phó B', solved: 3, total_ms: 72_000_000 },
          { rank: 2, nickname: 'Thực khách ẩn danh', solved: 2, total_ms: 3_912_000 },
        ],
        me: { rank: 30, nickname: 'Tôi', solved: 1, total_ms: 312_000 },
      })
    render(panel())
    await openBoard()
    fireEvent.click(screen.getByRole('tab', { name: 'Tuần' }))
    await seeRow('#1 Bếp Phó B - 3/4 mẻ - 20 giờ 00 phút 00 giây')
    await seeRow('#2 Thực khách ẩn danh - 2/4 mẻ - 1 giờ 05 phút 12 giây')
    await seeMatch(/^Bạn: #30 /)
    expect(periodGets().length).toBeGreaterThanOrEqual(1)
    expect(periodGets()[0]!.url).toContain('period=2026-W43')
    expect(screen.getByRole('tab', { name: 'Tuần' }).getAttribute('aria-selected')).toBe('true')
  })

  it('AC-DAILY-14: thẻ "Tháng" tải ?period=2026-10', async () => {
    render(panel())
    await openBoard()
    fireEvent.click(screen.getByRole('tab', { name: 'Tháng' }))
    await waitFor(() => expect(periodGets().some((g) => g.url.includes('period=2026-10'))).toBe(true))
    expect(screen.getByRole('tab', { name: 'Tháng' }).getAttribute('aria-selected')).toBe('true')
  })

  it('AC-DAILY-15: thẻ Tuần và Tháng rỗng hiện "Chưa có ai giải món nào trong kỳ", không để trống', async () => {
    render(panel())
    await openBoard()
    fireEvent.click(screen.getByRole('tab', { name: 'Tuần' }))
    await seeText('Chưa có ai giải món nào trong kỳ')
    fireEvent.click(screen.getByRole('tab', { name: 'Tháng' }))
    await seeText('Chưa có ai giải món nào trong kỳ')
  })

  it('AC-DAILY-15: chưa đăng nhập vẫn xem được bảng, kèm dòng nhắc đăng nhập ở mọi thẻ; đăng nhập rồi thì dòng nhắc biến mất', async () => {
    render(panel())
    await openBoard()
    await seeText(BOARD_INVITE)
    fireEvent.click(screen.getByRole('tab', { name: 'Tuần' }))
    await seeText('Chưa có ai giải món nào trong kỳ')
    expect(hasText(BOARD_INVITE)).toBe(true)

    await signIn()
    await waitFor(() => expect(hasText(BOARD_INVITE)).toBe(false))
    await signOut()
    await seeText(BOARD_INVITE)
  })

  it('AC-DAILY-09: GET bảng xếp hạng không mang X-Player-Id (cookie phiên tự đi kèm) kể cả khi đã đồng ý', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(panel())
    await openBoard()
    fireEvent.click(screen.getByRole('tab', { name: 'Tuần' }))
    await waitFor(() => expect(periodGets().length).toBeGreaterThanOrEqual(1))
    expect(batchBoardGets().length).toBeGreaterThanOrEqual(1)
    expect([...batchBoardGets(), ...periodGets()].every((g) => g.player === null)).toBe(true)
  })
})
