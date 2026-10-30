// Phủ (thêm 2026-10-30, câu hỏi mở 102) phần worker / tab "Bị chặn" của:
//   AC-MOD-12  dòng `not_meme` bước layer1 từ mẻ success: tab "Bị chặn" hiện nhãn "Không phải meme", lọc được theo lý do
//              `not_meme` (và theo bước), Bỏ chặn được và vào /pipeline/state.unblocked (AC-PIPE-21).
//   AC-MOD-13  dòng `not_meme` bước layer2 cũng lọc được theo lý do và bước.
// Nhãn "Không phải meme" do pipeline gửi trong `reasons[].label` (AC-MOD-11); worker lưu và trả nguyên văn.
// Black-box: docs/api/openapi.yaml 0.11.0 (/admin/rejected, /pipeline/batches). Phần giao diện web của tab "Bị chặn":
// xem ghi chú của test-author (không tìm được test web của AC-MOD-11 / AC-ADMIN-13 để mở rộng).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'

const TOKEN = ['nm', 'admin', 'token', 'ok'].join('-')
const PIPELINE_TOKEN = ['nm', 'pipeline', 'token'].join('-')
const IP_KEY = ['nm', 'ip', 'hash', 'key'].join('-')
const ADMIN_ORIGIN = 'https://laumeme-admin.dinoduct.fun'
const GAME_API = 'https://dinoduct.fun/lau-meme/api'

type Handler = { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> }
type Reason = { code: string; label: string }
type Rej = { id: string; name: string; reasons: Reason[]; step: string; status: string; seen_count: number }
type Page<T> = { page: number; size: number; total: number; items: T[] }
type State = { current_version: number | null; unblocked: Array<{ id: string; name: string; fold: string }> }

const enc = new TextEncoder()
const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
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
  const [x, y] = [fold(a), fold(b)].sort()
  return b64u(await sha256(`lm1|k|${x}\0${y}`))
}

const NOT_MEME: Reason[] = [{ code: 'not_meme', label: 'Không phải meme' }]
const POLITICS: Reason[] = [{ code: 'politics', label: 'Chính trị' }]
const LIVE = '🔴 TRỰC TIẾP: BOX GAMING vs BOOM ESPORTS | GIAI ĐOẠN PLAYOFFS | ĐTDV MÙA ĐÔNG 2026'
const SWISS = 'Ngày 1 | CKTG 2026 - Vòng Swiss Ngày 24.10.2026'
const TEAM = 'đội tuyển bóng đá quốc gia bồ đào nha'
const SONG = 'AI Rumpelstiltskin "Tip Toein\' In My Jordans"'
const POL = 'Nm Chính Trị Thử'
const EC = 'Nm Món C'

async function raw(url: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await (worker as unknown as Handler).fetch(
    new Request(url, { ...init, headers: h }),
    { ...env, ADMIN_TOKEN: TOKEN, PIPELINE_TOKEN, IP_HASH_KEY: IP_KEY },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}
let ipCounter = 0
const nextIp = () => {
  ipCounter++
  return `10.70.${ipCounter >> 8}.${ipCounter & 255}`
}
const A = (path: string, o: { method?: string; body?: unknown } = {}) =>
  raw(
    `${ADMIN_ORIGIN}/api/admin${path}`,
    { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) },
    { 'CF-Connecting-IP': nextIp(), Authorization: `Bearer ${TOKEN}` },
  )
const pipelineHeaders = () => ({ Authorization: `Bearer ${PIPELINE_TOKEN}`, 'CF-Connecting-IP': nextIp() })
const json = async <T>(res: Response) => (await res.json()) as T
const listRejected = async (qs = '') => json<Page<Rej>>(await A(`/rejected${qs}`))
const names = async (qs = '') => (await listRejected(qs)).items.map((r) => r.name).sort()
const getState = async () => json<State>(await raw(`${GAME_API}/pipeline/state`, {}, pipelineHeaders()))

const rej = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  fold: fold(name),
  source_name: 'YouTube',
  source_url: 'https://example.com/a',
  context: 'Ngữ cảnh nguồn',
  reasons: NOT_MEME,
  step: 'layer1',
  ...o,
})

async function publish(version: number, rejected: unknown[]): Promise<Response> {
  const starterNames = ['Cay', 'Cười', 'Toang', 'Deadline']
  const starters = await Promise.all(starterNames.map(elementId))
  const batchAt = '2026-10-29T05:30:00.000Z'
  const target = await elementId(EC)
  const [x, y] = [starters[0]!, starters[1]!].sort()
  const body = {
    status: 'success',
    version,
    batch_at: batchAt,
    mode: 'core',
    manifest: {
      version,
      batch_at: batchAt,
      graph_url: `/api/graph/${version}`,
      starters: starters.map((id, i) => ({ id, name: starterNames[i], emoji: '🔥' })),
      miss_lines: ['Chưa đúng vị, thử lại nhé.'],
      daily: { element_id: target, emoji: '🍲', hint: 'Món cay cay', depth: 4 },
    },
    graph: { format: 1, version, entries: { [await elementId(`g|${version}`)]: 'abc' } },
    content: {
      elements: [
        ...starters.map((id, i) => ({ id, name: starterNames[i]!, fold: fold(starterNames[i]!), emoji: '🔥', depth: 0 })),
        { id: target, name: EC, fold: fold(EC), emoji: '🍲', depth: 4, auto_tier: 2 },
      ],
      recipes: [{ id: await recipeId('Cay', 'Cười'), a: x, b: y, result: target }],
      starters,
      daily_element_id: target,
    },
    stats: { crawled: 0, added: 0, queued: 0, quota_used: 0, source_errors: [], blocked: { 'không phải meme': 3 } },
    rejected,
  }
  return raw(`${GAME_API}/pipeline/batches`, { method: 'POST', body: JSON.stringify(body) }, pipelineHeaders())
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rejected_concept'),
    env.DB.prepare('DELETE FROM element_edit'),
    env.DB.prepare('DELETE FROM element_alias'),
    env.DB.prepare('DELETE FROM content_change'),
    env.DB.prepare('DELETE FROM admin_change'),
    env.DB.prepare('DELETE FROM admin_audit'),
    env.DB.prepare('DELETE FROM block'),
    env.DB.prepare('DELETE FROM rate_counter'),
    env.DB.prepare('DELETE FROM batch_content'),
    env.DB.prepare('DELETE FROM batch_run'),
    env.DB.prepare('DELETE FROM recipe'),
    env.DB.prepare('DELETE FROM element'),
    env.DB.prepare("DELETE FROM app_meta WHERE key = 'current_version'"),
  ])
})

describe('not_meme in the rejected list (worker)', () => {
  it(
    'AC-MOD-12: dòng lớp 1 `not_meme` từ mẻ success hiện nhãn "Không phải meme", bước layer1, trạng thái Bị chặn, lọc được theo lý do và theo bước',
    async () => {
      const res = await publish(1, [
        rej(LIVE, { step: 'layer1' }),
        rej(SWISS, { step: 'layer1' }),
        rej(POL, { reasons: POLITICS, step: 'layer2' }),
      ])
      expect(res.status).toBe(201)

      const page = await listRejected()
      expect(page.total).toBe(3)
      const live = page.items.find((r) => r.name === LIVE)!
      expect(live).toMatchObject({ step: 'layer1', status: 'blocked', seen_count: 1, reasons: NOT_MEME })
      expect(live.reasons[0]!.label).toBe('Không phải meme')

      expect(await names('?reason=not_meme')).toEqual([LIVE, SWISS].sort())
      expect(await names('?reason=politics')).toEqual([POL])
      expect(await names('?reason=not_meme&step=layer1')).toEqual([LIVE, SWISS].sort())
      expect(await names('?reason=not_meme&step=layer2')).toEqual([])
    },
    120_000,
  )

  it(
    'AC-MOD-12: admin Bỏ chặn dòng `not_meme` trả 200, dòng thành "unblocked" và nằm trong /pipeline/state.unblocked để mẻ sau bỏ qua kiểm duyệt (AC-PIPE-21)',
    async () => {
      expect((await publish(1, [rej(LIVE), rej(SWISS)])).status).toBe(201)
      const row = (await listRejected('?reason=not_meme')).items.find((r) => r.name === LIVE)!

      const ok = await A(`/rejected/${row.id}/unblock`, { method: 'POST', body: {} })
      expect(ok.status).toBe(200)
      expect((await json<Rej>(ok)).status).toBe('unblocked')

      const { unblocked } = await getState()
      expect(unblocked.map((u) => u.name)).toEqual([LIVE])
      expect(unblocked[0]!.fold).toBe(fold(LIVE))
      expect((await listRejected('?reason=not_meme&status=unblocked')).total).toBe(1)
      expect((await listRejected('?reason=not_meme&status=blocked')).total).toBe(1)
    },
    120_000,
  )

  it(
    'AC-MOD-13: dòng lớp 2 `not_meme` (tên đội, tên người, tên bài hát) hiện nhãn "Không phải meme", bước layer2, lọc được theo lý do và bước',
    async () => {
      const res = await publish(1, [
        rej(TEAM, { step: 'layer2' }),
        rej('thủy tiên', { step: 'layer2' }),
        rej(SONG, { step: 'layer2' }),
        rej(LIVE, { step: 'layer1' }),
      ])
      expect(res.status).toBe(201)

      const layer2 = await listRejected('?reason=not_meme&step=layer2')
      expect(layer2.total).toBe(3)
      expect(layer2.items.map((r) => r.name).sort()).toEqual([TEAM, 'thủy tiên', SONG].sort())
      for (const r of layer2.items) {
        expect(r.step).toBe('layer2')
        expect(r.reasons).toEqual(NOT_MEME)
        expect(r.reasons[0]!.label).toBe('Không phải meme')
      }
      expect((await listRejected('?reason=not_meme')).total).toBe(4)
      expect((await listRejected('?q=thuy tien&reason=not_meme')).total).toBe(1)
    },
    120_000,
  )

  it(
    'AC-MOD-13: một khái niệm vừa `not_meme` vừa bị lý do khác (người thật) giữ cả hai mã, lọc ra bằng một trong hai lý do',
    async () => {
      const both: Reason[] = [...NOT_MEME, { code: 'real_person', label: 'Người thật' }]
      expect((await publish(1, [rej('thủy tiên', { step: 'layer2', reasons: both })])).status).toBe(201)

      const [row] = (await listRejected()).items
      expect(row!.reasons.map((r) => r.code)).toEqual(['not_meme', 'real_person'])
      expect((await listRejected('?reason=not_meme')).total).toBe(1)
      expect((await listRejected('?reason=real_person')).total).toBe(1)
    },
    120_000,
  )
})
