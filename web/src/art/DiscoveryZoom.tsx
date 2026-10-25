import { useLayoutEffect } from 'react'
import { TierBadge } from '../game/TierBadge'
import { ElementIcon } from './ElementIcon'

/** How long the zoom stays before shrinking back (open question 31). */
export const ZOOM_MS = 2500

type Props = {
  name: string
  emoji: string
  imageKey: string | null
  /** 1-5 (AC-TIER-02); the zoom only shows elements already decrypted, so the tier is no secret here */
  tier?: number
  onClose: () => void
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * First-discovery zoom (AC-ART-08): the new element large in the middle of the table, gone after 2,5 s, on a click
 * or on Esc. Not a dialog: nothing behind it is locked, so dragging and the pot keep working while it shows.
 * Remount it (key) for each new discovery so the timer starts again.
 */
export function DiscoveryZoom({ name, emoji, imageKey, tier = 1, onClose }: Props) {
  // Layout effect: Esc works from the moment the zoom is on screen.
  useLayoutEffect(() => {
    const timer = window.setTimeout(onClose, ZOOM_MS)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="discovery-zoom" data-testid="discovery-zoom" data-motion={prefersReducedMotion() ? 'static' : 'bounce'} onClick={onClose}>
      <div className={`discovery-card tier-${tier}`} data-tier={tier}>
        <span className="discovery-icon">
          <ElementIcon emoji={emoji} imageKey={imageKey} />
        </span>
        <span className="discovery-name">{name}</span>
        <TierBadge tier={tier} />
      </div>
    </div>
  )
}
