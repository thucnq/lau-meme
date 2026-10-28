/**
 * mQuiz question deck (AC-QUIZ-08/09, ADR 0021): pure and deterministic - same content, blocked table, seed and count
 * give the same deck. No clock, no Math.random.
 */
export type QuizContent = {
  daily_element_id: string
  elements: Array<[id: string, depth: number]>
  recipes: Array<[id: string, a: string, b: string, result: string]>
}
export type QuizBlocked = { elements: string[]; recipes: string[] }
/** `answer` is sorted ascending (string order). */
export type QuizQuestion = { target: string; options: [string, string, string, string]; answer: [string, string] }

const MIN_DEPTH = 1
const MAX_DEPTH = 5 // open question 87: targets of depth 1..5
const DISTRACTOR_POOL = 40 // candidates tried per recipe: at most 780 pairs

/** xmur3 string hash -> mulberry32 generator in [0, 1). */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * Up to `count` questions, one per distinct target, in non-decreasing target depth (AC-QUIZ-08). Fewer when the
 * pool is short (AC-QUIZ-09); the caller refuses a deck of fewer than 5.
 */
export function generateQuiz(content: QuizContent, blocked: QuizBlocked, seed: string, count: number): QuizQuestion[] {
  const rnd = seededRandom(seed)
  const blockedEl = new Set(blocked.elements)
  const blockedRc = new Set(blocked.recipes)
  const depth = new Map(content.elements.filter(([id]) => !blockedEl.has(id)))
  const live = new Map<string, string>() // pair -> result, active recipes only
  const byTarget = new Map<string, Array<[string, string]>>()
  for (const [id, a, b, result] of content.recipes) {
    if (blockedRc.has(id) || !depth.has(a) || !depth.has(b) || !depth.has(result)) continue
    live.set(pairKey(a, b), result)
    const d = depth.get(result)!
    if (a === b || d < MIN_DEPTH || d > MAX_DEPTH || result === content.daily_element_id) continue
    byTarget.set(result, [...(byTarget.get(result) ?? []), [a, b]])
  }
  const elements = [...depth.keys()]

  const makes = (x: string, y: string, target: string) => live.get(pairKey(x, y)) === target
  function build(target: string): QuizQuestion | null {
    for (const [a, b] of shuffle(byTarget.get(target)!, rnd)) {
      if (makes(a, a, target) || makes(b, b, target)) continue
      const mid = (depth.get(a)! + depth.get(b)!) / 2
      // distractors near the answer's depth are harder to tell apart; shuffled first so ties stay varied
      const candidates = shuffle(
        elements.filter((e) => e !== a && e !== b && e !== target && !makes(e, e, target) && !makes(e, a, target) && !makes(e, b, target)),
        rnd,
      )
        .sort((x, y) => Math.abs(depth.get(x)! - mid) - Math.abs(depth.get(y)! - mid))
        .slice(0, DISTRACTOR_POOL)
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const [x, y] = [candidates[i]!, candidates[j]!]
          if (makes(x, y, target)) continue
          const options = shuffle([a, b, x, y], rnd) as QuizQuestion['options']
          return { target, options, answer: a < b ? [a, b] : [b, a] }
        }
      }
    }
    return null
  }

  const picked: QuizQuestion[] = []
  for (const target of shuffle([...byTarget.keys()].sort(), rnd)) {
    if (picked.length >= count) break
    const q = build(target)
    if (q) picked.push(q)
  }
  // stable sort keeps the shuffled order among targets of the same depth
  return picked.sort((p, q) => depth.get(p.target)! - depth.get(q.target)!)
}
