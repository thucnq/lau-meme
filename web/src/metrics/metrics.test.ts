// Acceptance tests for docs/acceptance/metric.md (web part: AC-METRIC-04, plus the consent gate of AC-PRIV-02).
// Expected module `./metrics` (does not exist yet):
//
//   createMetrics(opts: { getPlayerId: () => string | null }): {
//     recordCombine(ok: boolean): void   // accumulate one combine attempt (ok = combined, false = miss); never sends
//     track(event: Record<string, unknown>): void // any other allow-listed event (session_start, share, ...); queued
//     start(): void                       // registers the visibilitychange listener and the 5-minute timer
//     stop(): void                        // removes both
//   }
//
// `getPlayerId()` returns the anonymous UUID only while the visitor has consented to "play", otherwise null (then
// nothing is ever sent). Transport: navigator.sendBeacon(`<base>/api/events`, text/plain JSON body that carries
// `player_id`) when available, else fetch POST with the X-Player-Id header (keepalive). The network is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMetrics } from './metrics'

const PLAYER = '3f0a7f0e-2f52-4c7a-9f5f-0c2b1a1d9e11'
const FIVE_MIN = 5 * 60_000

type Body = { player_id?: string; events: Record<string, unknown>[] }

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsText(blob)
  })
}
async function bodyText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return readBlob(data)
  throw new Error(`unexpected beacon payload: ${String(data)}`)
}

let beacon: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

function setBeacon(fn: unknown) {
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: fn })
}

beforeEach(() => {
  vi.useFakeTimers()
  beacon = vi.fn(() => true)
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })))
  setBeacon(beacon)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  setVisibility('visible')
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setBeacon(undefined)
})

function combineMany(m: ReturnType<typeof createMetrics>, ok: number, miss: number) {
  for (let i = 0; i < ok; i++) m.recordCombine(true)
  for (let i = 0; i < miss; i++) m.recordCombine(false)
}

describe('metrics client', () => {
  it('AC-METRIC-04: ghép 40 lượt trong phiên không gửi yêu cầu nào cho từng lượt', () => {
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    combineMany(m, 30, 10)
    expect(beacon).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    m.stop()
  })

  it('AC-METRIC-04: khi trang bị ẩn (visibilitychange) gửi đúng một combine_summary có ok và miss cộng dồn qua navigator.sendBeacon', async () => {
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    combineMany(m, 30, 10)
    setVisibility('hidden')

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    const [url, data] = beacon.mock.calls[0] as [string, unknown]
    expect(url).toMatch(/\/api\/events$/)
    const body = JSON.parse(await bodyText(data)) as Body
    expect(body.player_id).toBe(PLAYER)
    const summaries = body.events.filter((e) => e.type === 'combine_summary')
    expect(summaries).toEqual([{ type: 'combine_summary', ok: 30, miss: 10 }])
    m.stop()
  })

  it('AC-METRIC-04: sendBeacon gửi thân text/plain (không cần header) và chỉ có khóa trong danh sách cho phép', async () => {
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    combineMany(m, 2, 1)
    setVisibility('hidden')
    const [, data] = beacon.mock.calls[0] as [string, unknown]
    if (data instanceof Blob) expect(data.type).toMatch(/^text\/plain/)
    const body = JSON.parse(await bodyText(data)) as Body
    expect(Object.keys(body).sort()).toEqual(['events', 'player_id'])
    m.stop()
  })

  it('AC-METRIC-04: gửi xong thì bộ đếm về 0; lần ẩn sau không có lượt ghép mới thì không gửi combine_summary rỗng', async () => {
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    combineMany(m, 4, 1)
    setVisibility('hidden')
    setVisibility('visible')
    setVisibility('hidden')
    expect(beacon).toHaveBeenCalledTimes(1)

    combineMany(m, 2, 0)
    setVisibility('visible')
    setVisibility('hidden')
    expect(beacon).toHaveBeenCalledTimes(2)
    const body = JSON.parse(await bodyText((beacon.mock.calls[1] as [string, unknown])[1])) as Body
    expect(body.events.filter((e) => e.type === 'combine_summary')).toEqual([{ type: 'combine_summary', ok: 2, miss: 0 }])
    m.stop()
  })

  it('AC-METRIC-04: trang chuyển sang visible không gửi gì', () => {
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    combineMany(m, 3, 3)
    setVisibility('visible')
    expect(beacon).not.toHaveBeenCalled()
    m.stop()
  })

  it('AC-METRIC-04: mỗi 5 phút gửi combine_summary cộng dồn (chưa đủ 5 phút thì chưa gửi)', async () => {
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    combineMany(m, 30, 10)
    vi.advanceTimersByTime(FIVE_MIN - 1000)
    expect(beacon).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(beacon).toHaveBeenCalledTimes(1)
    const body = JSON.parse(await bodyText((beacon.mock.calls[0] as [string, unknown])[1])) as Body
    expect(body.events.filter((e) => e.type === 'combine_summary')).toEqual([{ type: 'combine_summary', ok: 30, miss: 10 }])
    m.stop()
  })

  it('AC-METRIC-04: không có navigator.sendBeacon thì dùng fetch POST kèm X-Player-Id và vẫn gộp một combine_summary', async () => {
    setBeacon(undefined)
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    combineMany(m, 30, 10)
    expect(fetchMock).not.toHaveBeenCalled()
    setVisibility('hidden')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toMatch(/\/api\/events$/)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('X-Player-Id')).toBe(PLAYER)
    const body = JSON.parse(String(init.body)) as Body
    expect(body.events.filter((e) => e.type === 'combine_summary')).toEqual([{ type: 'combine_summary', ok: 30, miss: 10 }])
    m.stop()
  })

  it('AC-METRIC-04: sau stop() hết lắng nghe visibilitychange và hết hẹn giờ 5 phút', () => {
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    m.stop()
    combineMany(m, 5, 5)
    setVisibility('hidden')
    vi.advanceTimersByTime(3 * FIVE_MIN)
    expect(beacon).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('AC-METRIC-04: không đặt cookie nào khi đếm và gửi sự kiện', () => {
    const before = document.cookie
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    combineMany(m, 3, 1)
    setVisibility('hidden')
    expect(document.cookie).toBe(before)
    m.stop()
  })

  it('AC-METRIC-04: chưa đồng ý (getPlayerId trả null) thì không gửi gì dù trang ẩn hay quá 5 phút (AC-PRIV-02)', () => {
    const m = createMetrics({ getPlayerId: () => null })
    m.start()
    combineMany(m, 30, 10)
    m.track({ type: 'session_start' })
    setVisibility('hidden')
    vi.advanceTimersByTime(2 * FIVE_MIN)
    expect(beacon).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    m.stop()
  })

  describe('other events share the same batching', () => {
    it('AC-METRIC-04: sự kiện khác (session_start, share) đi chung một lô cùng combine_summary, tối đa 50 sự kiện/lô', async () => {
      const m = createMetrics({ getPlayerId: () => PLAYER })
      m.start()
      m.track({ type: 'session_start' })
      m.track({ type: 'share', card: 'daily', method: 'copy' })
      combineMany(m, 3, 2)
      setVisibility('hidden')
      expect(beacon).toHaveBeenCalledTimes(1)
      const body = JSON.parse(await bodyText((beacon.mock.calls[0] as [string, unknown])[1])) as Body
      expect(body.events.length).toBeLessThanOrEqual(50)
      expect(body.events).toEqual(
        expect.arrayContaining([
          { type: 'session_start' },
          { type: 'share', card: 'daily', method: 'copy' },
          { type: 'combine_summary', ok: 3, miss: 2 },
        ]),
      )
      m.stop()
    })
  })
})
