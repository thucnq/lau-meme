/**
 * Daily retention job (Cron Trigger 03:00 GMT+7, ADR 0004, BRD 5.2): IP hashes > 7 days are nulled (AC-PRIV-06),
 * events > 90 days, expired rate counters, admin audit > 12 months and the consent evidence of players erased
 * more than a year ago are deleted. Logs only row counts.
 */
const DAY_MS = 86_400_000

export async function cleanup(db: D1Database, now: number): Promise<Record<string, number>> {
  const results = await db.batch([
    db.prepare('UPDATE consent SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?').bind(now - 7 * DAY_MS),
    db.prepare('DELETE FROM event WHERE received_at < ?').bind(now - 90 * DAY_MS),
    db.prepare('DELETE FROM rate_counter WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM admin_audit WHERE created_at < ?').bind(now - 365 * DAY_MS),
    // only when the erase is the player's newest row (a re-used UUID that consented again keeps its evidence)
    db
      .prepare(
        `DELETE FROM consent WHERE player_id IN (
           SELECT player_id FROM consent GROUP BY player_id
           HAVING MAX(created_at) < ?1 AND MAX(CASE WHEN action = 'erase' THEN created_at END) = MAX(created_at))`,
      )
      .bind(now - 365 * DAY_MS),
  ])
  const names = ['ip_hash_nulled', 'events', 'rate_counters', 'admin_audit', 'consents']
  const counts = Object.fromEntries(names.map((name, i) => [name, results[i]?.meta.changes ?? 0]))
  // warn: the only non-error level the lint allows; one line a day, counts only
  console.warn('cleanup', JSON.stringify(counts))
  return counts
}
