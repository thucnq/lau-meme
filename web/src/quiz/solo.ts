/** Solo mQuiz answer check (AC-QUIZ-17, docs/api/quiz-ws.md `solo_pack`): the same hash as the Worker computes. */
const enc = new TextEncoder()

/** base64url(SHA-256("lmq1|" + salt + "|" + q + "|" + lower id + "|" + higher id)). */
export async function soloAnswerHash(salt: string, q: number, a: string, b: string): Promise<string> {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`lmq1|${salt}|${q}|${lo}|${hi}`)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function checkSoloAnswer(salt: string, q: number, picks: [string, string], answerHash: string): Promise<boolean> {
  return (await soloAnswerHash(salt, q, picks[0], picks[1])) === answerHash
}

/** The pair of option ids whose hash is the answer, found by trying the 6 pairs (to show it after a question). */
export async function soloCorrectPair(salt: string, q: number, ids: string[], answerHash: string): Promise<[string, string] | null> {
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) if (await checkSoloAnswer(salt, q, [ids[i]!, ids[j]!], answerHash)) return [ids[i]!, ids[j]!]
  return null
}
