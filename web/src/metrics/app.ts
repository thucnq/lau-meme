import { createMetrics, type MetricEvent } from './metrics'

/**
 * The page's one metrics client. Root plugs in the consented player id once the policy version is known; until
 * then (and whenever consent is missing) the source answers null and nothing is sent (AC-PRIV-02).
 */
let playerSource: () => string | null = () => null
let sessionTracked = false // one session_start per page load (StrictMode and a new policy version re-run the effect)

const metrics = createMetrics({ getPlayerId: () => playerSource() })

export function startMetrics(source: () => string | null): () => void {
  playerSource = source
  metrics.start()
  if (!sessionTracked) metrics.track({ type: 'session_start' })
  sessionTracked = true
  return () => {
    metrics.stop()
    playerSource = () => null
  }
}

const dailyStarted = new Set<number>() // versions whose card already showed in this page load (AC-METRIC-08)

/** `daily_start` once per page load for each Món đặc biệt version, however often the card mounts again. */
export function trackDailyStart(version: number): void {
  if (dailyStarted.has(version)) return
  dailyStarted.add(version)
  metrics.track({ type: 'daily_start', version })
}

export const recordCombine = (ok: boolean): void => metrics.recordCombine(ok)
export const trackEvent = (event: MetricEvent): void => metrics.track(event)
