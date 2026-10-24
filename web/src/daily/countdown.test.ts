// @vitest-environment jsdom
// AC-DAILY-12: đồng hồ đếm ngược theo manifest thật.
// Expected module `./countdown`:
//   getCountdown(batchAt: string, now: Date):
//     | { kind: 'counting'; remainingMs: number; text: string }
//     | { kind: 'imminent'; text: 'Mẻ mới sắp lên' }
//   startManifestWatch(opts: {
//     batchAt: string
//     fetchManifest: () => Promise<{ version: number; batch_at: string }>
//     onChange: (manifest: { version: number; batch_at: string }) => void
//   }): () => void   // returns stop(); polls every MANIFEST_POLL_MS (60 000) once the mark has passed
//   MANIFEST_POLL_MS = 60_000
// Cập nhật 2026-10-23: lịch mẻ lấy từ manifest `schedule_hours_utc`, không đóng cứng 5/17 trong client.
//   getCountdown(batchAt, now, scheduleHoursUtc?: readonly number[])   // thiếu -> mặc định [5, 17] (manifest cũ)
//   startManifestWatch opts có thêm `scheduleHoursUtc?: readonly number[]`
//   Mốc kế tiếp = giờ đầu tiên (UTC, phút 00) trong lịch nằm sau batch_at; hết lịch trong ngày thì giờ đầu của ngày sau.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MANIFEST_POLL_MS, getCountdown, startManifestWatch } from './countdown'

const BATCH_AT = '2026-10-20T17:03:00.000Z' // cron trễ 3 phút so với mốc 17:00 UTC
const HOUR = 3_600_000

describe('countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('AC-DAILY-12: lúc 17:30 UTC đếm tới mốc 05:00 UTC kế tiếp sau batch_at (không phải batch_at + 12 giờ)', () => {
    const c = getCountdown(BATCH_AT, new Date('2026-10-20T17:30:00.000Z'))
    expect(c.kind).toBe('counting')
    if (c.kind !== 'counting') return
    expect(c.remainingMs).toBe(11.5 * HOUR)
    expect(c.text).toMatch(/11/)
    expect(c.text).toMatch(/30/)
  })

  it('AC-DAILY-12: quá mốc mà manifest chưa đổi thì hiện "Mẻ mới sắp lên", không bao giờ hiện số âm', () => {
    for (const now of ['2026-10-21T05:00:00.000Z', '2026-10-21T05:20:00.000Z', '2026-10-21T09:00:00.000Z']) {
      const c = getCountdown(BATCH_AT, new Date(now))
      expect(c.kind, now).toBe('imminent')
      expect(c.text, now).toBe('Mẻ mới sắp lên')
      expect(c.text, now).not.toMatch(/-/)
    }
    const before = getCountdown(BATCH_AT, new Date('2026-10-21T04:59:59.000Z'))
    expect(before.kind).toBe('counting')
    if (before.kind === 'counting') expect(before.remainingMs).toBe(1000)
  })

  it('AC-DAILY-12: lúc 05:20 UTC hôm sau client kiểm manifest lại mỗi 60 s và báo khi manifest đổi', async () => {
    expect(MANIFEST_POLL_MS).toBe(60_000)
    vi.setSystemTime(new Date('2026-10-21T05:20:00.000Z'))
    const same = { version: 4, batch_at: BATCH_AT }
    const next = { version: 5, batch_at: '2026-10-21T05:04:00.000Z' }
    const fetchManifest = vi.fn(async () => same)
    const onChange = vi.fn()
    const stop = startManifestWatch({ batchAt: BATCH_AT, fetchManifest, onChange })

    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(fetchManifest.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(fetchManifest.mock.calls.length).toBeLessThanOrEqual(4) // có thể kiểm ngay lúc bắt đầu
    expect(onChange).not.toHaveBeenCalled() // manifest chưa đổi

    fetchManifest.mockImplementation(async () => next)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onChange).toHaveBeenCalledWith(next)

    stop()
    const calls = fetchManifest.mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(fetchManifest.mock.calls.length).toBe(calls)
  })

  it('AC-DAILY-12: production nêu rõ schedule_hours_utc [5, 17] cho kết quả như mặc định', () => {
    const now = new Date('2026-10-20T17:30:00.000Z')
    const c = getCountdown(BATCH_AT, now, [5, 17])
    expect(c.kind).toBe('counting')
    if (c.kind === 'counting') expect(c.remainingMs).toBe(11.5 * HOUR)
    const imminent = getCountdown(BATCH_AT, new Date('2026-10-21T05:20:00.000Z'), [5, 17])
    expect(imminent.kind).toBe('imminent')
  })

  it('AC-DAILY-12: manifest staging (batch_at 08:07, lịch giờ chẵn) lúc 08:30 UTC đếm tới 10:00 UTC', () => {
    const even = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
    const c = getCountdown('2026-10-20T08:07:00.000Z', new Date('2026-10-20T08:30:00.000Z'), even)
    expect(c.kind).toBe('counting')
    if (c.kind !== 'counting') return
    expect(c.remainingMs).toBe(1.5 * HOUR)
    // quá mốc 10:00 mà manifest chưa đổi -> "Mẻ mới sắp lên"
    for (const now of ['2026-10-20T10:00:00.000Z', '2026-10-20T10:20:00.000Z']) {
      const late = getCountdown('2026-10-20T08:07:00.000Z', new Date(now), even)
      expect(late.kind, now).toBe('imminent')
      expect(late.text, now).toBe('Mẻ mới sắp lên')
    }
  })

  it('AC-DAILY-12: giờ không đóng cứng trong client - lịch tùy ý [3, 15] và lịch một giờ [9] đều theo manifest', () => {
    const a = getCountdown('2026-10-20T15:02:00.000Z', new Date('2026-10-20T15:30:00.000Z'), [3, 15])
    expect(a.kind).toBe('counting')
    if (a.kind === 'counting') expect(a.remainingMs).toBe(11.5 * HOUR) // tới 03:00 UTC hôm sau
    const b = getCountdown('2026-10-20T09:01:00.000Z', new Date('2026-10-20T10:00:00.000Z'), [9])
    expect(b.kind).toBe('counting')
    if (b.kind === 'counting') expect(b.remainingMs).toBe(23 * HOUR) // tới 09:00 UTC hôm sau
  })

  it('AC-DAILY-12: manifest staging quá mốc thì kiểm lại mỗi 60 s theo lịch của manifest và báo khi đổi', async () => {
    const even = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
    const staged = '2026-10-20T08:07:00.000Z'
    vi.setSystemTime(new Date('2026-10-20T10:20:00.000Z'))
    const next = { version: 9, batch_at: '2026-10-20T10:05:00.000Z', schedule_hours_utc: even }
    const fetchManifest = vi.fn(async () => ({ version: 8, batch_at: staged, schedule_hours_utc: even }))
    const onChange = vi.fn()
    const stop = startManifestWatch({ batchAt: staged, scheduleHoursUtc: even, fetchManifest, onChange })
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(fetchManifest.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(onChange).not.toHaveBeenCalled()
    fetchManifest.mockImplementation(async () => next)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onChange).toHaveBeenCalledWith(next)
    stop()
  })
})
