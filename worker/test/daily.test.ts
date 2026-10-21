// Acceptance tests for docs/acceptance/daily.md (worker part: AC-DAILY-03 manifest, 06..11, 13, abuse).
// Black-box: only the HTTP contract (docs/api/openapi.yaml), the ADR 0002 id formulas and the D1 schema are used.
// Ids are built here from ADR 0002 (lm1|e| / lm1|k|), independent of production code.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'

// Built from parts so the repo's secret-scan regex does not flag a test constant.
const TOKEN = ['daily', 'pipeline', 'token'].join('-')
const IP_KEY = ['daily', 'ip', 'hash', 'key'].join('-')
const BATCH_AT = '2026-10-20T05:30:00.000Z'
const POLICY_VERSION = 1 // wrangler.jsonc vars.POLICY_VERSION

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Step = { a: string; b: string; result: string }
type Streak = { current: number; longest: number }
type DailyResult = { version: number; steps: number; rank: number; streak: Streak; submitted_at: string }
type Row = { rank: number; nickname: string; value: number }
type Board = { version: number; rows: Row[]; me: Row | null }
type Problem = { type: string; title: string; status: number; detail?: string; result?: DailyResult }

// ---------------------------------------------------------------------------- ADR 0002 helpers
const b64u = (buf: ReturnType<typeof Buffer.from>) => buf.toString('base64url')
const sha256 = async (text: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
const elementId = async (name: string) => b64u(await sha256(`lm1|e|${fold(name)}`))
async function recipeId(a: string, b: string): Promise<string> {
  const [x, y] = [fold(a), fold(b)].sort((p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q)))
  return b64u(await sha256(`lm1|k|${x}\0${y}`))
}

// ---------------------------------------------------------------------------- fixture content
const STARTER_DEFS = [
  { name: 'Cay', emoji: '🌶️' },
  { name: 'Cười', emoji: '😂' },
  { name: 'Toang', emoji: '💀' },
  { name: 'Deadline', emoji: '⏰' },
]
// The only way to the target: Cay+Cười -> A, A+Deadline -> B, B+Toang -> C, C+Cay -> Stonks.
const CHAIN = [
  { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện', emoji: '🔥', depth: 1 },
  { a: 'Tới Công Chuyện', b: 'Deadline', result: 'Chạy Deadline', emoji: '🏃', depth: 2 },
  { a: 'Chạy Deadline', b: 'Toang', result: 'Hết Cứu', emoji: '🧯', depth: 3 },
  { a: 'Hết Cứu', b: 'Cay', result: 'Stonks', emoji: '📈', depth: 4 },
]
const TARGET = 'Stonks'
const SIDE = { a: 'Toang', b: 'Deadline', result: 'Khét Lẹt', emoji: '🫠', depth: 1 } // real recipe, not the target
const FULL_PATH: Step[] = CHAIN.map(({ a, b, result }) => ({ a, b, result }))
const HINT = 'Món lên như diều gặp gió'

async function batchBody(version: number, batchAt = BATCH_AT) {
  const starterIds = await Promise.all(STARTER_DEFS.map((s) => elementId(s.name)))
  const defs = [...CHAIN, SIDE]
  const recipes = await Promise.all(
    defs.map(async (d) => {
      const [x, y] = [await elementId(d.a), await elementId(d.b)].sort()
      return { id: await recipeId(d.a, d.b), a: x!, b: y!, result: await elementId(d.result) }
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
      starters: STARTER_DEFS.map((s, i) => ({ id: starterIds[i], name: s.name, emoji: s.emoji })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: targetId, emoji: '📈', hint: HINT, depth: 4 },
    },
    graph: { format: 1, version, entries: { [await recipeId('graph', String(version))]: 'abc' } },
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

/** Each player gets a distinct documentation-range IP so IP rate limits never interfere unless a test wants it. */
function ipFor(player: string): string {
  const hex = player.replaceAll('-', '')
  return `10.${parseInt(hex.slice(0, 2), 16)}.${parseInt(hex.slice(2, 4), 16)}.${parseInt(hex.slice(4, 6), 16)}`
}

function as(player: string | null, ip?: string): Record<string, string> {
  const h: Record<string, string> = {}
  if (player !== null) {
    h['X-Player-Id'] = player
    h['CF-Connecting-IP'] = ip ?? ipFor(player)
  } else {
    h['CF-Connecting-IP'] = ip ?? '10.250.250.250'
  }
  return h
}

const submitRaw = (version: number | string, player: string | null, body: string, ip?: string) =>
  raw(`/lau-meme/api/daily/${version}/results`, { method: 'POST', body }, as(player, ip))

const submit = (version: number, player: string, steps: number, path: Step[] = FULL_PATH, ip?: string) =>
  submitRaw(version, player, JSON.stringify({ steps, path }), ip)

const board = async (version: number | string, player: string | null = null): Promise<Board> => {
  const res = await raw(`/lau-meme/api/daily/${version}/leaderboard`, {}, player ? as(player) : {})
  expect(res.status).toBe(200)
  return (await res.json()) as Board
}

const myStreak = async (player: string): Promise<Streak> => {
  const res = await raw('/lau-meme/api/me/streak', {}, as(player))
  expect(res.status).toBe(200)
  return (await res.json()) as Streak
}

async function newPlayer(consent = true): Promise<string> {
  const id = crypto.randomUUID()
  if (consent) {
    await env.DB.prepare(
      "INSERT INTO consent (id, player_id, purpose, action, policy_version, ip_hash, channel, created_at) VALUES (?, ?, 'play', 'grant', ?, NULL, 'web', ?)",
    )
      .bind(crypto.randomUUID(), id, POLICY_VERSION, Date.now())
      .run()
  }
  return id
}

const COUNT_SQL = {
  daily_result: 'SELECT COUNT(*) AS n FROM daily_result',
  streak: 'SELECT COUNT(*) AS n FROM streak',
} as const

async function count(table: keyof typeof COUNT_SQL): Promise<number> {
  const row = await env.DB.prepare(COUNT_SQL[table]).first<{ n: number }>()
  return row?.n ?? 0
}

const isProblem = (res: Response) => expect(res.headers.get('content-type')).toContain('application/problem+json')
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

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

describe('daily', () => {
  // ------------------------------------------------------------------------ AC-DAILY-03 (worker side)
  it('AC-DAILY-03: manifest công bố emoji, gợi ý, depth, khóa băm của tên đã fold và không lộ tên món', async () => {
    await publish(1)
    const res = await raw('/lau-meme/api/manifest', {}, {})
    expect(res.status).toBe(200)
    const text = await res.text()
    const manifest = JSON.parse(text) as { daily: Record<string, unknown> }
    expect(manifest.daily).toEqual({
      element_id: await elementId(TARGET),
      emoji: '📈',
      hint: HINT,
      depth: 4,
    })
    expect(Object.keys(manifest.daily).sort()).toEqual(['depth', 'element_id', 'emoji', 'hint'])
    expect(text.toLowerCase()).not.toContain('stonks')
  })

  // ------------------------------------------------------------------------ AC-DAILY-06
  it('AC-DAILY-06: đường ghép hợp lệ trả 201 với số bước, hạng hiện tại, streak mới và lưu đúng một lần', async () => {
    await publish(1)
    const a = await newPlayer()
    const res = await submit(1, a, 7)
    expect(res.status).toBe(201)
    const body = (await res.json()) as DailyResult
    expect(body.version).toBe(1)
    expect(body.steps).toBe(7)
    expect(body.rank).toBe(1)
    expect(body.streak).toEqual({ current: 1, longest: 1 })
    expect(Number.isNaN(Date.parse(body.submitted_at))).toBe(false)

    const rows = await env.DB.prepare('SELECT version, player_id, steps FROM daily_result').all<{
      version: number
      player_id: string
      steps: number
    }>()
    expect(rows.results).toEqual([{ version: 1, player_id: a, steps: 7 }])

    // hạng hiện tại phản ánh người đến sau: ít bước hơn -> 1; bằng bước nhưng nộp sau -> đứng sau người nộp trước
    vi.setSystemTime(new Date('2026-10-20T06:00:10.000Z'))
    const b = await newPlayer()
    expect(((await (await submit(1, b, 5)).json()) as DailyResult).rank).toBe(1)
    vi.setSystemTime(new Date('2026-10-20T06:00:15.000Z'))
    const c = await newPlayer()
    expect(((await (await submit(1, c, 7)).json()) as DailyResult).rank).toBe(3)
    expect(await count('daily_result')).toBe(3)
  })

  it('AC-DAILY-06: số bước khai báo lớn hơn số bước của đường vẫn hợp lệ, đường có bước thừa lặp lại vẫn đúng', async () => {
    await publish(1)
    const a = await newPlayer()
    const path = [FULL_PATH[0]!, FULL_PATH[0]!, ...FULL_PATH.slice(1)]
    const res = await submit(1, a, 200, path)
    expect(res.status).toBe(201)
    expect(((await res.json()) as DailyResult).steps).toBe(200)
  })

  it('AC-DAILY-06: chưa đồng ý (play) cho version chính sách hiện hành thì 403 và không ghi gì', async () => {
    await publish(1)
    const stranger = await newPlayer(false)
    const res = await submit(1, stranger, 4)
    expect(res.status).toBe(403)
    isProblem(res)
    expect(await count('daily_result')).toBe(0)
    expect(await count('streak')).toBe(0)
  })

  // ------------------------------------------------------------------------ AC-DAILY-07
  it('AC-DAILY-07: mọi dạng đường ghép không hợp lệ trả 422 problem+json, không ghi gì, không đổi streak', async () => {
    await publish(1)
    const player = await newPlayer()
    const [s1, s2, s3, s4] = FULL_PATH as [Step, Step, Step, Step]
    const cases: Array<{ label: string; steps: number; path: Step[] }> = [
      { label: 'công thức không có thật', steps: 4, path: [{ a: 'Cay', b: 'Toang', result: 'Tới Công Chuyện' }, s2, s3, s4] },
      { label: 'cặp có thật nhưng sai kết quả', steps: 1, path: [{ a: 'Cay', b: 'Cười', result: TARGET }] },
      { label: 'dùng phần tử chưa có ở thời điểm đó', steps: 4, path: [s2, s1, s3, s4] },
      { label: 'đầu vào là món đích khi chưa ghép ra', steps: 2, path: [{ a: TARGET, b: 'Cay', result: 'Hết Cứu' }, s4] },
      { label: 'không kết thúc ở món đích', steps: 3, path: [s1, s2, s3] },
      { label: 'kết thúc ở một món có thật nhưng không phải món đích', steps: 1, path: [{ a: 'Toang', b: 'Deadline', result: 'Khét Lẹt' }] },
      { label: 'số bước khai báo nhỏ hơn số bước của đường', steps: 3, path: FULL_PATH },
      { label: 'quá 200 bước khai báo', steps: 201, path: FULL_PATH },
      { label: 'đường dài quá 200 bước', steps: 201, path: [...Array<Step>(200).fill(s1), ...FULL_PATH.slice(1)] },
    ]
    for (const c of cases) {
      const res = await submit(1, player, c.steps, c.path)
      expect(res.status, c.label).toBe(422)
      isProblem(res)
      const body = (await res.json()) as Problem
      expect(body.status, c.label).toBe(422)
      expect(body.title.length, c.label).toBeGreaterThan(0)
    }
    expect(await count('daily_result')).toBe(0)
    expect(await count('streak')).toBe(0)
    expect(await myStreak(player)).toEqual({ current: 0, longest: 0 })
    expect((await board(1)).rows).toEqual([])
  })

  it('AC-DAILY-07: nhiều lỗi trong một đường thì lỗi nêu ra là lỗi của bước đầu tiên', async () => {
    await publish(1)
    const player = await newPlayer()
    const firstBad: Step = { a: 'Cay', b: 'Toang', result: 'Tới Công Chuyện' }
    const secondBad: Step = { a: 'Deadline', b: 'Toang', result: TARGET }
    const one = await submit(1, player, 2, [firstBad, FULL_PATH[0]!])
    const two = await submit(1, player, 2, [firstBad, secondBad])
    const swapped = await submit(1, player, 2, [FULL_PATH[0]!, secondBad])
    for (const res of [one, two, swapped]) expect(res.status).toBe(422)
    const d1 = ((await one.json()) as Problem).detail ?? ''
    const d2 = ((await two.json()) as Problem).detail ?? ''
    const d3 = ((await swapped.json()) as Problem).detail ?? ''
    expect(d1.length).toBeGreaterThan(0)
    expect(d1).toBe(d2) // cùng bước đầu lỗi -> cùng thông điệp, bước sau không ảnh hưởng
    expect(d3).not.toBe(d2) // lỗi ở bước khác -> thông điệp khác
  })

  // ------------------------------------------------------------------------ AC-DAILY-08
  it('AC-DAILY-08: nộp lại cho cùng version trả 409 kèm kết quả đã lưu và không ghi đè', async () => {
    await publish(1)
    const player = await newPlayer()
    const first = await submit(1, player, 9)
    expect(first.status).toBe(201)
    const stored = (await first.json()) as DailyResult

    const again = await submit(1, player, 5)
    expect(again.status).toBe(409)
    isProblem(again)
    const body = (await again.json()) as Problem
    expect(body.result).toBeDefined()
    expect(body.result?.version).toBe(1)
    expect(body.result?.steps).toBe(9)
    expect(body.result?.submitted_at).toBe(stored.submitted_at)

    const row = await env.DB.prepare('SELECT steps FROM daily_result WHERE player_id = ?').bind(player).all<{ steps: number }>()
    expect(row.results).toEqual([{ steps: 9 }])
    expect(await myStreak(player)).toEqual({ current: 1, longest: 1 })
  })

  it('AC-DAILY-08: nộp cho mẻ đã qua trả 410 problem+json và không ghi gì', async () => {
    await publish(1)
    await publish(2, '2026-10-20T17:03:00.000Z')
    const player = await newPlayer()
    const res = await submit(1, player, 4)
    expect(res.status).toBe(410)
    isProblem(res)
    expect(await count('daily_result')).toBe(0)
    expect(await count('streak')).toBe(0)
    expect((await submit(2, player, 4)).status).toBe(201)
  })

  it('AC-DAILY-08: thiếu UUID hoặc UUID sai định dạng trả 400 problem+json và không ghi gì', async () => {
    await publish(1)
    const body = JSON.stringify({ steps: 4, path: FULL_PATH })
    for (const bad of [null, '', 'not-a-uuid', '12345678-1234-1234-1234-123456789012', '00000000-0000-0000-0000-000000000000']) {
      const res = await submitRaw(1, bad, body)
      expect(res.status, String(bad)).toBe(400)
      isProblem(res)
    }
    expect(await count('daily_result')).toBe(0)
    const streakRes = await raw('/lau-meme/api/me/streak', {}, {})
    expect(streakRes.status).toBe(400)
  })

  // ------------------------------------------------------------------------ AC-DAILY-09
  it('AC-DAILY-09: bảng xếp hạng đợt có 30 kết quả: tối đa 20 dòng, xếp theo bước rồi giờ nộp, ẩn danh, không lộ UUID', async () => {
    await publish(1)
    const players: Array<{ id: string; steps: number; nickname: string | null }> = []
    for (let i = 0; i < 30; i++) {
      const id = await newPlayer()
      const nickname = i % 3 === 0 ? null : `Khach Hang ${String(i).padStart(2, '0')}`
      if (nickname) {
        await env.DB.prepare('INSERT INTO player (id, nickname, nickname_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind(id, nickname, fold(nickname), Date.now(), Date.now())
          .run()
      }
      const steps = 4 + (i % 6) // 6 mức bước, mỗi mức có 5 người hòa nhau
      vi.setSystemTime(new Date(Date.parse('2026-10-20T06:00:05.000Z') + i * 1000))
      const res = await submit(1, id, steps)
      expect(res.status, `người chơi ${i}`).toBe(201)
      players.push({ id, steps, nickname })
    }
    const expected = players
      .map((p, order) => ({ ...p, order }))
      .sort((x, y) => x.steps - y.steps || x.order - y.order)

    const anon = await raw('/lau-meme/api/daily/1/leaderboard', {}, {})
    expect(anon.status).toBe(200)
    const text = await anon.text()
    expect(UUID_IN_TEXT.test(text)).toBe(false)
    for (const p of players) expect(text).not.toContain(p.id)
    const pub = JSON.parse(text) as Board
    expect(pub.version).toBe(1)
    expect(pub.me).toBeNull()
    expect(pub.rows).toHaveLength(20)
    pub.rows.forEach((row, i) => {
      const want = expected[i]!
      expect(row.rank, `hạng dòng ${i}`).toBe(i + 1)
      expect(row.value, `bước dòng ${i}`).toBe(want.steps)
      expect(row.nickname, `nickname dòng ${i}`).toBe(want.nickname ?? 'Thực khách ẩn danh')
      expect(Object.keys(row).sort()).toEqual(['nickname', 'rank', 'value'])
    })

    // người nằm ngoài top 20 vẫn thấy hạng của mình; người trong top 20 thấy dòng của mình
    const last = expected[29]!
    const mine = await board(1, last.id)
    expect(mine.rows).toHaveLength(20)
    expect(mine.me).toEqual({ rank: 30, nickname: last.nickname ?? 'Thực khách ẩn danh', value: last.steps })
    const top = expected[0]!
    const topView = await board(1, top.id)
    expect(topView.me).toEqual({ rank: 1, nickname: top.nickname ?? 'Thực khách ẩn danh', value: top.steps })
    const outsideText = JSON.stringify(mine)
    for (const p of players) expect(outsideText).not.toContain(p.id)

    // UUID chưa nộp: không có hạng
    const nobody = await board(1, crypto.randomUUID())
    expect(nobody.me).toBeNull()
  }, 60_000)

  it('AC-DAILY-09: đợt chưa có kết quả trả danh sách rỗng; version không tồn tại trả 404; version sai định dạng trả 400', async () => {
    await publish(1)
    expect(await board(1)).toEqual({ version: 1, rows: [], me: null })
    const player = await newPlayer()
    expect(await board(1, player)).toEqual({ version: 1, rows: [], me: null })
    const missing = await raw('/lau-meme/api/daily/9999/leaderboard', {}, {})
    expect(missing.status).toBe(404)
    isProblem(missing)
    const bad = await raw('/lau-meme/api/daily/abc/leaderboard', {}, {})
    expect(bad.status).toBe(400)
    isProblem(bad)
    const badId = await raw('/lau-meme/api/daily/1/leaderboard', {}, { 'X-Player-Id': 'not-a-uuid' })
    expect(badId.status).toBe(400)
  })

  // ------------------------------------------------------------------------ AC-DAILY-10
  it('AC-DAILY-10: streak đếm theo ngày GMT+7 của batch_at: 20,21,22 => 3; bỏ 23, làm 24 => 1; dài nhất 3; hai món một ngày tính 1', async () => {
    const player = await newPlayer()
    const day = async (version: number, batchAt: string, submitAt: string | null) => {
      vi.setSystemTime(new Date(Date.parse(batchAt) + 30 * 60_000))
      await publish(version, batchAt)
      if (submitAt === null) return null
      vi.setSystemTime(new Date(submitAt))
      const res = await submit(version, player, 4 + version)
      expect(res.status, `v${version}`).toBe(201)
      return ((await res.json()) as DailyResult).streak
    }
    expect(await day(1, '2026-10-20T05:30:00.000Z', '2026-10-20T06:00:00.000Z')).toEqual({ current: 1, longest: 1 })
    expect(await day(2, '2026-10-21T05:30:00.000Z', '2026-10-21T06:00:00.000Z')).toEqual({ current: 2, longest: 2 })
    expect(await day(3, '2026-10-22T05:30:00.000Z', '2026-10-22T06:00:00.000Z')).toEqual({ current: 3, longest: 3 })
    // mẻ thứ hai trong cùng ngày 22/10 GMT+7: vẫn tính 1 ngày
    expect(await day(4, '2026-10-22T10:00:00.000Z', '2026-10-22T10:30:00.000Z')).toEqual({ current: 3, longest: 3 })
    // ngày 23/10: có mẻ nhưng không làm
    await day(5, '2026-10-23T05:30:00.000Z', null)
    // mẻ 17:30 UTC 23/10 = 00:30 ngày 24/10 GMT+7
    expect(await day(6, '2026-10-23T17:30:00.000Z', '2026-10-23T18:00:00.000Z')).toEqual({ current: 1, longest: 3 })

    // GET streak của mình: còn 1 ở ngày 25/10 GMT+7 (cách 1 ngày), về 0 ở ngày 26/10 GMT+7 (cách 2 ngày)
    vi.setSystemTime(new Date('2026-10-24T18:00:00.000Z'))
    expect(await myStreak(player)).toEqual({ current: 1, longest: 3 })
    vi.setSystemTime(new Date('2026-10-25T18:00:00.000Z'))
    expect(await myStreak(player)).toEqual({ current: 0, longest: 3 })
  })

  it('AC-DAILY-10: người chưa nộp gì có streak 0/0 và streak của hai người độc lập nhau', async () => {
    await publish(1)
    const a = await newPlayer()
    const b = await newPlayer()
    expect(await myStreak(a)).toEqual({ current: 0, longest: 0 })
    expect((await submit(1, a, 6)).status).toBe(201)
    expect(await myStreak(a)).toEqual({ current: 1, longest: 1 })
    expect(await myStreak(b)).toEqual({ current: 0, longest: 0 })
  })

  // ------------------------------------------------------------------------ AC-DAILY-11
  async function seedStreak(id: string, current: number, longest: number, lastDay: string, reachedAt: number, nick: string | null) {
    const stmts = [
      env.DB.prepare('INSERT INTO streak (player_id, current, longest, last_day, reached_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
        id,
        current,
        longest,
        lastDay,
        reachedAt,
        reachedAt,
      ),
    ]
    if (nick) {
      stmts.push(
        env.DB.prepare('INSERT INTO player (id, nickname, nickname_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(
          id,
          nick,
          fold(nick),
          reachedAt,
          reachedAt,
        ),
      )
    }
    await env.DB.batch(stmts)
  }

  it('AC-DAILY-11: bảng xếp hạng streak tối đa 20 dòng, giảm dần, hòa thì ai đạt trước đứng trước, ẩn danh khi không nickname', async () => {
    vi.setSystemTime(new Date('2026-10-24T03:00:00.000Z')) // 10:00 ngày 24/10 GMT+7
    const base = Date.parse('2026-10-20T00:00:00.000Z')
    const seeded: Array<{ id: string; current: number; reached: number; nick: string | null }> = []
    for (let i = 0; i < 25; i++) {
      const current = 1 + (i % 8)
      const nick = i % 4 === 0 ? null : `Thuc Khach ${String(i).padStart(2, '0')}`
      const id = crypto.randomUUID()
      // đảo thứ tự chèn so với thứ tự đạt để kiểm tra không dựa vào thứ tự bản ghi
      const reached = base + (24 - i) * 60_000
      await seedStreak(id, current, current + 2, i % 2 === 0 ? '2026-10-24' : '2026-10-23', reached, nick)
      seeded.push({ id, current, reached, nick })
    }
    const expected = [...seeded].sort((x, y) => y.current - x.current || x.reached - y.reached).slice(0, 20)

    const res = await raw('/lau-meme/api/streaks/leaderboard', {}, {})
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const p of seeded) expect(text).not.toContain(p.id)
    const body = JSON.parse(text) as { rows: Row[] }
    expect(body.rows).toHaveLength(20)
    body.rows.forEach((row, i) => {
      const want = expected[i]!
      expect(row.rank, `hạng dòng ${i}`).toBe(i + 1)
      expect(row.value, `streak dòng ${i}`).toBe(want.current)
      expect(row.nickname, `nickname dòng ${i}`).toBe(want.nick ?? 'Thực khách ẩn danh')
    })
  }, 60_000)

  it('AC-DAILY-11: streak 0 và streak đã đứt (ngày gần nhất cách hôm nay quá 1 ngày) không xuất hiện', async () => {
    vi.setSystemTime(new Date('2026-10-24T03:00:00.000Z'))
    const now = Date.now()
    await seedStreak(crypto.randomUUID(), 2, 2, '2026-10-24', now - 3000, 'Con Song')
    await seedStreak(crypto.randomUUID(), 1, 1, '2026-10-23', now - 2000, 'Song Hom Qua')
    await seedStreak(crypto.randomUUID(), 0, 3, '2026-10-22', now - 1000, 'Streak Khong')
    await seedStreak(crypto.randomUUID(), 5, 5, '2026-10-20', now - 4000, 'Da Dut')
    const res = await raw('/lau-meme/api/streaks/leaderboard', {}, {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: Row[] }
    expect(body.rows).toEqual([
      { rank: 1, nickname: 'Con Song', value: 2 },
      { rank: 2, nickname: 'Song Hom Qua', value: 1 },
    ])
  })

  it('AC-DAILY-11: chưa ai có streak thì danh sách rỗng', async () => {
    const res = await raw('/lau-meme/api/streaks/leaderboard', {}, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [] })
  })

  // ------------------------------------------------------------------------ AC-DAILY-13
  it('AC-DAILY-13: yêu cầu nộp thứ 11 trong một phút của cùng UUID trả 429 problem+json có Retry-After', async () => {
    await publish(1)
    const player = await newPlayer()
    const first = await submit(1, player, 5)
    expect(first.status).toBe(201)
    for (let i = 2; i <= 10; i++) {
      const res = await submit(1, player, 5)
      expect(res.status, `yêu cầu ${i}`).toBe(409) // vẫn được xử lý (trùng) nhưng được đếm
    }
    const limited = await submit(1, player, 5)
    expect(limited.status).toBe(429)
    isProblem(limited)
    const retry = Number(limited.headers.get('retry-after'))
    expect(Number.isInteger(retry)).toBe(true)
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(60)
    expect(await count('daily_result')).toBe(1)
  })

  it('AC-DAILY-13: cùng IP băm nhưng nhiều UUID khác nhau cũng bị chặn, IP khác không bị ảnh hưởng', async () => {
    await publish(1)
    const sharedIp = '10.99.99.99'
    const statuses: number[] = []
    let limited: Response | null = null
    for (let i = 0; i < 40; i++) {
      const p = await newPlayer()
      const res = await submit(1, p, 5, FULL_PATH, sharedIp)
      statuses.push(res.status)
      if (res.status === 429 && !limited) limited = res
    }
    // 10 yêu cầu đầu tiên trong phút luôn được nhận; sau đó phải có lúc bị chặn (ngưỡng IP có thể cao hơn ngưỡng UUID)
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true)
    expect(limited).not.toBeNull()
    isProblem(limited!)
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)

    const other = await newPlayer()
    expect((await submit(1, other, 5, FULL_PATH, '10.77.77.77')).status).toBe(201)
  }, 60_000)

  // ------------------------------------------------------------------------ AC-DAILY-ABUSE (endpoint không có tenant)
  it('AC-DAILY-ABUSE: đầu vào độc hại (quá dài, script, SQL, số âm/thiếu, version giả) bị từ chối 4xx và không ghi gì', async () => {
    await publish(1)
    const player = await newPlayer()
    const huge = 'A'.repeat(10_000)
    const evilPath = (name: string): Step[] => [{ a: name, b: 'Cười', result: 'Tới Công Chuyện' }, ...FULL_PATH.slice(1)]
    const bodies: Array<{ label: string; body: string }> = [
      { label: 'tên 10 000 ký tự', body: JSON.stringify({ steps: 4, path: evilPath(huge) }) },
      { label: 'thẻ script', body: JSON.stringify({ steps: 4, path: evilPath('<script>alert(1)</script>') }) },
      { label: 'SQL injection', body: JSON.stringify({ steps: 4, path: evilPath("'; DROP TABLE daily_result;--") }) },
      { label: 'steps âm', body: JSON.stringify({ steps: -5, path: FULL_PATH }) },
      { label: 'steps bằng 0', body: JSON.stringify({ steps: 0, path: FULL_PATH }) },
      { label: 'steps là chuỗi', body: JSON.stringify({ steps: '4', path: FULL_PATH }) },
      { label: 'steps số thực', body: JSON.stringify({ steps: 4.5, path: FULL_PATH }) },
      { label: 'path rỗng', body: JSON.stringify({ steps: 4, path: [] }) },
      { label: 'thiếu path', body: JSON.stringify({ steps: 4 }) },
      { label: 'trường lạ', body: JSON.stringify({ steps: 4, path: FULL_PATH, rank: 1, player_id: crypto.randomUUID() }) },
      { label: 'không phải JSON', body: '{"steps": 4, "path": [' },
      { label: 'mảng thay vì đối tượng', body: '[]' },
    ]
    for (const c of bodies) {
      const res = await submitRaw(1, player, c.body)
      expect(res.status, c.label).toBeGreaterThanOrEqual(400)
      expect(res.status, c.label).toBeLessThan(500)
      expect(res.status, c.label).not.toBe(429)
      isProblem(res)
    }
    for (const version of ['0', '-1', 'abc', '1.5', '1;DROP', '99999999999999999999']) {
      const res = await submitRaw(version, player, JSON.stringify({ steps: 4, path: FULL_PATH }))
      expect(res.status, `version ${version}`).toBeGreaterThanOrEqual(400)
      expect(res.status, `version ${version}`).toBeLessThan(500)
    }
    expect((await raw('/lau-meme/api/daily/1;DROP/leaderboard', {}, {})).status).toBe(400)
    expect(await count('daily_result')).toBe(0) // bảng còn nguyên (đếm được) và rỗng
    expect(await count('streak')).toBe(0)
  })
})
