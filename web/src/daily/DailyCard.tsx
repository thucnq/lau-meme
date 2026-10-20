import type { DailyInfo } from './challenge'
import { HIDDEN_NAME } from './challenge'

/** Món đặc biệt card (AC-DAILY-03): emoji + hint; the name stays "???" until the player makes it. */
export function DailyCard({
  daily,
  solvedName = null,
  onStart,
}: {
  daily: DailyInfo
  solvedName?: string | null
  onStart?: () => void
}) {
  return (
    <section className="daily-card" aria-label="Món đặc biệt hôm nay">
      <p className="daily-emoji" aria-hidden="true">
        {daily.emoji}
      </p>
      <h2>{solvedName ?? HIDDEN_NAME}</h2>
      <p>{daily.hint}</p>
      <button type="button" onClick={onStart}>
        Thử thách
      </button>
    </section>
  )
}
