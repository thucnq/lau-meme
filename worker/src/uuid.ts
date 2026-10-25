let lastMs = -1
let seq = 0

/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp + random - sortable ids for log-like rows. Within one isolate, ids of
 * the same ms keep their creation order: rand_a holds a 12-bit counter (RFC 9562 6.2 method 1) seeded randomly.
 * The counter is per isolate and per `now`, also for an explicit past `now`; past 0xfff ids of one ms are only unique.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  if (now === lastMs && seq < 0xfff) seq++
  else seq = (bytes[7] ?? 0) & 0x7ff // room left for the next ids of this ms
  lastMs = now
  let ts = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256
    ts = Math.floor(ts / 256)
  }
  bytes[6] = 0x70 | (seq >> 8)
  bytes[7] = seq & 0xff
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** GMT+7 calendar date ('YYYY-MM-DD') of an instant - the "day" of a batch (BRD 4.2). */
export function dayGmt7(epochMs: number): string {
  return new Date(epochMs + 7 * 3600_000).toISOString().slice(0, 10)
}
