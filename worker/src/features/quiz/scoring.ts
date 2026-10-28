/** mQuiz points, ranking and the solo answer hash (AC-QUIZ-12/14/17, docs/api/quiz-ws.md). Pure functions. */

/** round(1000 × (1 − 0.5 × t / T)), t clamped to [0, T]; a wrong, half or missing answer is 0. */
export function questionPoints(ok: boolean, elapsedMs: number, seconds: number): number {
  if (!ok) return 0
  const total = seconds * 1000
  const t = Math.min(Math.max(elapsedMs, 0), total)
  return Math.round(1000 * (1 - (0.5 * t) / total))
}

export type BoardInput = { seat: number; nickname: string; score: number; correct: number; correct_ms: number }

/** Score desc, then total time of correct answers asc, then join order (seat) asc; ranks 1..n. */
export function rankPlayers<T extends BoardInput>(players: readonly T[]): Array<T & { rank: number }> {
  return [...players]
    .sort((p, q) => q.score - p.score || p.correct_ms - q.correct_ms || p.seat - q.seat)
    .map((p, i) => ({ ...p, rank: i + 1 }))
}

const enc = new TextEncoder()

/** base64url(SHA-256("lmq1|" + salt + "|" + q + "|" + lower id + "|" + higher id)). */
export async function soloAnswerHash(salt: string, q: number, a: string, b: string): Promise<string> {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`lmq1|${salt}|${q}|${lo}|${hi}`)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
