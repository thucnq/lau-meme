import { HttpError, ResponseError, json, readJson } from '../../http'
import { fold } from '../../ids'
import { playerId } from '../../player'
import { ipHash, rateCounters, type Limit } from '../../ratelimit'
import { clearedCookie, hasSessionCookie, readSession, sessionCookie } from '../../session'
import { uuidv7 } from '../../uuid'
import { fail, int, obj, oneOf } from '../../validate'
import { accountStreakStatement, liveCurrent } from '../daily/daily'
import { contribution, myContributionsStatement, type ContributionRow } from '../contrib/contrib'
import { bannedKey } from '../disc/disc'
import { policyVersion } from '../content/content'
import {
  type ConsentRow,
  nicknameConsentStatement, playConsentStatement, requireNicknameConsent, requirePlayConsent } from './consent'

/** Consent, nickname and the player's own data (AC-PRIV-03/04/05/08, BRD 5.2). */
const PLAYER_LIMIT: Limit = { scope: 'player', windowMs: 60_000, perPlayer: 10, perIp: 30 } // open question #10
const NICKNAME = /^[\p{L}\p{M}\p{N} _-]+$/u

const iso = (ms: number) => new Date(ms).toISOString()
const rows = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[]

/**
 * Runs the request's rate counters with the read-only `statements` in one D1 round trip; throws the 429 when over
 * a limit. Writes go in a later batch, so an over-limit request writes nothing but its counter (ADR 0004).
 */
async function limited(req: Request, env: Env, player: string, statements: D1PreparedStatement[] = []): Promise<D1Result[]> {
  const limit = await rateCounters(req, env, PLAYER_LIMIT, player)
  const results = await env.DB.batch([...limit.statements, ...statements])
  const over = limit.verdict(results)
  if (over) throw new ResponseError(over)
  return results.slice(limit.statements.length)
}

/** POST /api/consents - append-only grant/withdraw for the current policy version. */
export async function createConsent(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const b = obj(await readJson(req), 'body', ['purpose', 'action', 'policy_version'])
  const purpose = oneOf(b.purpose, 'purpose', ['play', 'nickname'] as const)
  const action = oneOf(b.action, 'action', ['grant', 'withdraw'] as const)
  const version = int(b.policy_version, 'policy_version', 1)
  if (version !== policyVersion(env)) fail('policy_version: không phải version chính sách hiện hành')
  await limited(req, env, player)
  const now = Date.now()
  const writes = [
    env.DB.prepare(
      `INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'web', ?)`,
    ).bind(uuidv7(now), player, purpose, action, version, await ipHash(req, env), now),
  ]
  // Withdrawing the display consent takes the nickname off every public list at once - the UUID's and that of the
  // account it is linked to, from whichever device (AC-PRIV-03, AC-AUTH-04).
  if (purpose === 'nickname' && action === 'withdraw')
    writes.push(
      env.DB.prepare('UPDATE player SET nickname = NULL, nickname_fold = NULL, updated_at = ? WHERE id = ?').bind(now, player),
      env.DB.prepare(
        `UPDATE account SET nickname = NULL, nickname_fold = NULL, updated_at = ?
         WHERE id IN (SELECT account_id FROM account_player WHERE player_id = ?)`,
      ).bind(now, player),
    )
  await env.DB.batch(writes)
  return json({ purpose, action, policy_version: version, created_at: iso(now) }, { status: 201 })
}

const INVALID_NICKNAME = 'Nickname không hợp lệ' // never says which word was refused (AC-DISC-03)

/**
 * PUT /api/me/nickname - needs both `play` and `nickname` consent (AC-PRIV-03); 2–20 allowed characters and no
 * banned term or blocked alias inside its letters and digits (AC-DISC-02/03, AC-MOD-06).
 */
export async function putNickname(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const b = await readJson(req)
  const raw = b.nickname
  if (Object.keys(b).some((k) => k !== 'nickname') || typeof raw !== 'string' || raw.length > 100)
    throw new HttpError(400, 'Dữ liệu không hợp lệ', 'nickname: chuỗi tối đa 100 ký tự')
  const nickname = raw.trim()
  const length = [...nickname].length
  if (length < 2 || length > 20 || !NICKNAME.test(nickname)) throw new HttpError(422, INVALID_NICKNAME)
  const db = env.DB
  const [play, nick, banned] = await limited(req, env, player, [
    playConsentStatement(db, player),
    nicknameConsentStatement(db, player),
    db.prepare('SELECT DISTINCT term_fold FROM banned_term'),
  ])
  requirePlayConsent(env, play?.results[0] as ConsentRow | undefined)
  requireNicknameConsent(env, nick?.results[0] as ConsentRow | undefined)
  const key = bannedKey(nickname)
  for (const { term_fold } of rows<{ term_fold: string }>(banned)) {
    const term = bannedKey(term_fold)
    if (term !== '' && key.includes(term)) throw new HttpError(422, INVALID_NICKNAME)
  }
  const now = Date.now()
  const nickFold = fold(nickname)
  // Signed in: the account's nickname (leaderboards, every device - AC-AUTH-04); otherwise the UUID's. A fold is
  // taken when another account or a UUID not linked to the same account holds it (checked in the write itself).
  const session = await readSession(req, env)
  const write = session
    ? db
        .prepare(
          `UPDATE account SET nickname = ?, nickname_fold = ?, updated_at = ? WHERE id = ? AND NOT EXISTS (
             SELECT 1 FROM player p WHERE p.nickname_fold = ?
               AND p.id NOT IN (SELECT player_id FROM account_player WHERE account_id = ?))
           RETURNING id`,
        )
        .bind(nickname, nickFold, now, session.accountId, nickFold, session.accountId)
    : db
        .prepare(
          `INSERT INTO player (id, nickname, nickname_fold, created_at, updated_at)
           SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
             SELECT 1 FROM account a WHERE a.nickname_fold = ?
               AND a.id NOT IN (SELECT account_id FROM account_player WHERE player_id = ?))
           ON CONFLICT (id) DO UPDATE SET nickname = excluded.nickname, nickname_fold = excluded.nickname_fold,
             updated_at = excluded.updated_at
           RETURNING id`,
        )
        .bind(player, nickname, nickFold, now, now, nickFold, player)
  let written: { id: string } | null
  try {
    written = await write.first<{ id: string }>()
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) throw new HttpError(409, 'Nickname đã có người dùng')
    throw err
  }
  if (!written) throw new HttpError(409, 'Nickname đã có người dùng')
  const headers: Record<string, string> = session ? { 'Set-Cookie': sessionCookie(env, session.token) } : {}
  return json({ nickname }, { headers })
}

type DailyRow = { version: number; steps: number; submitted_at: number; rank: number }
type StreakRow = { current: number; longest: number; last_day: string }

/** GET /api/me - only the data of the UUID sent; an unknown UUID gets the empty structure (AC-PRIV-08). */
export async function getMyData(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const db = env.DB
  const session = await readSession(req, env)
  const accountId = session?.accountId ?? ''
  const now = Date.now()
  const [nick, discoveries, daily, streak, reports, votes, consents, events, account, sessions, entries, accStreak, plate, contribs] =
    await limited(req, env, player, [
    db.prepare('SELECT nickname FROM player WHERE id = ?').bind(player),
    db.prepare('SELECT element_id, discovered_at FROM discovery WHERE player_id = ? ORDER BY discovered_at').bind(player),
    db
      .prepare(
        `SELECT me.version, me.steps, me.submitted_at,
           (SELECT COUNT(*) + 1 FROM daily_result d WHERE d.version = me.version
              AND (d.steps < me.steps OR (d.steps = me.steps AND (d.submitted_at < me.submitted_at
                   OR (d.submitted_at = me.submitted_at AND d.rowid < me.rowid))))) AS rank
         FROM daily_result me WHERE me.player_id = ? ORDER BY me.version`,
      )
      .bind(player),
    db.prepare('SELECT current, longest, last_day FROM streak WHERE player_id = ?').bind(player),
    db.prepare('SELECT kind, target_id, reason, created_at FROM report WHERE player_id = ? ORDER BY created_at').bind(player),
    db.prepare('SELECT recipe_id, value, updated_at FROM vote WHERE player_id = ? ORDER BY updated_at').bind(player),
    db
      .prepare('SELECT purpose, action, policy_version, created_at FROM consent WHERE player_id = ? ORDER BY created_at, id')
      .bind(player),
    db.prepare('SELECT type, COUNT(*) AS n FROM event WHERE player_id = ? GROUP BY type').bind(player),
    // the signed-in account (AC-AUTH-06): never its sub hash
    db.prepare('SELECT nickname, created_at FROM account WHERE id = ?').bind(accountId),
    db.prepare('SELECT COUNT(*) AS n FROM session WHERE account_id = ? AND expires_at > ?').bind(accountId, now),
    db
      .prepare(
        `SELECT me.version, me.solve_ms, me.solved_at,
           (SELECT COUNT(*) + 1 FROM daily_entry d WHERE d.version = me.version
              AND (d.solved_at < me.solved_at OR (d.solved_at = me.solved_at AND d.seq < me.seq))) AS rank
         FROM daily_entry me WHERE me.account_id = ? ORDER BY me.version`,
      )
      .bind(accountId),
    accountStreakStatement(db, accountId),
    db.prepare('SELECT element_id, found_at FROM account_element WHERE account_id = ? ORDER BY found_at, element_id').bind(accountId),
    myContributionsStatement(db, accountId),
  ])
  const acc = rows<{ nickname: string | null; created_at: number }>(account)[0]
  const accRow = rows<StreakRow & { reached_at: number }>(accStreak)[0] ?? null
  const accountStreak = { current: liveCurrent(accRow, now), longest: accRow?.longest ?? 0 }
  const s = rows<StreakRow>(streak)[0]
  const myStreak = { current: s?.current ?? 0, longest: s?.longest ?? 0 }
  return json(
    {
    nickname: rows<{ nickname: string | null }>(nick)[0]?.nickname ?? null,
    discoveries: rows<{ element_id: string; discovered_at: number }>(discoveries).map((r) => ({
      element_id: r.element_id,
      discovered_at: iso(r.discovered_at),
    })),
    daily_results: rows<DailyRow>(daily).map((r) => ({
      version: r.version,
      steps: r.steps,
      rank: r.rank,
      streak: myStreak,
      submitted_at: iso(r.submitted_at),
    })),
    streak: myStreak,
    reports: rows<{ kind: string; target_id: string; reason: string; created_at: number }>(reports).map((r) => ({
      target: r.kind,
      id: r.target_id,
      reason: r.reason,
      created_at: iso(r.created_at),
    })),
    votes: rows<{ recipe_id: string; value: string; updated_at: number }>(votes).map((r) => ({
      ...r,
      updated_at: iso(r.updated_at),
    })),
    consents: rows<{ purpose: string; action: string; policy_version: number; created_at: number }>(consents).map(
      (r) => ({ ...r, created_at: iso(r.created_at) }),
    ),
    event_counts: Object.fromEntries(rows<{ type: string; n: number }>(events).map((r) => [r.type, r.n])),
    account:
      session && acc
        ? {
            created_at: iso(acc.created_at),
            open_sessions: rows<{ n: number }>(sessions)[0]?.n ?? 0,
            nickname: acc.nickname,
            daily_results: rows<{ version: number; solve_ms: number; solved_at: number; rank: number }>(entries).map(
              (r) => ({
                version: r.version,
                solve_ms: r.solve_ms,
                rank: r.rank,
                streak: accountStreak,
                solved_at: iso(r.solved_at),
              }),
            ),
            streak: accountStreak,
            // Đĩa of the account (AC-SYNC-10)
            plate: rows<{ element_id: string; found_at: number }>(plate).map((r) => ({
              element_id: r.element_id,
              found_at: iso(r.found_at),
            })),
            // every proposal of the account with what it sent and its status (AC-CONTRIB-12)
            contributions: rows<ContributionRow>(contribs).map(contribution),
          }
        : null,
    },
    { headers: session ? { 'Set-Cookie': sessionCookie(env, session.token) } : {} },
  )
}

/** AC-PRIV-05 erasure of one UUID: personal rows go, discoveries/reports lose the UUID, consent gets `erase`. */
function eraseStatements(db: D1Database, player: string, version: number, ip: string | null, now: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM player WHERE id = ?').bind(player),
    db.prepare('DELETE FROM daily_result WHERE player_id = ?').bind(player),
    db.prepare('DELETE FROM streak WHERE player_id = ?').bind(player),
    db.prepare('DELETE FROM vote WHERE player_id = ?').bind(player),
    db.prepare('DELETE FROM event WHERE player_id = ?').bind(player),
    db.prepare('DELETE FROM account_player WHERE player_id = ?').bind(player),
    db.prepare('UPDATE discovery SET player_id = NULL WHERE player_id = ?').bind(player),
    db.prepare('UPDATE report SET player_id = NULL WHERE player_id = ?').bind(player),
    db
      .prepare(
        `INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at)
         VALUES (?, ?, 'all', 'erase', ?, ?, 'web', ?)`,
      )
      .bind(uuidv7(now), player, version, ip, now),
  ]
}

/**
 * DELETE /api/me - idempotent erasure (AC-PRIV-05): personal rows go; discoveries and reports stay without the
 * UUID (reports still count); consent evidence stays and gets an `erase` row (kept 1 year, cleanup.ts). Signed in,
 * the account goes too (AC-AUTH-06): sub hash, sessions, nickname, Daily results, streak, plate (AC-SYNC-10), and every linked UUID is
 * erased the same way.
 */
export async function deleteMyData(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const db = env.DB
  await limited(req, env, player)
  const session = await readSession(req, env)
  const linked = session
    ? rows<{ player_id: string }>(
        await db.prepare('SELECT player_id FROM account_player WHERE account_id = ?').bind(session.accountId).all(),
      ).map((r) => r.player_id)
    : []
  const now = Date.now()
  const ip = await ipHash(req, env)
  const statements = [...new Set([player, ...linked])].flatMap((p) => eraseStatements(db, p, policyVersion(env), ip, now))
  if (session) {
    const id = session.accountId
    for (const table of ['session', 'account_player', 'daily_entry', 'account_streak', 'account_element'] as const)
      statements.push(db.prepare(ACCOUNT_DELETES[table]).bind(id))
    // AC-CONTRIB-12: pending proposals go; approved/rejected ones stay unlinked, and the account's entries in every
    // kept creators snapshot become null (shown as "Thực khách ẩn danh")
    statements.push(
      db
        .prepare(
          `UPDATE batch_content SET creators_json = (
             SELECT json_group_object(j.key, CASE WHEN j.key IN (SELECT element_id FROM contribution WHERE account_id = ?1
               AND element_id IS NOT NULL) THEN NULL ELSE j.value END) FROM json_each(batch_content.creators_json) j)
           WHERE creators_json IS NOT NULL AND creators_json <> '{}'`,
        )
        .bind(id),
      db.prepare("DELETE FROM contribution WHERE account_id = ? AND status = 'pending'").bind(id),
      db.prepare('UPDATE contribution SET account_id = NULL WHERE account_id = ?').bind(id),
      db.prepare('DELETE FROM account WHERE id = ?').bind(id),
    )
  }
  await db.batch(statements)
  const headers: Record<string, string> = hasSessionCookie(req) ? { 'Set-Cookie': clearedCookie(env) } : {}
  return new Response(null, { status: 204, headers })
}

const ACCOUNT_DELETES = {
  session: 'DELETE FROM session WHERE account_id = ?',
  account_player: 'DELETE FROM account_player WHERE account_id = ?',
  daily_entry: 'DELETE FROM daily_entry WHERE account_id = ?',
  account_streak: 'DELETE FROM account_streak WHERE account_id = ?',
  account_element: 'DELETE FROM account_element WHERE account_id = ?',
} as const
