// @vitest-environment jsdom
// AC-DAILY-04 / AC-DAILY-05: bàn thử thách, đếm bước, khôi phục sau khi tải lại.
// Expected module `./challenge` (headless controller, UI binds to it):
//   type ElementRef = { id: string; name: string; emoji: string }
//   type GraphResult = { id; name; emoji; depth; added_version; image_key } | null   // kết quả giải mã graph
//   openChallenge(deps: {
//     version: number
//     daily: { element_id: string; emoji: string; hint: string; depth: number }
//     starters: ElementRef[]                                        // 4 phần tử khởi đầu từ manifest
//     lookup: (a: string, b: string) => Promise<GraphResult>        // tra graph theo tên, null = trượt
//     onDiscover: (el: ElementRef) => void                          // thêm vào Đĩa chính
//     storage?: Storage                                             // mặc định localStorage
//   }): Challenge   // khôi phục từ storage nếu cùng version; version khác thì đóng bàn cũ và bắt đầu mới
//   Challenge.getState(): { version; board: ElementRef[]; steps: number; solved: boolean;
//                           targetLabel: string; path: { a: string; b: string; result: string }[] }
//   Challenge.combine(a: ElementRef, b: ElementRef): Promise<{ ok: boolean; result: ElementRef | null; solved: boolean }>
//   Challenge.submission(): { steps: number; path: { a: string; b: string; result: string }[] }
//                           // path chỉ gồm lượt ghép thành công theo thứ tự; steps tính cả lượt trượt
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openChallenge } from './challenge'

type ElementRef = { id: string; name: string; emoji: string }

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const eid = (name: string) => createHash('sha256').update(`lm1|e|${fold(name)}`).digest('base64url')
const ref = (name: string, emoji = '🍲'): ElementRef => ({ id: eid(name), name, emoji })

const STARTERS = [ref('Cay', '🌶️'), ref('Cười', '😂'), ref('Toang', '💀'), ref('Deadline', '⏰')]
const CHAIN = [
  ['Cay', 'Cười', 'Tới Công Chuyện'],
  ['Tới Công Chuyện', 'Deadline', 'Chạy Deadline'],
  ['Chạy Deadline', 'Toang', 'Hết Cứu'],
  ['Hết Cứu', 'Cay', 'Stonks'],
] as const
const DAILY = { element_id: eid('Stonks'), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 }
const pairKey = (a: string, b: string) => [fold(a), fold(b)].sort().join('|')
const GRAPH = new Map(CHAIN.map(([a, b, r], i) => [pairKey(a, b), { ...ref(r), depth: i + 1, added_version: 0, image_key: null }]))
const lookup = async (a: string, b: string) => GRAPH.get(pairKey(a, b)) ?? null

function open(version = 7, onDiscover: (el: ElementRef) => void = () => {}) {
  return openChallenge({ version, daily: DAILY, starters: STARTERS, lookup, onDiscover, storage: localStorage })
}
const pick = (c: ReturnType<typeof open>, name: string) => {
  const el = c.getState().board.find((e) => e.name === name)
  if (!el) throw new Error(`không có ${name} trên bàn thử thách`)
  return el
}
const mix = (c: ReturnType<typeof open>, a: string, b: string) => c.combine(pick(c, a), pick(c, b))

beforeEach(() => {
  localStorage.clear()
})

describe('challenge', () => {
  it('AC-DAILY-04: bàn bắt đầu từ 4 phần tử khởi đầu, 7 lượt (2 trượt) cho bộ đếm 7 bước, tên lộ khi ghép ra món đích', async () => {
    const discovered: ElementRef[] = []
    const c = open(7, (el) => discovered.push(el))
    const start = c.getState()
    expect(start.board.map((e) => e.id)).toEqual(STARTERS.map((s) => s.id))
    expect(start.steps).toBe(0)
    expect(start.solved).toBe(false)
    expect(start.targetLabel).toBe('???')

    expect((await mix(c, 'Cay', 'Toang')).ok).toBe(false) // 1: trượt
    expect((await mix(c, 'Cay', 'Cười')).ok).toBe(true) // 2
    expect((await mix(c, 'Tới Công Chuyện', 'Deadline')).ok).toBe(true) // 3
    expect((await mix(c, 'Tới Công Chuyện', 'Toang')).ok).toBe(false) // 4: trượt
    expect((await mix(c, 'Cười', 'Cay')).ok).toBe(true) // 5: ghép lại món đã có vẫn là một bước
    expect(c.getState().solved).toBe(false)
    expect(c.getState().targetLabel).toBe('???')
    expect((await mix(c, 'Chạy Deadline', 'Toang')).ok).toBe(true) // 6
    expect(c.getState().steps).toBe(6)

    const last = await mix(c, 'Hết Cứu', 'Cay') // 7: ra món đích
    expect(last.ok).toBe(true)
    expect(last.solved).toBe(true)
    expect(last.result?.id).toBe(DAILY.element_id)

    const end = c.getState()
    expect(end.steps).toBe(7)
    expect(end.solved).toBe(true)
    expect(end.targetLabel).toBe('Stonks')
    expect(end.board.map((e) => e.name)).toEqual(expect.arrayContaining(['Tới Công Chuyện', 'Chạy Deadline', 'Hết Cứu', 'Stonks']))

    // phần tử khám phá trên bàn thử thách cũng được thêm vào Đĩa chính
    const names = discovered.map((e) => e.name)
    for (const [, , result] of CHAIN) expect(names).toContain(result)

    const sub = c.submission()
    expect(sub.steps).toBe(7)
    expect(sub.path.map((s) => s.result)).toContain('Stonks')
    expect(sub.path[sub.path.length - 1]).toEqual({ a: 'Hết Cứu', b: 'Cay', result: 'Stonks' })
  })

  it('AC-DAILY-04: chỉ lộ tên khi khóa băm của kết quả trùng element_id của manifest', async () => {
    const decoy = vi.fn(async () => ({ ...ref('Món Khác'), depth: 4, added_version: 0, image_key: null }))
    const c = openChallenge({
      version: 7,
      daily: DAILY,
      starters: STARTERS,
      lookup: decoy,
      onDiscover: () => {},
      storage: localStorage,
    })
    const res = await c.combine(c.getState().board[0]!, c.getState().board[1]!)
    expect(res.ok).toBe(true)
    expect(res.solved).toBe(false)
    expect(c.getState().targetLabel).toBe('???')
    expect(c.getState().solved).toBe(false)
  })

  it('AC-DAILY-05: tải lại trong cùng mẻ khôi phục bàn, phần tử đã có và bộ đếm 4 bước; chơi tiếp được', async () => {
    const first = open(7)
    await mix(first, 'Cay', 'Cười')
    await mix(first, 'Tới Công Chuyện', 'Deadline')
    await mix(first, 'Cay', 'Toang') // trượt vẫn tính
    await mix(first, 'Chạy Deadline', 'Toang')
    expect(first.getState().steps).toBe(4)

    const reloaded = open(7) // "tải lại trang": đối tượng mới, cùng localStorage
    const s = reloaded.getState()
    expect(s.version).toBe(7)
    expect(s.steps).toBe(4)
    expect(s.solved).toBe(false)
    expect(s.board.map((e) => e.name)).toEqual(
      expect.arrayContaining(['Cay', 'Cười', 'Toang', 'Deadline', 'Tới Công Chuyện', 'Chạy Deadline', 'Hết Cứu']),
    )
    expect(s.board).toHaveLength(7)
    const done = await mix(reloaded, 'Hết Cứu', 'Cay')
    expect(done.solved).toBe(true)
    expect(reloaded.getState().steps).toBe(5)

    // đã giải xong rồi tải lại: vẫn thấy đã giải và tên món
    const again = open(7)
    expect(again.getState().solved).toBe(true)
    expect(again.getState().targetLabel).toBe('Stonks')
    expect(again.getState().steps).toBe(5)
  })

  it('AC-DAILY-05: sang mẻ mới thì thử thách cũ đóng và bàn mới bắt đầu từ 4 phần tử khởi đầu', async () => {
    const old = open(7)
    await mix(old, 'Cay', 'Cười')
    await mix(old, 'Cay', 'Toang')
    expect(old.getState().steps).toBe(2)

    const fresh = open(8)
    const s = fresh.getState()
    expect(s.version).toBe(8)
    expect(s.steps).toBe(0)
    expect(s.solved).toBe(false)
    expect(s.targetLabel).toBe('???')
    expect(s.board.map((e) => e.id)).toEqual(STARTERS.map((x) => x.id))
  })
})
