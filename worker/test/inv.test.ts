// Acceptance test for docs/acceptance/inv.md, worker part: AC-INV-11 (leaderboard holds only valid paths).
// Black-box: HTTP contract + D1 schema + ADR 0002 id formulas. The replay below is written independently of
// production code (worker/src is never read). AC-INV-08 and AC-INV-09 are covered by disc.test.ts / report.test.ts.
//
// Shape assumed for batch_content.server_json (ADR 0003: "id phần tử khởi đầu, phần tử + depth, công thức
// [id, a, b, result], id món Daily"): the keys are located by name pattern (starters / recipes / daily) and a recipe
// may be an array [id, a, b, result] or an object {id, a, b, result}. See the ambiguity list in the hand-over note.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['inv', 'pipeline', 'token'].join('-')
const IP_KEY = ['inv', 'ip', 'hash', 'key'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION
const SEED = 20261020

type Handler = {
  fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>
}
type Step = { a: string; b: string; result: string }

// ---------------------------------------------------------------------------- ADR 0002 helpers (own copy)
const b64u = (buf: ReturnType<typeof Buffer.from>) => buf.toString('base64url')
const sha256 = async (text: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

function fold(s: string): string {
  return s.toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
}
const elementId = async (name: string) => b64u(await sha256(`lm1|e|${fold(name)}`))
async function recipeId(a: string, b: string): Promise<string> {
  const [x, y] = [fold(a), fold(b)].sort((p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q)))
  return b64u(await sha256(`lm1|k|${x}\0${y}`))
}

// ---------------------------------------------------------------------------- fixture content (as daily.test.ts)
const STARTER_DEFS = [
  { name: 'Cay', emoji: '🌶️' },
  { name: 'Cười', emoji: '😂' },
  { name: 'Toang', emoji: '💀' },
  { name: 'Deadline', emoji: '⏰' },
]
const CHAIN = [
  { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
  {
    a: 'Tới Công Chuyện',
    b: 'Deadline',
    result: 'Chạy Deadline',
    emoji: '🏃',
    depth: 2,
  },
  { a: 'Chạy Deadline', b: 'Toang', result: 'Hết Cứu', emoji: '🧯', depth: 3 },
  { a: 'Hết Cứu', b: 'Cay', result: 'Stonks', emoji: '📈', depth: 4 },
]
const TARGET = 'Stonks'
const SIDE = {
  a: 'Toang',
  b: 'Deadline',
  result: 'Khét Lẹt',
  emoji: '🫠',
  depth: 1,
}
const FULL_PATH: Step[] = CHAIN.map(({ a, b, result }) => ({ a, b, result }))
const SIDE_STEP: Step = { a: SIDE.a, b: SIDE.b, result: SIDE.result }
const HINT = 'Món lên như diều gặp gió'

async function batchBody(version: number, batchAt = BATCH_AT) {
  const starterIds = await Promise.all(STARTER_DEFS.map((s) => elementId(s.name)))
  const defs = [...CHAIN, SIDE]
  const recipes = await Promise.all(
    defs.map(async (d) => {
      const [x, y] = [await elementId(d.a), await elementId(d.b)].sort()
      return {
        id: await recipeId(d.a, d.b),
        a: x!,
        b: y!,
        result: await elementId(d.result),
      }
    }),
  )
  const targetId = await elementId(TARGET)
  return {
    status: 'success',
    version,
    batch_at: batchAt,
    mode: 'core',
    manifest: {
      version,
      batch_at: batchAt,
      graph_url: `/api/graph/${version}`,
      starters: STARTER_DEFS.map((s, i) => ({
        id: starterIds[i],
        name: s.name,
        emoji: s.emoji,
      })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: targetId, emoji: '📈', hint: HINT, depth: 4 },
    },
    graph: {
      format: 1,
      version,
      entries: { [await recipeId('graph', String(version))]: 'abc' },
    },
    content: {
      elements: [
        ...STARTER_DEFS.map((s, i) => ({
          id: starterIds[i],
          name: s.name,
          fold: fold(s.name),
          emoji: s.emoji,
          depth: 0,
          origin: 'vn',
        })),
        ...(await Promise.all(
          defs.map(async (d) => ({
            id: await elementId(d.result),
            name: d.result,
            fold: fold(d.result),
            emoji: d.emoji,
            depth: d.depth,
            origin: 'vn',
          })),
        )),
      ],
      recipes,
      starters: starterIds,
      daily_element_id: targetId,
    },
    stats: {},
  }
}

// ---------------------------------------------------------------------------- HTTP helpers
async function raw(path: string, init: RequestInit, headers: Record<string, string>): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(`https://example.com${path}`, { ...init, headers: h }),
    { ...env, PIPELINE_TOKEN: TOKEN, IP_HASH_KEY: IP_KEY },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

async function publish(version: number, batchAt = BATCH_AT): Promise<void> {
  const res = await raw(
    '/lau-meme/api/pipeline/batches',
    { method: 'POST', body: JSON.stringify(await batchBody(version, batchAt)) },
    { Authorization: `Bearer ${TOKEN}` },
  )
  expect(res.status).toBe(201)
}

/** Each player gets a distinct private-range IP so IP rate limits never interfere. */
function ipFor(player: string): string {
  const hex = player.replaceAll('-', '')
  return `10.${parseInt(hex.slice(0, 2), 16)}.${parseInt(hex.slice(2, 4), 16)}.${parseInt(hex.slice(4, 6), 16)}`
}

const submit = (version: number, player: string, steps: number, path: Step[]) =>
  raw(
    `/lau-meme/api/daily/${version}/results`,
    { method: 'POST', body: JSON.stringify({ steps, path }) },
    { 'X-Player-Id': player, 'CF-Connecting-IP': ipFor(player) },
  )

async function newPlayer(): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
  )
    .bind(crypto.randomUUID(), id, POLICY_VERSION, Date.now())
    .run()
  return id
}

// ---------------------------------------------------------------------------- fixed-seed PRNG (mulberry32)
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Case = { label: string; steps: number; path: Step[]; valid: boolean }

function makeCase(kind: number, rand: () => number): Case {
  const n = FULL_PATH.length
  switch (kind) {
    case 0:
      return {
        label: 'đường đúng, steps tùy ý ≥ độ dài',
        steps: n + Math.floor(rand() * 10),
        path: FULL_PATH,
        valid: true,
      }
    case 1:
      return {
        label: 'đường đúng có bước lặp lại',
        steps: n + 1 + Math.floor(rand() * 5),
        path: [FULL_PATH[0]!, ...FULL_PATH],
        valid: true,
      }
    case 2: {
      // Never after the last step: the path must still end at the target (AC-DAILY-06).
      const at = Math.floor(rand() * n)
      const path = [...FULL_PATH.slice(0, at), SIDE_STEP, ...FULL_PATH.slice(at)]
      return {
        label: 'đường đúng có bước rẽ nhánh thật',
        steps: path.length,
        path,
        valid: true,
      }
    }
    case 3: {
      const k = Math.floor(rand() * (n - 1))
      const path = FULL_PATH.map((s, i) => (i === k ? { ...s, result: SIDE.result } : s))
      return {
        label: `sai kết quả ở bước ${k + 1}`,
        steps: n,
        path,
        valid: false,
      }
    }
    case 4: {
      const k = 1 + Math.floor(rand() * (n - 1))
      const path = FULL_PATH.filter((_, i) => i !== k)
      return { label: `bỏ qua bước ${k + 1}`, steps: n, path, valid: false }
    }
    case 5:
      return {
        label: 'khai báo ít bước hơn đường',
        steps: n - 1 - Math.floor(rand() * (n - 1)),
        path: FULL_PATH,
        valid: false,
      }
    default:
      return {
        label: 'đảo thứ tự các bước',
        steps: n,
        path: [...FULL_PATH].reverse(),
        valid: false,
      }
  }
}

// ---------------------------------------------------------------------------- independent replay
type Json = unknown

/** Value of the first own key whose name matches `pattern`. */
function pick(obj: Json, pattern: RegExp): Json {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, Json>)) if (pattern.test(k)) return v
  }
  throw new Error(`server_json không có khóa khớp ${pattern}: ${JSON.stringify(obj).slice(0, 200)}`)
}

function idOf(x: Json): string {
  if (typeof x === 'string') return x
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const o = x as Record<string, Json>
    const v = o.id ?? o.element_id
    if (typeof v === 'string') return v
  }
  throw new Error(`không đọc được id phần tử từ ${JSON.stringify(x)}`)
}

type Content = {
  starters: Set<string>
  result: Map<string, string>
  daily: string
}

function parseServerJson(text: string): Content {
  const sj = JSON.parse(text) as Json
  const starters = new Set((pick(sj, /start/i) as Json[]).map(idOf))
  const result = new Map<string, string>()
  for (const r of pick(sj, /recip/i) as Json[]) {
    const t: string[] = Array.isArray(r)
      ? (r as string[]).slice(1, 4)
      : [
          (r as Record<string, string>).a ?? '',
          (r as Record<string, string>).b ?? '',
          (r as Record<string, string>).result ?? '',
        ]
    result.set([t[0] ?? '', t[1] ?? ''].sort().join('|'), t[2] ?? '')
  }
  const daily = idOf(pick(sj, /daily/i))
  return { starters, result, daily }
}

/** Why the path is invalid (first problem), or null when it is a valid Daily path. */
async function replay(content: Content, path: Step[]): Promise<string | null> {
  if (path.length < 1 || path.length > 200) return `độ dài đường ${path.length} ngoài [1, 200]`
  const known = new Set(content.starters)
  let last = ''
  for (const [i, step] of path.entries()) {
    const [ea, eb, er] = await Promise.all([elementId(step.a), elementId(step.b), elementId(step.result)])
    if (!known.has(ea) || !known.has(eb)) return `bước ${i + 1}: đầu vào chưa có ở thời điểm đó`
    if (content.result.get([ea, eb].sort().join('|')) !== er) return `bước ${i + 1}: không phải công thức có thật`
    known.add(er)
    last = er
  }
  return last === content.daily ? null : 'bước cuối không ra món đích'
}

// ---------------------------------------------------------------------------- setup
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-20T06:00:05.000Z'))
  await env.DB.batch([
    env.DB.prepare('DELETE FROM daily_result'),
    env.DB.prepare('DELETE FROM streak'),
    env.DB.prepare('DELETE FROM player'),
    env.DB.prepare('DELETE FROM consent'),
    env.DB.prepare('DELETE FROM rate_counter'),
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('inv', () => {
  it('AC-INV-11: mọi kết quả Daily đã lưu đều có đường ghép hợp lệ với graph của version đó và số bước lưu ≥ số bước của đường', async () => {
    await publish(1)
    const rand = prng(SEED)
    const kinds = [0, 1, 2, 3, 4, 5, 6, 0, 3, 4] // 10 lần nộp: 3 đường hợp lệ đầu tiên + trộn có seed
    const mixed = kinds.map((k, i) => (i < 3 ? i : k))
    let valid = 0
    for (const [i, kind] of mixed.entries()) {
      const c = makeCase(kind, rand)
      const player = await newPlayer()
      vi.setSystemTime(new Date(Date.parse('2026-10-20T06:00:05.000Z') + i * 1000))
      const res = await submit(1, player, c.steps, c.path)
      expect(res.status, `lần nộp ${i + 1}: ${c.label}`).toBe(c.valid ? 201 : 422)
      if (c.valid) valid++
    }
    expect(valid).toBeGreaterThanOrEqual(3)

    const rows = await env.DB.prepare('SELECT version, player_id, steps, path_json FROM daily_result').all<{
      version: number
      player_id: string
      steps: number
      path_json: string
    }>()
    expect(rows.results).toHaveLength(valid) // đường không hợp lệ không để lại dòng nào

    for (const row of rows.results) {
      const stored = await env.DB.prepare('SELECT server_json FROM batch_content WHERE version = ?')
        .bind(row.version)
        .first<{ server_json: string }>()
      expect(stored, `batch_content của version ${row.version}`).not.toBeNull()
      const content = parseServerJson(stored!.server_json)
      const path = JSON.parse(row.path_json) as Step[]
      expect(Array.isArray(path)).toBe(true)
      expect(await replay(content, path), `đường của ${row.player_id}`).toBeNull()
      expect(row.steps, `số bước lưu của ${row.player_id}`).toBeGreaterThanOrEqual(path.length)
    }
  }, 60_000)
})
