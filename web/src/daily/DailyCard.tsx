import { useState, type ReactNode } from 'react'

/** Món đặc biệt card (AC-DAILY-03/04): emoji + hint; the name stays "???" until the player makes it on the board. */
export const HIDDEN_NAME = '???'

export type DailyInfo = { element_id: string; name?: string; emoji: string; hint: string; depth: number }

/**
 * The challenge stands out (AC-DAILY-16): a "Thử thách" label and a lead line above a large emoji and hint, on the
 * accent background; once solved the label reads "Đã giải" (AC-DAILY-05). `children` are the countdown and the rest.
 * While unsolved, "Xem đáp án" asks "Xem tên món?" then shows the name (AC-DAILY-20); the label stays "Thử thách",
 * since seeing the name is not solving it. Manifests without `name` (before 2026-10-27) get no button.
 */
export function DailyCard({
  daily,
  solvedName = null,
  revealed = false,
  onReveal,
  children,
}: {
  daily: DailyInfo
  solvedName?: string | null
  revealed?: boolean
  onReveal?: () => void
  children?: ReactNode
}) {
  const [asking, setAsking] = useState(false)
  const solved = solvedName !== null
  const shownName = solvedName ?? (revealed && daily.name ? daily.name : HIDDEN_NAME)
  const canReveal = !solved && !revealed && Boolean(daily.name) && onReveal !== undefined
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
        <h2>{shownName}</h2>
        <p className="daily-hint">{daily.hint}</p>
      </div>
      <div className="daily-side">
        {children}
        {canReveal && (
          <button type="button" className="daily-reveal" onClick={() => setAsking(true)}>
            Xem đáp án
          </button>
        )}
      </div>
      {canReveal && asking && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="daily-reveal-title"
          className="modal"
          onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}
        >
          <h2 id="daily-reveal-title">Xem tên món?</h2>
          <p>Xem rồi vẫn tự ghép ra món để tính giải như thường.</p>
          <button
            type="button"
            onClick={() => {
              setAsking(false)
              onReveal?.()
            }}
          >
            Xem tên
          </button>
          <button type="button" onClick={() => setAsking(false)} autoFocus>
            Hủy
          </button>
        </div>
      )}
    </section>
  )
}
