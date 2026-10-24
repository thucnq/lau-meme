/**
 * Countdown to the next batch, from the real `batch_at` and `schedule_hours_utc` of the manifest (AC-DAILY-12):
 * production runs at 05:00 and 17:00 UTC, staging every even hour; a manifest published before the field existed
 * means [5, 17]. A late cron must never show a negative time.
 */
export const MANIFEST_POLL_MS = 60_000
export const IMMINENT_TEXT = 'Mẻ mới sắp lên'

const HOUR = 3_600_000
export const DEFAULT_SCHEDULE_HOURS_UTC: readonly number[] = [5, 17]

export type Countdown = { kind: 'counting'; remainingMs: number; text: string } | { kind: 'imminent'; text: string }
type ManifestHead = { version: number; batch_at: string; schedule_hours_utc?: readonly number[] }

/** First scheduled batch time strictly after `batchAt`. */
export function nextBatchMark(batchAt: string, hours: readonly number[] = DEFAULT_SCHEDULE_HOURS_UTC): number {
  const at = Date.parse(batchAt)
  const day = at - (at % (24 * HOUR))
  const sorted = [...hours].sort((a, b) => a - b)
  const marks = [0, 1].flatMap((d) => sorted.map((h) => day + d * 24 * HOUR + h * HOUR))
  return marks.find((m) => m > at) ?? day + 24 * HOUR + (sorted[0] ?? 0) * HOUR
}

const pad = (n: number) => String(n).padStart(2, '0')

export function getCountdown(batchAt: string, now: Date, scheduleHoursUtc?: readonly number[]): Countdown {
  const remainingMs = nextBatchMark(batchAt, scheduleHoursUtc) - now.getTime()
  if (remainingMs <= 0) return { kind: 'imminent', text: IMMINENT_TEXT }
  const s = Math.floor(remainingMs / 1000)
  return { kind: 'counting', remainingMs, text: `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` }
}

/**
 * Once the mark has passed, re-reads the manifest every 60 s and reports a new batch. Returns `stop()`.
 * Fetch errors are ignored: the next tick tries again.
 */
export function startManifestWatch(opts: {
  batchAt: string
  scheduleHoursUtc?: readonly number[]
  fetchManifest: () => Promise<ManifestHead>
  onChange: (manifest: ManifestHead) => void
}): () => void {
  let current = opts.batchAt
  let hours = opts.scheduleHoursUtc
  const timer = setInterval(() => {
    if (Date.now() < nextBatchMark(current, hours)) return
    opts.fetchManifest().then(
      (m) => {
        if (Date.parse(m.batch_at) === Date.parse(current)) return
        current = m.batch_at
        hours = m.schedule_hours_utc
        opts.onChange(m)
      },
      () => {},
    )
  }, MANIFEST_POLL_MS)
  return () => clearInterval(timer)
}
