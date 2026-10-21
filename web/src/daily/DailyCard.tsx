/** Món đặc biệt card (AC-DAILY-03/04): emoji + hint; the name stays "???" until the player makes it on the board. */
export const HIDDEN_NAME = '???'

export type DailyInfo = { element_id: string; emoji: string; hint: string; depth: number }

export function DailyCard({ daily, solvedName = null }: { daily: DailyInfo; solvedName?: string | null }) {
  return (
    <section className="daily-card" aria-label="Món đặc biệt hôm nay">
      <p className="daily-emoji" aria-hidden="true">
        {daily.emoji}
      </p>
      <h2>{solvedName ?? HIDDEN_NAME}</h2>
      {solvedName !== null && <p className="daily-solved">Đã giải</p>}
      <p>{daily.hint}</p>
    </section>
  )
}
