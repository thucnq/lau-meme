/**
 * AC-DAILY-09 (time format) and AC-DAILY-14 (period keys, GMT+7).
 *
 * Expected module `./period`:
 *   currentPeriods(now: Date): { week: string; month: string }   // GMT+7, ISO week '2026-W43', month '2026-10'
 *   formatSolveTime(ms: number): string
 *     >= 1 h: '1 giờ 05 phút 12 giây' (hours not padded, minutes and seconds 2 digits)
 *     < 1 h:  '5 phút 12 giây' (minutes not padded, seconds 2 digits); under a minute '0 phút 07 giây'
 */
import { describe, expect, it } from 'vitest'
import { currentPeriods, formatSolveTime } from './period'

describe('formatSolveTime', () => {
  it('AC-DAILY-09: từ 1 giờ trở lên hiện "1 giờ 05 phút 12 giây" (giờ không đệm 0, phút và giây 2 chữ số)', () => {
    expect(formatSolveTime(3_912_000)).toBe('1 giờ 05 phút 12 giây')
    expect(formatSolveTime(3_600_000)).toBe('1 giờ 00 phút 00 giây')
    expect(formatSolveTime(36_000_000)).toBe('10 giờ 00 phút 00 giây')
    expect(formatSolveTime(72_000_000)).toBe('20 giờ 00 phút 00 giây')
    expect(formatSolveTime(360_000_000)).toBe('100 giờ 00 phút 00 giây')
  })

  it('AC-DAILY-09: dưới 1 giờ bỏ phần giờ; phút đầu không đệm 0, giây 2 chữ số; dưới 1 phút là "0 phút 07 giây"', () => {
    expect(formatSolveTime(312_000)).toBe('5 phút 12 giây')
    expect(formatSolveTime(59 * 60_000 + 59_000)).toBe('59 phút 59 giây')
    expect(formatSolveTime(10 * 60_000)).toBe('10 phút 00 giây')
    expect(formatSolveTime(7_000)).toBe('0 phút 07 giây')
    expect(formatSolveTime(0)).toBe('0 phút 00 giây')
    expect(formatSolveTime(1_805_000)).toBe('30 phút 05 giây')
  })
})

describe('currentPeriods', () => {
  it('AC-DAILY-14: tuần ISO và tháng lịch tính theo GMT+7', () => {
    expect(currentPeriods(new Date('2026-10-21T03:00:00.000Z'))).toEqual({ week: '2026-W43', month: '2026-10' })
    // Sunday 25/10 23:59:59 GMT+7 is still W43; Monday 26/10 00:00:00 GMT+7 is W44
    expect(currentPeriods(new Date('2026-10-25T16:59:59.000Z')).week).toBe('2026-W43')
    expect(currentPeriods(new Date('2026-10-25T17:00:00.000Z')).week).toBe('2026-W44')
  })

  it('AC-DAILY-14: ranh giới GMT+7, không phải UTC (thứ Hai 00:30 GMT+7 vẫn là Chủ nhật theo UTC)', () => {
    expect(currentPeriods(new Date('2026-10-18T17:00:00.000Z')).week).toBe('2026-W43')
    expect(currentPeriods(new Date('2026-10-18T16:59:59.000Z')).week).toBe('2026-W42')
    // last second of October in GMT+7 vs the first second of November
    expect(currentPeriods(new Date('2026-10-31T16:59:59.000Z')).month).toBe('2026-10')
    expect(currentPeriods(new Date('2026-10-31T17:00:00.000Z')).month).toBe('2026-11')
  })

  it('AC-DAILY-14: tuần ISO qua năm: 2026 có 53 tuần; 29/12/2025 là 2026-W01', () => {
    expect(currentPeriods(new Date('2026-12-31T03:00:00.000Z'))).toEqual({ week: '2026-W53', month: '2026-12' })
    expect(currentPeriods(new Date('2027-01-02T03:00:00.000Z'))).toEqual({ week: '2026-W53', month: '2027-01' })
    expect(currentPeriods(new Date('2027-01-04T03:00:00.000Z'))).toEqual({ week: '2027-W01', month: '2027-01' })
    expect(currentPeriods(new Date('2025-12-29T03:00:00.000Z'))).toEqual({ week: '2026-W01', month: '2025-12' })
  })
})
