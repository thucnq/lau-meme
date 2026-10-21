// @vitest-environment jsdom
/**
 * AC-DAILY-06/08/09/14 (client API layer). The fetch layer is stubbed.
 *
 * Expected module `./api`:
 *   submitDailyResult(version, { a, b }, { storage, policyVersion }) -> Promise<{ result: DailyResult; already: boolean }>
 *     POST /lau-meme/api/daily/{v}/results, JSON, X-Player-Id; 201 -> already false; 409 -> already true with body.result;
 *     other status -> SendError(status) (401 = not signed in); no play consent -> ConsentRequiredError, no fetch.
 *   getDailyLeaderboard(version) -> GET /lau-meme/api/daily/{v}/leaderboard, no X-Player-Id (the cookie goes by itself)
 *   getPeriodLeaderboard(period) -> GET /lau-meme/api/daily/leaderboard?period=<period>, no X-Player-Id
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendError } from '../disc/api'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { getDailyLeaderboard, getPeriodLeaderboard, submitDailyResult } from './api'

const VERSION = 7
const STORED = {
  version: VERSION,
  solve_ms: 312_000,
  rank: 3,
  streak: { current: 2, longest: 4 },
  solved_at: '2026-10-20T05:35:12.000Z',
}
const PAIR = { a: 'Hết Cứu', b: 'Cay' }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

let reply: () => Response
let fetchMock: ReturnType<typeof vi.fn>
const opts = () => ({ storage: localStorage as Storage | null, policyVersion: 1 })
const sent = () =>
  fetchMock.mock.calls.map((c) => ({
    url: urlOf(c[0] as RequestInfo),
    method: ((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    player: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id'),
    type: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'Content-Type'),
    body: (c[1] as RequestInit | undefined)?.body as string | undefined,
  }))

beforeEach(() => {
  localStorage.clear()
  reply = () => json(STORED, 201)
  fetchMock = vi.fn(async () => reply())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('submitDailyResult', () => {
  it('AC-DAILY-06: 201 trả { result, already: false }; POST đúng đường dẫn, JSON { a, b } và X-Player-Id', async () => {
    saveConsent(localStorage, 1, 'granted')
    const out = await submitDailyResult(VERSION, PAIR, opts())
    expect(out).toEqual({ result: STORED, already: false })
    const call = sent()[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toContain(`/lau-meme/api/daily/${VERSION}/results`)
    expect(call.type).toContain('application/json')
    expect(JSON.parse(call.body!)).toEqual(PAIR)
    expect(call.player).toBe(getPlayerId(localStorage))
  })

  it('AC-DAILY-08: 409 trả { result: kết quả đã lưu, already: true }', async () => {
    saveConsent(localStorage, 1, 'granted')
    reply = () => json({ type: 'about:blank', title: 'Đã nộp', status: 409, result: STORED }, 409)
    expect(await submitDailyResult(VERSION, PAIR, opts())).toEqual({ result: STORED, already: true })
  })

  it('AC-DAILY-08: 401 (chưa đăng nhập), 410 (mẻ đã qua), 422, 429 ném SendError mang status', async () => {
    saveConsent(localStorage, 1, 'granted')
    for (const status of [401, 410, 422, 429, 500]) {
      reply = () => json({ type: 'about:blank', title: 'Lỗi', status }, status)
      const err = await submitDailyResult(VERSION, PAIR, opts()).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err, String(status)).toBeInstanceOf(SendError)
      expect((err as SendError).status, String(status)).toBe(status)
    }
  })

  it('AC-DAILY-06: chưa đồng ý thì ném lỗi (không phải SendError) và không fetch', async () => {
    const err = await submitDailyResult(VERSION, PAIR, opts()).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeTruthy()
    expect(err).not.toBeInstanceOf(SendError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('leaderboards (client API)', () => {
  const DAILY = { version: VERSION, rows: [{ rank: 1, nickname: 'Bếp Trưởng', value: 312_000 }], me: null }
  const PERIOD = {
    period: '2026-W43',
    starts_at: '2026-10-18T17:00:00.000Z',
    ends_at: '2026-10-25T17:00:00.000Z',
    batches: 4,
    rows: [{ rank: 1, nickname: 'Bếp Trưởng', solved: 3, total_ms: 72_000_000 }],
    me: null,
  }

  it('AC-DAILY-09: getDailyLeaderboard GET /daily/{v}/leaderboard, không gửi X-Player-Id kể cả khi đã đồng ý, trả đúng nội dung', async () => {
    saveConsent(localStorage, 1, 'granted')
    reply = () => json(DAILY)
    expect(await getDailyLeaderboard(VERSION)).toEqual(DAILY)
    const call = sent()[0]!
    expect(call.method).toBe('GET')
    expect(call.url).toContain(`/lau-meme/api/daily/${VERSION}/leaderboard`)
    expect(call.player).toBeNull()
  })

  it('AC-DAILY-09: getDailyLeaderboard gặp lỗi máy chủ thì từ chối (Promise reject)', async () => {
    reply = () => json({ type: 'about:blank', title: 'Lỗi', status: 500 }, 500)
    await expect(getDailyLeaderboard(VERSION)).rejects.toBeTruthy()
  })

  it('AC-DAILY-14: getPeriodLeaderboard GET /daily/leaderboard?period=..., không gửi X-Player-Id, trả đúng nội dung', async () => {
    saveConsent(localStorage, 1, 'granted')
    reply = () => json(PERIOD)
    expect(await getPeriodLeaderboard('2026-W43')).toEqual(PERIOD)
    await getPeriodLeaderboard('2026-10')
    const calls = sent()
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toContain('/lau-meme/api/daily/leaderboard?period=2026-W43')
    expect(calls[1]!.url).toContain('/lau-meme/api/daily/leaderboard?period=2026-10')
    expect(calls.every((c) => c.player === null)).toBe(true)
  })

  it('AC-DAILY-14: getPeriodLeaderboard gặp 400 thì từ chối', async () => {
    reply = () => json({ type: 'about:blank', title: 'Kỳ không hợp lệ', status: 400 }, 400)
    await expect(getPeriodLeaderboard('2026-W99')).rejects.toBeTruthy()
  })
})
