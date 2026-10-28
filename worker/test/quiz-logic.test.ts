// Acceptance tests for docs/acceptance/quiz.md, pure functions of the worker:
//   AC-QUIZ-08  generateQuiz: question invariants, determinism, blocked table
//   AC-QUIZ-09  generateQuiz: short pool (K' = 12 for 15 asked, K' = 3, nothing)
//   AC-QUIZ-12  questionPoints: round(1000 * (1 - 0.5 * t / T)), clamped, wrong = 0
//   AC-QUIZ-14/15  rankPlayers: score desc, correct_ms asc, seat asc
//   AC-QUIZ-17  soloAnswerHash: base64url(SHA-256("lmq1|" + salt + "|" + q + "|" + low id + "|" + high id))
// Black-box: only the interfaces in docs/api/quiz-ws.md and the acceptance text. Expected numbers are literals or
// computed here with WebCrypto, never with production code. Content: worker/test/quiz-fixture.ts.
import { beforeAll, describe, expect, it } from 'vitest'
import { generateQuiz, type QuizBlocked, type QuizContent, type QuizQuestion } from '../src/features/quiz/questions'
import { questionPoints, rankPlayers, soloAnswerHash } from '../src/features/quiz/scoring'
import { DAILY, ELIGIBLE_TARGETS, RECIPE_DEFS, b64u, idMaps, quizContent, recipeId, sha256 } from './quiz-fixture'

const NO_BLOCK: QuizBlocked = { elements: [], recipes: [] }
const SEEDS = ['ABCDEF:1', 'ABCDEF:2', 'K7M2PQ:1', '999999:3', 'seed-z']

let content: QuizContent
let idOf: Map<string, string>
let nameOf: Map<string, string>
let depthOf: Map<string, number>
/** RecipeId of a pair of element names (recipeId is async, so the table is filled once in beforeAll). */
const rid = new Map<string, string>()
const recipeOf = (a: string, b: string): string => {
  const id = rid.get([a, b].sort().join('|'))
  if (!id) throw new Error(`no recipe id preloaded for ${a} + ${b}`)
  return id
}

beforeAll(async () => {
  for (const r of RECIPE_DEFS) rid.set([r.a, r.b].sort().join('|'), await recipeId(r.a, r.b))
  content = await quizContent()
  const maps = await idMaps()
  idOf = maps.idOf
  nameOf = maps.nameOf
  depthOf = new Map(content.elements.map(([id, d]) => [id, d]))
})

const key = (a: string, b: string) => [a, b].sort().join('|')

/** Assert every AC-QUIZ-08 invariant on a generated quiz; returns the target names. */
function assertValid(qs: QuizQuestion[], blocked: QuizBlocked, label: string): string[] {
  const blockedEl = new Set(blocked.elements)
  const blockedRc = new Set(blocked.recipes)
  const live = new Map<string, string>() // "a|b" -> result id, active recipes only
  for (const [id, a, b, result] of content.recipes) {
    if (blockedRc.has(id) || blockedEl.has(a) || blockedEl.has(b) || blockedEl.has(result)) continue
    live.set(key(a, b), result)
  }
  const targets: string[] = []
  let lastDepth = 0
  for (const [i, q] of qs.entries()) {
    const at = `${label} #${i + 1}`
    const opts = q.options
    expect(opts, at).toHaveLength(4)
    expect(new Set(opts).size, `${at} options distinct`).toBe(4)
    expect(opts, `${at} target is not an option`).not.toContain(q.target)
    for (const id of [q.target, ...opts, ...q.answer]) expect(blockedEl.has(id), `${at} blocked id ${nameOf.get(id)}`).toBe(false)

    const d = depthOf.get(q.target)!
    expect(d, `${at} depth`).toBeGreaterThanOrEqual(1)
    expect(d, `${at} depth`).toBeLessThanOrEqual(5)
    expect(q.target, `${at} is the Món đặc biệt`).not.toBe(content.daily_element_id)
    expect(d, `${at} difficulty never goes down`).toBeGreaterThanOrEqual(lastDepth)
    lastDepth = d
    expect(targets, `${at} repeated target`).not.toContain(nameOf.get(q.target))
    targets.push(nameOf.get(q.target)!)

    const [a, b] = q.answer
    expect(a < b, `${at} answer sorted ascending and A != B`).toBe(true)
    expect(opts, at).toContain(a)
    expect(opts, at).toContain(b)

    // exactly one of the 6 two-different-option pairs is a recipe for the target, and it is the answer
    const hits: string[] = []
    for (let x = 0; x < 4; x++) for (let y = x + 1; y < 4; y++) if (live.get(key(opts[x]!, opts[y]!)) === q.target) hits.push(key(opts[x]!, opts[y]!))
    expect(hits, `${at} pairs that make the target`).toEqual([key(a, b)])
    // none of the 4 self pairs makes the target
    for (const o of opts) expect(live.get(key(o, o)), `${at} self pair ${nameOf.get(o)}`).not.toBe(q.target)
  }
  return targets
}

describe('quiz logic', () => {
  // ============================================================== AC-QUIZ-08
  it('AC-QUIZ-08: mỗi câu thỏa A != B, đang hoạt động, độ sâu 1..5, khác Món đặc biệt, không lặp C, 4 lựa chọn đôi một khác nhau, đúng 1 cặp trong 6 là công thức, khó dần', () => {
    for (const count of [5, 10, 12]) {
      for (const seed of SEEDS) {
        const qs = generateQuiz(content, NO_BLOCK, seed, count)
        expect(qs, `${seed}/${count}`).toHaveLength(count)
        const targets = assertValid(qs, NO_BLOCK, `${seed}/${count}`)
        for (const t of targets) expect(ELIGIBLE_TARGETS).toContain(t)
        expect(targets).not.toContain(DAILY)
        expect(targets).not.toContain('Lẩu Vũ Trụ') // depth 6
      }
    }
  })

  it('AC-QUIZ-08: cùng (nội dung, bảng chặn, seed, số câu) thì ra đúng cùng một đề; seed khác thì đề khác; thứ tự 4 lựa chọn được xáo', () => {
    for (const seed of SEEDS) {
      expect(generateQuiz(content, NO_BLOCK, seed, 10)).toEqual(generateQuiz(content, NO_BLOCK, seed, 10))
    }
    const decks = new Set(SEEDS.map((s) => JSON.stringify(generateQuiz(content, NO_BLOCK, s, 5))))
    expect(decks.size).toBeGreaterThan(1)

    // shuffled: over 5 seeds x 10 questions the answer is not always sitting in the first two slots
    let notInFront = 0
    let total = 0
    for (const seed of SEEDS) {
      for (const q of generateQuiz(content, NO_BLOCK, seed, 10)) {
        total++
        if (!q.answer.every((id) => q.options.indexOf(id) < 2)) notInFront++
      }
    }
    expect(total).toBe(50)
    expect(notInFront).toBeGreaterThan(0)
  })

  it('AC-QUIZ-08: phần tử và công thức trong bảng chặn không bao giờ xuất hiện (đích, lựa chọn, đáp án)', () => {
    const blocked: QuizBlocked = {
      elements: [idOf.get('Khét Cay')!, idOf.get('Cháy Nhà')!],
      recipes: [recipeOf('Cười', 'Toang'), recipeOf('Chạy Deadline', 'Khét Lẹt')],
    }
    for (const seed of SEEDS) {
      for (const count of [5, 8]) {
        const qs = generateQuiz(content, blocked, seed, count)
        expect(qs.length, `${seed}/${count}`).toBeGreaterThan(0)
        const targets = assertValid(qs, blocked, `${seed}/${count}`)
        expect(targets).not.toContain('Khét Cay')
        expect(targets).not.toContain('Cháy Nhà')
        expect(targets).not.toContain('Drama Queen') // its only recipe is blocked
      }
    }
  })

  // ============================================================== AC-QUIZ-09
  it('AC-QUIZ-09: pool có 12 meme đề khác nhau mà xin 15 câu thì ván có đúng 12 câu, đủ cả 12 đích', () => {
    for (const seed of SEEDS) {
      const qs = generateQuiz(content, NO_BLOCK, seed, 15)
      expect(qs, seed).toHaveLength(12)
      const targets = assertValid(qs, NO_BLOCK, seed)
      expect([...targets].sort()).toEqual([...ELIGIBLE_TARGETS].sort())
    }
  })

  it('AC-QUIZ-09: pool chỉ còn 3 meme đề thì trả đúng 3 câu (dưới 5, nơi gọi sẽ từ chối); pool cạn thì trả mảng rỗng', () => {
    const keep = new Set(['Hết Cứu', 'Lẩu Thập Cẩm', 'Drama Queen'])
    const recipes = RECIPE_DEFS.filter((r) => ELIGIBLE_TARGETS.includes(r.result) && !keep.has(r.result)).map((r) => recipeOf(r.a, r.b))
    expect(recipes.length).toBeGreaterThan(8)
    const blocked: QuizBlocked = { elements: [], recipes }
    const qs = generateQuiz(content, blocked, 'ABCDEF:1', 15)
    const targets = assertValid(qs, blocked, 'pool 3')
    expect(qs).toHaveLength(3)
    expect([...targets].sort()).toEqual([...keep].sort())

    const allBlocked: QuizBlocked = { elements: ELIGIBLE_TARGETS.map((n) => idOf.get(n)!), recipes: [] }
    expect(generateQuiz(content, allBlocked, 'ABCDEF:1', 10)).toEqual([])
  })

  // ============================================================== AC-QUIZ-12
  it('AC-QUIZ-12: T = 20 giây: nộp đúng lúc 0, 10, 20 giây được 1000, 750, 500 điểm', () => {
    expect(questionPoints(true, 0, 20)).toBe(1000)
    expect(questionPoints(true, 10_000, 20)).toBe(750)
    expect(questionPoints(true, 20_000, 20)).toBe(500)
  })

  it('AC-QUIZ-12: sai, đúng một nửa hoặc không nộp (ok = false) luôn 0 điểm, bất kể thời gian', () => {
    for (const ms of [0, 1, 10_000, 20_000, 99_999]) expect(questionPoints(false, ms, 20)).toBe(0)
  })

  it('AC-QUIZ-12: làm tròn về số nguyên gần nhất và t được kẹp trong [0, T]', () => {
    expect(questionPoints(true, 1234, 20)).toBe(969) // 969.15
    expect(questionPoints(true, 3333, 30)).toBe(944) // 944.45
    expect(questionPoints(true, 5000, 10)).toBe(750)
    expect(questionPoints(true, 30_000, 20)).toBe(500) // late: clamped to T
    expect(questionPoints(true, -250, 20)).toBe(1000) // early: clamped to 0
    expect(Number.isInteger(questionPoints(true, 777, 30))).toBe(true)
  })

  // ============================================================== AC-QUIZ-14 / 15
  it('AC-QUIZ-14: xếp theo điểm giảm dần, rồi tổng thời gian câu đúng tăng dần, rồi thứ tự vào phòng; hạng 1..n liên tục', () => {
    const players = [
      { seat: 1, nickname: 'Một', score: 1500, correct: 2, correct_ms: 9000 },
      { seat: 2, nickname: 'Hai', score: 2000, correct: 3, correct_ms: 12000 },
      { seat: 3, nickname: 'Ba', score: 1500, correct: 2, correct_ms: 7000 }, // same score as seat 1, faster
      { seat: 4, nickname: 'Bốn', score: 0, correct: 0, correct_ms: 0 },
      { seat: 5, nickname: 'Năm', score: 0, correct: 0, correct_ms: 0 }, // tie to the end: seat order
      { seat: 6, nickname: 'Sáu', score: 1500, correct: 2, correct_ms: 7000 }, // ties with seat 3 on everything: seat 3 first
    ]
    const ranked = rankPlayers([...players].reverse())
    expect(ranked.map((p) => p.seat)).toEqual([2, 3, 6, 1, 4, 5])
    expect(ranked.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6])
    expect(ranked.find((p) => p.seat === 3)).toMatchObject({ nickname: 'Ba', score: 1500, correct: 2, correct_ms: 7000 })
  })

  it('AC-QUIZ-15: bảng rỗng và một người đều xếp được; không đổi mảng đầu vào', () => {
    expect(rankPlayers([])).toEqual([])
    const one = [{ seat: 1, nickname: 'Solo', score: 10, correct: 1, correct_ms: 5 }]
    const copy = JSON.parse(JSON.stringify(one))
    expect(rankPlayers(one)).toEqual([{ ...one[0]!, rank: 1 }])
    expect(one).toEqual(copy)
  })

  // ============================================================== AC-QUIZ-17
  it('AC-QUIZ-17: soloAnswerHash = base64url(SHA-256("lmq1|" + muối + "|" + q + "|" + id nhỏ + "|" + id lớn)), không phụ thuộc thứ tự hai id', async () => {
    const a = idOf.get('Cay')!
    const b = idOf.get('Cười')!
    const [lo, hi] = [a, b].sort()
    const salt = 'K7M2PQ:1'
    const want = b64u(await sha256(`lmq1|${salt}|3|${lo}|${hi}`))
    expect(await soloAnswerHash(salt, 3, a, b)).toBe(want)
    expect(await soloAnswerHash(salt, 3, b, a)).toBe(want)
    expect(want).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('AC-QUIZ-17: đổi muối (mã phòng, số ván), số câu hoặc một id thì băm đổi', async () => {
    const a = idOf.get('Cay')!
    const b = idOf.get('Cười')!
    const c = idOf.get('Toang')!
    const base = await soloAnswerHash('K7M2PQ:1', 1, a, b)
    expect(await soloAnswerHash('K7M2PQ:2', 1, a, b)).not.toBe(base)
    expect(await soloAnswerHash('ZZZZZZ:1', 1, a, b)).not.toBe(base)
    expect(await soloAnswerHash('K7M2PQ:1', 2, a, b)).not.toBe(base)
    expect(await soloAnswerHash('K7M2PQ:1', 1, a, c)).not.toBe(base)
  })
})
