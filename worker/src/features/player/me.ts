import { HttpError, ResponseError, json, readJson } from '../../http'
import { fold } from '../../ids'
import { playerId } from '../../player'
import { ipHash, rateCounters, type Limit } from '../../ratelimit'
import { uuidv7 } from '../../uuid'
import { fail, int, obj, oneOf, str } from '../../validate'
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

/** POST /api/consents — append-only grant/withdraw for the current policy version. */
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
  // Withdrawing the display consent takes the nickname off every public list at once.
  if (purpose === 'nickname' && action === 'withdraw')
    writes.push(
      env.DB.prepare('UPDATE player SET nickname = NULL, nickname_fold = NULL, updated_at = ? WHERE id = ?').bind(now, player),
    )
  await env.DB.batch(writes)
  return json({ purpose, action, policy_version: version, created_at: iso(now) }, { status: 201 })
}

/** PUT /api/me/nickname — needs both `play` and `nickname` consent (AC-PRIV-03); word filters come with DISC. */
export async function putNickname(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const b = obj(await readJson(req), 'body', ['nickname'])
  const nickname = str(b.nickname, 'nickname', 100).trim()
  if ([...nickname].length < 2 || [...nickname].length > 20 || !NICKNAME.test(nickname))
    fail('nickname: 2–20 ký tự, chỉ chữ, số, khoảng trắng, _ và -')
  const db = env.DB
  const [play, nick] = await limited(req, env, player, [
    playConsentStatement(db, player),
    nicknameConsentStatement(db, player),
  ])
  requirePlayConsent(env, play?.results[0] as ConsentRow | undefined)
  requireNicknameConsent(env, nick?.results[0] as ConsentRow | undefined)
  const now = Date.now()
  try {
    await db
      .prepare(
        `INSERT INTO player (id, nickname, nickname_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET nickname = excluded.nickname, nickname_fold = excluded.nickname_fold,
           updated_at = excluded.updated_at`,
      )
      .bind(player, nickname, fold(nickname), now, now)
      .run()
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) throw new HttpError(409, 'Nickname đã có người dùng')
    throw err
  }
  return json({ nickname })
}

type DailyRow = { version: number; steps: number; submitted_at: number; rank: number }
type StreakRow = { current: number; longest: number; last_day: string }

/** GET /api/me — only the data of the UUID sent; an unknown UUID gets the empty structure (AC-PRIV-08). */
export async function getMyData(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const db = env.DB
  const [nick, discoveries, daily, streak, reports, votes, consents, events] = await limited(req, env, player, [
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
  ])
  const s = rows<StreakRow>(streak)[0]
  const myStreak = { current: s?.current ?? 0, longest: s?.longest ?? 0 }
  return json({
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
  })
}

/**
 * DELETE /api/me — idempotent erasure (AC-PRIV-05): personal rows go; discoveries and reports stay without the
 * UUID (reports still count); consent evidence stays and gets an `erase` row (kept 1 year, cleanup.ts).
 */
export async function deleteMyData(req: Request, env: Env): Promise<Response> {
  const player = playerId(req)
  const db = env.DB
  await limited(req, env, player)
  const now = Date.now()
  await db.batch([
    db.prepare('DELETE FROM player WHERE id = ?').bind(player),
    db.prepare('DELETE FROM daily_result WHERE player_id = ?').bind(player),
    db.prepare('DELETE FROM streak WHERE player_id = ?').bind(player),
    db.prepare('DELETE FROM vote WHERE player_id = ?').bind(player),
    db.prepare('DELETE FROM event WHERE player_id = ?').bind(player),
    db.prepare('UPDATE discovery SET player_id = NULL WHERE player_id = ?').bind(player),
    db.prepare('UPDATE report SET player_id = NULL WHERE player_id = ?').bind(player),
    db
      .prepare(
        `INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at)
         VALUES (?, ?, 'all', 'erase', ?, ?, 'web', ?)`,
      )
      .bind(uuidv7(now), player, policyVersion(env), await ipHash(req, env), now),
  ])
  return new Response(null, { status: 204 })
}
