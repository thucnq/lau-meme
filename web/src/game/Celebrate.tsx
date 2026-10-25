import type { CSSProperties } from 'react'

/**
 * Effect over the table when a combine gives a Vàng or Đỏ element (AC-GAME-25): a golden glow with sparkles for a
 * first Vàng, red flames, confetti and a shaking table for a first Đỏ, a short glowing rim for one already owned.
 * Reduced motion keeps only a static rim. It never takes the pointer, so dragging and the pot keep working.
 */
export type CelebrationKind = 'gold' | 'red' | 'glow'

/** Lengths in ms: Vàng ≤ 1,5 s, Đỏ ≤ 2,5 s, ghép ra lại ≤ 0,6 s. */
export const CELEBRATE_MS: Record<CelebrationKind, number> = { gold: 1400, red: 2400, glow: 500 }
const SPARKLES: Record<CelebrationKind, number> = { gold: 16, red: 28, glow: 0 }
const CONFETTI: Record<CelebrationKind, number> = { gold: 0, red: 36, glow: 0 }

// Pieces are spread on a golden-angle spiral, so the layout is the same on every run.
const GOLDEN = 137.508
const spot = (i: number, n: number, spread: number): CSSProperties =>
  ({
    '--angle': `${(i * GOLDEN) % 360}deg`,
    '--dist': `${spread * (0.45 + (0.55 * (i + 1)) / n)}rem`,
    '--delay': `${(i % 6) * 40}ms`,
  }) as CSSProperties

export function Celebrate({ kind, tier, animated }: { kind: CelebrationKind; tier: 4 | 5; animated: boolean }) {
  const sparkles = animated ? SPARKLES[kind] : 0
  const confetti = animated ? CONFETTI[kind] : 0
  const fire = animated && kind === 'red'
  return (
    <div
      className="celebrate"
      data-testid="celebrate"
      data-kind={kind}
      data-tier={tier}
      data-duration-ms={CELEBRATE_MS[kind]}
      data-particles={sparkles}
      data-confetti={confetti}
      data-fire={fire ? 'true' : undefined}
      data-motion={animated ? 'animated' : 'static'}
      aria-hidden="true"
      style={{ '--celebrate-ms': `${CELEBRATE_MS[kind]}ms` } as CSSProperties}
    >
      {kind !== 'glow' && animated && <span className="celebrate-burst" />}
      {fire && <span className="celebrate-fire" />}
      {Array.from({ length: sparkles }, (_, i) => (
        <i key={`s${i}`} className="sparkle" style={spot(i, sparkles, kind === 'red' ? 14 : 10)} />
      ))}
      {Array.from({ length: confetti }, (_, i) => (
        <i key={`c${i}`} className={`confetti c${i % 4}`} style={spot(i, confetti, 18)} />
      ))}
    </div>
  )
}
