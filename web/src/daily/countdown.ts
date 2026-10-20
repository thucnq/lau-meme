/**
 * Countdown to the next batch, from the real `batch_at` of the manifest (AC-DAILY-12). Batches run at
 * 00:00 and 12:00 GMT+7 (= 17:00 and 05:00 UTC, BRD 4.2); a late cron must never show a negative time.
 */
export const MANIFEST_POLL_MS = 60_000
export const IMMINENT_TEXT = 'Mẻ mới sắp lên'

const HOUR = 3_600_000
const BATCH_HOURS_UTC = [5, 17]

export type Countdown = { kind: 'counting'; remainingMs: number; text: string } | { kind: 'imminent'; text: string }
type ManifestHead = { version: number; batch_at: string }

/** First scheduled batch time strictly after `batchAt`. */
export function nextBatchMark(batchAt: string): number {
  const at = Date.parse(batchAt)
  const day = at - (at % (24 * HOUR))
  const marks = [0, 1].flatMap((d) => BATCH_HOURS_UTC.map((h) => day + d * 24 * HOUR + h * HOUR))
  return marks.find((m) => m > at) ?? day + 24 * HOUR + (BATCH_HOURS_UTC[0] ?? 0) * HOUR
}

const pad = (n: number) => String(n).padStart(2, '0')

export function getCountdown(batchAt: string, now: Date): Countdown {
  const remainingMs = nextBatchMark(batchAt) - now.getTime()
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
  fetchManifest: () => Promise<ManifestHead>
  onChange: (manifest: ManifestHead) => void
}): () => void {
  let current = opts.batchAt
  const timer = setInterval(() => {
    if (Date.now() < nextBatchMark(current)) return
    opts.fetchManifest().then(
      (m) => {
        if (Date.parse(m.batch_at) === Date.parse(current)) return
        current = m.batch_at
        opts.onChange(m)
      },
      () => {},
    )
  }, MANIFEST_POLL_MS)
  return () => clearInterval(timer)
}
