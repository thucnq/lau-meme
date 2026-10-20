import { HttpError } from '../../http'
import { policyVersion } from '../content/content'

/**
 * Server-side consent check (ADR 0004, AC-PRIV-02/09): the newest `play` (or `all`) consent row of the player
 * must be a grant for the current policy version, otherwise 403. Split in statement + check so callers can put
 * the read into their own D1 batch.
 */
type ConsentRow = { purpose: string; action: string; policy_version: number }

export function playConsentStatement(db: D1Database, player: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT purpose, action, policy_version FROM consent
       WHERE player_id = ? AND purpose IN ('play', 'all')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(player)
}

export function requirePlayConsent(env: Env, row: ConsentRow | undefined): void {
  if (!row || row.purpose !== 'play' || row.action !== 'grant' || row.policy_version !== policyVersion(env)) {
    throw new HttpError(403, 'Chưa đồng ý chơi', 'Cần đồng ý với chính sách dữ liệu hiện hành trước khi gửi.')
  }
}
