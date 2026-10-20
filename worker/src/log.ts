/**
 * Logging without raw personal data (AC-PRIV-07, ADR 0004): no IP, nickname, token or request body ever reaches
 * a log line; a player id only as its mask.
 */
export function maskId(id: string): string {
  return id.slice(0, 8) + '…'
}
