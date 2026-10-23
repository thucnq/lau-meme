import { withBase } from '../base'

/**
 * Anonymous play events (AC-METRIC-02/04). Nothing is sent per combine: attempts are counted and go out with the
 * queued events in one batch when the page is hidden or every 5 minutes, through `navigator.sendBeacon` when the
 * browser has it. Without consent (`getPlayerId()` is null) nothing ever leaves the browser (AC-PRIV-02).
 */
export type MetricEvent =
  | { type: 'session_start' }
  | { type: 'daily_start'; version: number }
  | { type: 'daily_complete'; version: number; steps: number }
  | { type: 'share'; card: 'daily' | 'discovery'; method: 'copy' | 'native' | 'image' }
  | { type: 'report'; target: 'element' | 'image' }
  | { type: 'feedback'; value: 'ngon' | 'nhat' }

export type Metrics = {
  recordCombine(ok: boolean): void
  track(event: MetricEvent): void
  start(): void
  stop(): void
}

const FLUSH_MS = 5 * 60_000
const MAX_BATCH = 50 // contract EventBatch.maxItems
const MAX_COUNT = 10_000 // contract combine_summary.ok/miss maximum
const MAX_QUEUE = 200 // 4 batches per flush, well under the per-IP limit; beyond it the oldest events go first

export function createMetrics(opts: { getPlayerId: () => string | null }): Metrics {
  const queue: MetricEvent[] = []
  let ok = 0
  let miss = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function flush(): void {
    const player = opts.getPlayerId()
    const events: Array<MetricEvent | { type: 'combine_summary'; ok: number; miss: number }> = queue.splice(0)
    if (ok + miss > 0) events.push({ type: 'combine_summary', ok, miss })
    ok = 0
    miss = 0
    // without consent the counts are dropped, never kept for later
    if (player === null) return
    for (let i = 0; i < events.length; i += MAX_BATCH) send(player, events.slice(i, i + MAX_BATCH))
  }

  function send(player: string, events: unknown[]): void {
    const url = withBase('api/events')
    if (typeof navigator.sendBeacon === 'function') {
      // sendBeacon cannot set headers: a string body goes as text/plain with the id inside (ADR 0004). `true` only
      // means queued: a refused batch (4xx/429) is lost, accepted for best-effort metrics.
      if (navigator.sendBeacon(url, JSON.stringify({ player_id: player, events }))) return
    }
    void fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Player-Id': player },
      body: JSON.stringify({ events }),
    }).catch(() => {
      // metrics are best effort: a lost batch never bothers the player
    })
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush()
  }

  return {
    recordCombine(success) {
      if (success) ok = Math.min(ok + 1, MAX_COUNT)
      else miss = Math.min(miss + 1, MAX_COUNT)
    },
    track(event) {
      queue.push(event)
      if (queue.length > MAX_QUEUE) queue.shift()
    },
    start() {
      if (timer !== null) return
      document.addEventListener('visibilitychange', onVisibility)
      timer = setInterval(flush, FLUSH_MS)
    },
    stop() {
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}
