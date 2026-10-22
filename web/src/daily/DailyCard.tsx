import type { ReactNode } from 'react'

/** Món đặc biệt card (AC-DAILY-03/04): emoji + hint; the name stays "???" until the player makes it on the board. */
export const HIDDEN_NAME = '???'

export type DailyInfo = { element_id: string; emoji: string; hint: string; depth: number }

/**
 * The challenge stands out (AC-DAILY-16): a "Thử thách" label and a lead line above a large emoji and hint, on the
 * accent background; once solved the label reads "Đã giải" (AC-DAILY-05). `children` are the countdown and the rest.
 */
export function DailyCard({
  daily,
  solvedName = null,
  children,
}: {
  daily: DailyInfo
  solvedName?: string | null
  children?: ReactNode
}) {
  const solved = solvedName !== null
  return (
    <section className="daily-card" aria-label="Món đặc biệt hôm nay">
      <div className="daily-head">
        {solved ? (
          <p className="daily-label daily-solved">Đã giải</p>
        ) : (
          <>
            <p className="daily-label">Thử thách</p>
            <p className="daily-lead">Ghép ra món bí ẩn này trên bàn lẩu</p>
          </>
        )}
      </div>
      <div className="daily-dish">
        <p className="daily-emoji" aria-hidden="true">
          {daily.emoji}
        </p>
        <h2>{solvedName ?? HIDDEN_NAME}</h2>
        <p className="daily-hint">{daily.hint}</p>
      </div>
      <div className="daily-side">{children}</div>
    </section>
  )
}
