/** Week / month keys and time text for the Món đặc biệt leaderboards (AC-DAILY-09/14). Periods follow GMT+7. */
const DAY_MS = 86_400_000
const GMT7_MS = 7 * 3_600_000
const pad2 = (n: number) => String(n).padStart(2, '0')

/** ISO week ('2026-W43') and calendar month ('2026-10') of `now` in GMT+7 - the server's period keys. */
export function currentPeriods(now: Date): { week: string; month: string } {
  const local = new Date(now.getTime() + GMT7_MS)
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  const thursday = new Date(midnight + (3 - ((local.getUTCDay() + 6) % 7)) * DAY_MS) // the ISO year is the Thursday's
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1
  return { week: `${year}-W${pad2(week)}`, month: `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}` }
}

/** '1 giờ 05 phút 12 giây'; under an hour '5 phút 12 giây' (AC-DAILY-09). */
export function formatSolveTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  return h > 0 ? `${h} giờ ${pad2(m)} phút ${pad2(s)} giây` : `${m} phút ${pad2(s)} giây`
}
