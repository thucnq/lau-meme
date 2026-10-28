/**
 * Daily retention job (Cron Trigger 03:00 GMT+7, ADR 0004, BRD 5.2): IP hashes > 7 days are nulled (AC-PRIV-06),
 * events and mQuiz history > 90 days, expired rate counters and sessions, admin audit (every audit table) > 12 months and the consent evidence of players erased
 * more than a year ago are deleted. Logs only row counts.
 */
const DAY_MS = 86_400_000

export async function cleanup(db: D1Database, now: number): Promise<Record<string, number>> {
  const results = await db.batch([
    db.prepare('UPDATE consent SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?').bind(now - 7 * DAY_MS),
    db.prepare('DELETE FROM event WHERE received_at < ?').bind(now - 90 * DAY_MS),
    db.prepare('DELETE FROM rate_counter WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM session WHERE expires_at <= ?').bind(now), // 90 days unused (ADR 0010)
    db.prepare('DELETE FROM admin_audit WHERE created_at < ?').bind(now - 365 * DAY_MS),
    // the other admin audit tables, kept 12 months like admin_audit (AC-ADMIN-09; ADR 0013, 0016, 0019)
    db.prepare('DELETE FROM admin_change WHERE created_at < ?').bind(now - 365 * DAY_MS),
    db.prepare('DELETE FROM admin_image_change WHERE created_at < ?').bind(now - 365 * DAY_MS),
    db.prepare('DELETE FROM daily_pin_change WHERE created_at < ?').bind(now - 365 * DAY_MS),
    // mQuiz history 90 days (AC-QUIZ-21), then the codes of closed rooms with no game left
    db.prepare('DELETE FROM quiz_player WHERE game_id IN (SELECT id FROM quiz_game WHERE finished_at < ?)').bind(now - 90 * DAY_MS),
    db.prepare('DELETE FROM quiz_game WHERE finished_at < ?').bind(now - 90 * DAY_MS),
    db.prepare(
      'DELETE FROM quiz_room WHERE closed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quiz_game WHERE room_code = quiz_room.code)',
    ),
    // only when the erase is the player's newest row (a re-used UUID that consented again keeps its evidence)
    db
      .prepare(
        `DELETE FROM consent WHERE player_id IN (
           SELECT player_id FROM consent GROUP BY player_id
           HAVING MAX(created_at) < ?1 AND MAX(CASE WHEN action = 'erase' THEN created_at END) = MAX(created_at))`,
      )
      .bind(now - 365 * DAY_MS),
  ])
  // one name per statement above, in order
  const names = [
    'ip_hash_nulled',
    'events',
    'rate_counters',
    'sessions',
    'admin_audit',
    'admin_changes',
    'admin_image_changes',
    'daily_pin_changes',
    'quiz_players',
    'quiz_games',
    'quiz_rooms',
    'consents',
  ]
  const counts = Object.fromEntries(names.map((name, i) => [name, results[i]?.meta.changes ?? 0]))
  // warn: the only non-error level the lint allows; one line a day, counts only
  console.warn('cleanup', JSON.stringify(counts))
  return counts
}
