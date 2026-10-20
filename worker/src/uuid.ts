/** UUIDv7 (RFC 9562): 48-bit Unix ms timestamp + random - sortable ids for log-like rows. */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let ts = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256
    ts = Math.floor(ts / 256)
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** GMT+7 calendar date ('YYYY-MM-DD') of an instant - the "day" of a batch (BRD 4.2). */
export function dayGmt7(epochMs: number): string {
  return new Date(epochMs + 7 * 3600_000).toISOString().slice(0, 10)
}
