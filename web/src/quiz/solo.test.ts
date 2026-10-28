// @vitest-environment node
/// <reference types="node" />
/**
 * Acceptance tests for docs/acceptance/quiz.md, the solo answer check on the client: AC-QUIZ-17.
 * Formula (docs/api/quiz-ws.md, solo_pack): answer_hash = base64url(SHA-256("lmq1|" + salt + "|" + q + "|" + low id + "|" + high id)),
 * salt = "<room code>:<game_no>", the two ids sorted by string order. The expected values are computed here with node:crypto.
 *
 * PUBLIC SURFACE THIS FILE REQUIRES
 *   ./solo:  soloAnswerHash(salt, q, a, b): Promise<string>
 *            checkSoloAnswer(salt, q, picks: [string, string], answerHash): Promise<boolean>
 */
import { createHash, webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fold } from '../graph/crypto'
import { checkSoloAnswer, soloAnswerHash } from './solo'

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const expected = (salt: string, q: number, a: string, b: string): string => {
  const [lo, hi] = [a, b].sort()
  return sha(`lmq1|${salt}|${q}|${lo}|${hi}`)
}

const A = eid('Cay')
const B = eid('Cười')
const X = eid('Toang')
const Y = eid('Deadline')

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

describe('quiz solo hash', () => {
  it('AC-QUIZ-17: soloAnswerHash khớp công thức SHA-256 của server và không phụ thuộc thứ tự hai id', async () => {
    const salt = 'K7M2PQ:1'
    const want = expected(salt, 3, A, B)
    expect(await soloAnswerHash(salt, 3, A, B)).toBe(want)
    expect(await soloAnswerHash(salt, 3, B, A)).toBe(want)
    expect(want).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('AC-QUIZ-17: checkSoloAnswer đúng khi băm hai lựa chọn (thứ tự nào cũng được) bằng answerHash; sai khi cặp, số câu hoặc muối khác', async () => {
    const salt = 'K7M2PQ:1'
    const hash = expected(salt, 2, A, B)
    expect(await checkSoloAnswer(salt, 2, [A, B], hash)).toBe(true)
    expect(await checkSoloAnswer(salt, 2, [B, A], hash)).toBe(true)
    expect(await checkSoloAnswer(salt, 2, [A, X], hash)).toBe(false) // half right
    expect(await checkSoloAnswer(salt, 2, [X, Y], hash)).toBe(false) // both wrong
    expect(await checkSoloAnswer(salt, 3, [A, B], hash)).toBe(false) // another question
    expect(await checkSoloAnswer('K7M2PQ:2', 2, [A, B], hash)).toBe(false) // another game of the room
  })
})
