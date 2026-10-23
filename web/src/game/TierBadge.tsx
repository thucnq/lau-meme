import { TIER_NAMES } from './engine'

/** Circle, then triangle, diamond, pentagon, hexagon: one more corner per tier (docs/acceptance/tier.md). */
const SIDES = [0, 3, 4, 5, 6]

function polygon(sides: number): string {
  const pts: string[] = []
  for (let k = 0; k < sides; k++) {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / sides
    pts.push(`${(5 + 4.5 * Math.cos(a)).toFixed(2)},${(5 + 4.5 * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
}

/** The small tier shape at the bottom centre of an element (AC-TIER-02); the element carries data-tier. */
export function TierBadge({ tier }: { tier: number }) {
  return (
    <svg className="tier-badge" viewBox="0 0 10 10" role="img" aria-label={`Tier ${TIER_NAMES[tier - 1]}`}>
      {tier === 1 ? <circle cx="5" cy="5" r="4" /> : <polygon points={polygon(SIDES[tier - 1]!)} />}
    </svg>
  )
}
