// Shared fixture content for the QUIZ acceptance tests (quiz.test.ts, quiz-logic.test.ts). Not a test file itself.
// Black-box: only ADR 0002 (ids) and the openapi PublishBatchRequest are used.
//
// Synthetic content: 4 starters (depth 0) + 14 results (depth 1..6), the Món đặc biệt is "Stonks" (depth 4).
// Eligible mQuiz targets (depth 1..5, not the daily one) are exactly 12, so a 15-question game has 12 questions (AC-QUIZ-09).
// Two targets ("Tới Công Chuyện", "Cháy Nhà") have a second recipe so option sets must avoid a second matching pair (AC-QUIZ-08).
import type { QuizContent } from '../src/features/quiz/questions'

export const BATCH_AT = '2026-10-20T05:30:00.000Z'

// ---------------------------------------------------------------------------- ADR 0002 helpers (no Node types)
const enc = new TextEncoder()
export const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
export const elementId = async (name: string) => b64u(await sha256(`lm1|e|${fold(name)}`))
export async function recipeId(a: string, b: string): Promise<string> {
  const [x, y] = [fold(a), fold(b)].sort()
  return b64u(await sha256(`lm1|k|${x}\0${y}`))
}

// ---------------------------------------------------------------------------- content definition
export const STARTER_DEFS = [
  { name: 'Cay', emoji: '🌶️' },
  { name: 'Cười', emoji: '😂' },
  { name: 'Toang', emoji: '💀' },
  { name: 'Deadline', emoji: '⏰' },
]

export const RESULT_DEFS = [
  { name: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
  { name: 'Khét Lẹt', emoji: '🫠', depth: 1 },
  { name: 'Cháy Nhà', emoji: '🏚️', depth: 1 },
  { name: 'Chạy Deadline', emoji: '🏃', depth: 2 },
  { name: 'Khét Cay', emoji: '🥵', depth: 2 },
  { name: 'Cháy Cười', emoji: '🤣', depth: 2 },
  { name: 'Hết Cứu', emoji: '🧯', depth: 3 },
  { name: 'Lẩu Thập Cẩm', emoji: '🍲', depth: 3 },
  { name: 'Drama Queen', emoji: '👑', depth: 3 },
  { name: 'Stonks', emoji: '📈', depth: 4 },
  { name: 'Lẩu Mắm', emoji: '🫕', depth: 4 },
  { name: 'Lẩu Tận Thế', emoji: '🌋', depth: 5 },
  { name: 'Hoàng Hậu Meme', emoji: '👸', depth: 5 },
  { name: 'Lẩu Vũ Trụ', emoji: '🌌', depth: 6 },
]

export const RECIPE_DEFS = [
  { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' },
  { a: 'Cười', b: 'Toang', result: 'Tới Công Chuyện' }, // second recipe
  { a: 'Toang', b: 'Deadline', result: 'Khét Lẹt' },
  { a: 'Cay', b: 'Toang', result: 'Cháy Nhà' },
  { a: 'Cay', b: 'Deadline', result: 'Cháy Nhà' }, // second recipe
  { a: 'Tới Công Chuyện', b: 'Deadline', result: 'Chạy Deadline' },
  { a: 'Khét Lẹt', b: 'Cay', result: 'Khét Cay' },
  { a: 'Cháy Nhà', b: 'Cười', result: 'Cháy Cười' },
  { a: 'Chạy Deadline', b: 'Toang', result: 'Hết Cứu' },
  { a: 'Khét Cay', b: 'Cháy Cười', result: 'Lẩu Thập Cẩm' },
  { a: 'Chạy Deadline', b: 'Khét Lẹt', result: 'Drama Queen' },
  { a: 'Hết Cứu', b: 'Cay', result: 'Stonks' },
  { a: 'Lẩu Thập Cẩm', b: 'Khét Cay', result: 'Lẩu Mắm' },
  { a: 'Lẩu Mắm', b: 'Hết Cứu', result: 'Lẩu Tận Thế' },
  { a: 'Drama Queen', b: 'Stonks', result: 'Hoàng Hậu Meme' },
  { a: 'Lẩu Tận Thế', b: 'Hoàng Hậu Meme', result: 'Lẩu Vũ Trụ' },
]

export const DAILY = 'Stonks'
/** Result names a quiz may use as a question target: depth 1..5 and not the Món đặc biệt. */
export const ELIGIBLE_TARGETS = RESULT_DEFS.filter((r) => r.depth >= 1 && r.depth <= 5 && r.name !== DAILY).map((r) => r.name)
export const ALL_NAMES = [...STARTER_DEFS.map((s) => s.name), ...RESULT_DEFS.map((r) => r.name)]

export const depthByName = new Map<string, number>([...STARTER_DEFS.map((s) => [s.name, 0] as const), ...RESULT_DEFS.map((r) => [r.name, r.depth] as const)])

const pairKey = (a: string, b: string) => [fold(a), fold(b)].sort().join('|')
const resultByPair = new Map(RECIPE_DEFS.map((r) => [pairKey(r.a, r.b), r.result]))
/** The result name of combining two element names, or undefined when that pair makes nothing. */
export const resultName = (a: string, b: string): string | undefined => resultByPair.get(pairKey(a, b))

/** name -> ElementId and ElementId -> name. */
export async function idMaps(): Promise<{ idOf: Map<string, string>; nameOf: Map<string, string> }> {
  const idOf = new Map<string, string>()
  const nameOf = new Map<string, string>()
  for (const n of ALL_NAMES) {
    const id = await elementId(n)
    idOf.set(n, id)
    nameOf.set(id, n)
  }
  return { idOf, nameOf }
}

// ---------------------------------------------------------------------------- publish payload and pure-function content
export async function batchBody(version: number) {
  const starterIds = await Promise.all(STARTER_DEFS.map((s) => elementId(s.name)))
  const recipes = await Promise.all(
    RECIPE_DEFS.map(async (d) => {
      const [x, y] = [await elementId(d.a), await elementId(d.b)].sort()
      return { id: await recipeId(d.a, d.b), a: x!, b: y!, result: await elementId(d.result) }
    }),
  )
  const targetId = await elementId(DAILY)
  return {
    status: 'success',
    version,
    batch_at: BATCH_AT,
    mode: 'core',
    manifest: {
      version,
      batch_at: BATCH_AT,
      graph_url: `/api/graph/${version}`,
      starters: STARTER_DEFS.map((s, i) => ({ id: starterIds[i], name: s.name, emoji: s.emoji })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: targetId, emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await recipeId('graph', String(version))]: 'abc' } },
    content: {
      elements: [
        ...STARTER_DEFS.map((s, i) => ({ id: starterIds[i], name: s.name, fold: fold(s.name), emoji: s.emoji, depth: 0, origin: 'vn' })),
        ...(await Promise.all(
          RESULT_DEFS.map(async (d) => ({ id: await elementId(d.name), name: d.name, fold: fold(d.name), emoji: d.emoji, depth: d.depth, origin: 'vn' })),
        )),
      ],
      recipes,
      starters: starterIds,
      daily_element_id: targetId,
    },
    stats: {},
  }
}

/** The same content in the shape generateQuiz takes (ids sorted inside each recipe, as in the batch). */
export async function quizContent(): Promise<QuizContent> {
  const { idOf } = await idMaps()
  const elements: QuizContent['elements'] = ALL_NAMES.map((n) => [idOf.get(n)!, depthByName.get(n)!] as [string, number])
  const recipes: QuizContent['recipes'] = await Promise.all(
    RECIPE_DEFS.map(async (d) => {
      const [x, y] = [idOf.get(d.a)!, idOf.get(d.b)!].sort()
      return [await recipeId(d.a, d.b), x!, y!, idOf.get(d.result)!] as [string, string, string, string]
    }),
  )
  return { daily_element_id: idOf.get(DAILY)!, elements, recipes }
}
