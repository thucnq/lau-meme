// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho logic thuần của chơi ghép (docs/acceptance/game.md).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU - web/src/game/engine.ts phải export:
 *
 *   types:  SortMode = 'newest' | 'name' | 'depth'
 *           Item = GraphResult-like { id, name, emoji, depth, added_version, image_key: string|null,
 *                                     discovered_at: string /* ISO 8601 UTC *\/ }
 *           TableItem = { uid: string, id: string, name: string, emoji: string, x: number, y: number }
 *           Progress = { graph_version: number, items: Item[], table: TableItem[], sort: SortMode,
 *                        tutorial_seen: boolean, miss_streak: number }
 *           Manifest, Blocklist (đúng schema OpenAPI)
 *           Ctx = { graph: Graph, manifest: Manifest, blocklist: Blocklist, now?: () => Date }
 *           CombineOutcome =
 *             | { kind: 'hit',  result: GraphResult, isNew: boolean, progress: Progress }
 *             | { kind: 'miss', line: string, hint: string | null, progress: Progress }
 *
 *   const:  PROGRESS_KEY: string   (khóa localStorage duy nhất của tiến độ)
 *           THEME_KEY: string      (khóa localStorage của chế độ sáng/tối: 'light' | 'dark')
 *           HINT_AFTER_MISSES = 3
 *
 *   fn:     initialProgress(manifest, now: Date): Progress            // 4 starters, bàn rỗng, sort 'newest'
 *           loadProgress(storage: Storage): Progress | null           // null nếu chưa có / hỏng
 *           saveProgress(storage: Storage, p: Progress): void
 *           migrateProgress(p: Progress, manifest: Manifest): Progress // giữ items, graph_version = manifest.version
 *           visibleItems(p, blocklist): Item[]                        // lọc phần tử bị chặn, KHÔNG sửa p
 *           visibleTable(p, blocklist): TableItem[]
 *           lookupRecipe(ctx, a: string, b: string): Promise<GraphResult | null>  // null nếu không có / bị chặn
 *           combine(ctx, p: Progress, a: string, b: string): Promise<CombineOutcome>  // bất biến, không ghi mạng
 *           missLine(lines: string[], a: string, b: string): string   // tất định theo cặp đã fold, không Math.random
 *           filterItems(items: Item[], query: string): Item[]
 *           sortItems(items: Item[], mode: SortMode): Item[]          // không sửa mảng vào
 *           isNew(item: Item, manifestVersion: number, blocklist: Blocklist): boolean
 *           resolveTheme(stored: string | null, systemDark: boolean): 'light' | 'dark'
 *
 * Gợi ý: chuỗi hiện ra là `Thử ${emoji} ${name} xem`.
 */
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold, lookupKey } from '../graph/crypto'
import type { Graph, GraphResult } from '../graph/crypto'
import {
  HINT_AFTER_MISSES,
  PROGRESS_KEY,
  THEME_KEY,
  combine,
  filterItems,
  initialProgress,
  isNew,
  loadProgress,
  lookupRecipe,
  migrateProgress,
  missLine,
  resolveTheme,
  saveProgress,
  sortItems,
  visibleItems,
  visibleTable,
} from './engine'
import type { Blocklist, Ctx, Item, Manifest, Progress } from './engine'

// ---------------------------------------------------------------- fixtures (ADR 0002, độc lập với production)
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url')
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))

interface Spec {
  a: string
  b: string
  name: string
  emoji?: string
  depth?: number
  added_version?: number
}

async function encryptEntry(version: number, a: string, b: string, plain: object) {
  const [x, y] = [fold(a), fold(b)].sort()
  const key = sha('lm1|k|' + x + '\0' + y)
  const ikm = await webcrypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
  const okm = new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + version), info: enc.encode('lm1|aes-gcm') },
      ikm,
      44 * 8,
    ),
  )
  const aes = await webcrypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt'])
  const ct = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) },
    aes,
    enc.encode(JSON.stringify(plain)),
  )
  return { key, value: b64u(new Uint8Array(ct)) }
}

async function buildGraph(version: number, specs: Spec[]): Promise<Graph> {
  const entries: Record<string, string> = {}
  for (const s of specs) {
    const plain: GraphResult = {
      added_version: s.added_version ?? version,
      depth: s.depth ?? 1,
      emoji: s.emoji ?? '🍲',
      id: eid(s.name),
      image_key: null,
      name: s.name,
    }
    const { key, value } = await encryptEntry(version, s.a, s.b, plain)
    entries[key] = value
  }
  return { format: 1, version, entries }
}

const T0 = new Date('2026-10-20T03:00:00.000Z')
const NOW = (): Date => T0

const STARTERS = [
  { id: eid('Cay'), name: 'Cay', emoji: '🌶️' },
  { id: eid('Cười'), name: 'Cười', emoji: '😂' },
  { id: eid('Toang'), name: 'Toang', emoji: '💀' },
  { id: eid('Deadline'), name: 'Deadline', emoji: '⏰' },
]

const MISS_LINES = Array.from({ length: 40 }, (_, i) => `Nồi trào số ${i}! Khét rồi (${i})`)

function manifestOf(version = 7, lines = MISS_LINES): Manifest {
  return {
    version,
    batch_at: '2026-10-20T00:00:00.000Z',
    graph_url: `/api/graph/${version}`,
    starters: STARTERS,
    miss_lines: lines,
    daily: { element_id: eid('Tới Công Chuyện'), emoji: '🍜', hint: 'gợi ý', depth: 4 },
    policy_version: 1,
  } as Manifest
}

const NO_BLOCK: Blocklist = { elements: [], recipes: [], images: [] }

function item(name: string, emoji: string, depth: number, added_version: number, discovered_at: string): Item {
  return { id: eid(name), name, emoji, depth, added_version, image_key: null, discovered_at }
}

async function ctxOf(specs: Spec[], opts: { version?: number; blocklist?: Blocklist } = {}): Promise<Ctx> {
  const version = opts.version ?? 7
  return {
    graph: await buildGraph(version, specs),
    manifest: manifestOf(version),
    blocklist: opts.blocklist ?? NO_BLOCK,
    now: NOW,
  }
}

const base = (): Progress => initialProgress(manifestOf(), T0)

function names(items: { name: string }[]): string[] {
  return items.map((i) => i.name)
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------- AC-GAME-01
describe('game engine', () => {
  it('AC-GAME-01: tiến độ ban đầu có đúng 4 phần tử khởi đầu từ manifest và bàn rỗng', () => {
    expect(loadProgress(localStorage)).toBeNull()
    const p = initialProgress(manifestOf(), T0)
    expect(p.items).toHaveLength(4)
    expect(p.items.map((i) => [i.name, i.emoji])).toEqual([
      ['Cay', '🌶️'],
      ['Cười', '😂'],
      ['Toang', '💀'],
      ['Deadline', '⏰'],
    ])
    expect(p.items.map((i) => i.id)).toEqual(STARTERS.map((s) => s.id))
    expect(p.table).toEqual([])
    expect(p.graph_version).toBe(7)
    expect(p.miss_streak).toBe(0)
  })

  // ------------------------------------------------------------ AC-GAME-02
  it('AC-GAME-02: ghép thành công thêm C vào Đĩa với thời điểm khám phá, theo cả hai thứ tự', async () => {
    const ctx = await ctxOf([{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', emoji: '🔥', depth: 1 }])
    for (const [a, b] of [
      ['Cay', 'Cười'],
      ['Cười', 'Cay'],
    ] as const) {
      const out = await combine(ctx, base(), a, b)
      expect(out.kind).toBe('hit')
      if (out.kind !== 'hit') return
      expect(out.result.name).toBe('Tới Công Chuyện')
      expect(out.isNew).toBe(true)
      expect(out.progress.items).toHaveLength(5)
      const c = out.progress.items.find((i) => i.name === 'Tới Công Chuyện')!
      expect(c.discovered_at).toBe(T0.toISOString())
      expect(c.emoji).toBe('🔥')
      expect(c.id).toBe(eid('Tới Công Chuyện'))
      expect(out.progress.miss_streak).toBe(0)
    }
  })

  // ------------------------------------------------------------ AC-GAME-03 (phần logic: ghép không phụ thuộc nguồn)
  it('AC-GAME-03: combine không làm đổi tiến độ đầu vào (bất biến) để UI thay A và B bằng C', async () => {
    const ctx = await ctxOf([{ a: 'Cay', b: 'Toang', name: 'Lẩu Cay', depth: 1 }])
    const p = base()
    const snapshot = JSON.stringify(p)
    const out = await combine(ctx, p, 'Cay', 'Toang')
    expect(out.kind).toBe('hit')
    expect(JSON.stringify(p)).toBe(snapshot)
  })

  // ------------------------------------------------------------ AC-GAME-04
  it('AC-GAME-04: ghép ra phần tử đã có thì không trùng và giữ thời điểm khám phá cũ', async () => {
    const ctx = await ctxOf([{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện', depth: 1 }])
    const old = '2026-09-01T10:00:00.000Z'
    const p = base()
    p.items.push(item('Tới Công Chuyện', '🍲', 1, 7, old))
    for (const [a, b] of [
      ['Cay', 'Cười'],
      ['Cười', 'Cay'],
    ] as const) {
      const out = await combine(ctx, p, a, b)
      expect(out.kind).toBe('hit')
      if (out.kind !== 'hit') return
      expect(out.result.name).toBe('Tới Công Chuyện')
      expect(out.isNew).toBe(false)
      expect(out.progress.items).toHaveLength(5)
      expect(out.progress.items.filter((i) => i.name === 'Tới Công Chuyện')).toHaveLength(1)
      expect(out.progress.items.find((i) => i.name === 'Tới Công Chuyện')!.discovered_at).toBe(old)
    }
  })

  // ------------------------------------------------------------ AC-GAME-05
  it('AC-GAME-05: câu Nồi trào chọn tất định theo cặp đã chuẩn hóa, không dùng số ngẫu nhiên', async () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Không được dùng Math.random')
    })
    const getRandomValues = vi.spyOn(webcrypto, 'getRandomValues')
    const ctx = await ctxOf([{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện' }])

    const l1 = missLine(MISS_LINES, 'Cay', 'Toang')
    expect(MISS_LINES).toContain(l1)
    expect(missLine(MISS_LINES, 'Toang', 'Cay')).toBe(l1)
    expect(missLine(MISS_LINES, '  CAY ', 'toang')).toBe(l1)
    expect(missLine(MISS_LINES, 'Cay', 'Toang')).toBe(l1)

    const seen = new Set<string>()
    const pool = ['Cay', 'Cười', 'Toang', 'Deadline', 'Lẩu', 'Bún', 'Phở', 'Cà Phê']
    for (const x of pool) for (const y of pool) seen.add(missLine(MISS_LINES, x, y))
    expect(seen.size).toBeGreaterThanOrEqual(5) // không phải hằng số
    expect(missLine(['chỉ một câu'], 'Cay', 'Toang')).toBe('chỉ một câu')

    const out1 = await combine(ctx, base(), 'Cay', 'Toang')
    const out2 = await combine(ctx, base(), 'Toang', 'Cay')
    expect(out1.kind).toBe('miss')
    expect(out2.kind).toBe('miss')
    if (out1.kind !== 'miss' || out2.kind !== 'miss') return
    expect(out1.line).toBe(l1)
    expect(out2.line).toBe(l1)
    expect(MISS_LINES).toContain(out1.line)
    // A và B vẫn ở Đĩa (không mất), không thêm phần tử
    expect(out1.progress.items).toHaveLength(4)
    expect(random).not.toHaveBeenCalled()
    expect(getRandomValues).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------ AC-GAME-06
  it('AC-GAME-06: sau 3 lần trượt liên tiếp hiện gợi ý "Thử <emoji> <tên> xem" không lộ kết quả, bộ đếm về 0', async () => {
    expect(HINT_AFTER_MISSES).toBe(3)
    // Đĩa: 4 starters + "Tới Công Chuyện" (đã có). Công thức:
    //   Cay + Cười = Tới Công Chuyện (đã có trong Đĩa -> không tính là chưa khám phá)
    //   Toang + Cười = Lẩu Thần Sầu (chưa có)  => X hợp lệ: Toang, Cười
    const ctx = await ctxOf([
      { a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện' },
      { a: 'Toang', b: 'Cười', name: 'Lẩu Thần Sầu' },
    ])
    let p = base()
    p.items.push(item('Tới Công Chuyện', '🔥', 1, 7, '2026-10-01T00:00:00.000Z'))

    const m1 = await combine(ctx, p, 'Cay', 'Deadline')
    expect(m1.kind).toBe('miss')
    if (m1.kind !== 'miss') return
    expect(m1.hint).toBeNull()
    expect(m1.progress.miss_streak).toBe(1)

    const m2 = await combine(ctx, m1.progress, 'Cay', 'Deadline')
    if (m2.kind !== 'miss') throw new Error('miss expected')
    expect(m2.hint).toBeNull()
    expect(m2.progress.miss_streak).toBe(2)

    const m3 = await combine(ctx, m2.progress, 'Cay', 'Deadline')
    if (m3.kind !== 'miss') throw new Error('miss expected')
    expect(m3.line).toBe(m1.line) // cùng câu Nồi trào
    expect(m3.hint).not.toBeNull()
    expect(['Thử 💀 Toang xem', 'Thử 😂 Cười xem']).toContain(m3.hint)
    expect(m3.hint).not.toContain('Lẩu Thần Sầu')
    expect(m3.progress.miss_streak).toBe(0)
    p = m3.progress
    expect(p.items).toHaveLength(5)
  })

  it('AC-GAME-06: một lần ghép thành công làm bộ đếm trượt về 0 (trượt phải liên tiếp)', async () => {
    const ctx = await ctxOf([{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện' }])
    const m1 = await combine(ctx, base(), 'Cay', 'Deadline')
    if (m1.kind !== 'miss') throw new Error('miss expected')
    const m2 = await combine(ctx, m1.progress, 'Cay', 'Deadline')
    if (m2.kind !== 'miss') throw new Error('miss expected')
    expect(m2.progress.miss_streak).toBe(2)
    const hit = await combine(ctx, m2.progress, 'Cay', 'Cười')
    if (hit.kind !== 'hit') throw new Error('hit expected')
    expect(hit.progress.miss_streak).toBe(0)
    const m3 = await combine(ctx, hit.progress, 'Cay', 'Deadline')
    if (m3.kind !== 'miss') throw new Error('miss expected')
    expect(m3.hint).toBeNull()
    expect(m3.progress.miss_streak).toBe(1)
  })

  it('AC-GAME-06: không còn công thức chưa khám phá từ Đĩa hiện tại thì không hiện gợi ý', async () => {
    const ctx = await ctxOf([{ a: 'Cay', b: 'Cười', name: 'Tới Công Chuyện' }])
    const p = base()
    p.items.push(item('Tới Công Chuyện', '🔥', 1, 7, '2026-10-01T00:00:00.000Z'))
    p.miss_streak = 2
    const m3 = await combine(ctx, p, 'Toang', 'Deadline')
    if (m3.kind !== 'miss') throw new Error('miss expected')
    expect(m3.hint).toBeNull()
  })

  // ------------------------------------------------------------ AC-GAME-07
  it('AC-GAME-07: tìm kiếm không dấu dùng fold, rỗng thì trả cả Đĩa', () => {
    const items = [
      item('Cà Phê Sữa Đá', '☕', 3, 1, '2026-10-02T00:00:00.000Z'),
      item('Cà Khịa', '😏', 2, 1, '2026-10-03T00:00:00.000Z'),
    ]
    for (const q of ['ca phe', 'CÀ PHÊ', '  ca   phe ', 'Cà  Phê']) {
      expect(names(filterItems(items, q))).toEqual(['Cà Phê Sữa Đá'])
    }
    expect(names(filterItems(items, 'khia'))).toEqual(['Cà Khịa'])
    expect(names(filterItems(items, ''))).toEqual(['Cà Phê Sữa Đá', 'Cà Khịa'])
    expect(names(filterItems(items, '   '))).toEqual(['Cà Phê Sữa Đá', 'Cà Khịa'])
    expect(filterItems(items, 'không có món này')).toEqual([])
  })

  // ------------------------------------------------------------ AC-GAME-08
  it('AC-GAME-08: sắp xếp theo mới khám phá, tên (fold) và độ sâu (hòa theo tên)', () => {
    const items = [
      item('Cá Chép', '🐟', 1, 1, '2026-10-05T00:00:00.000Z'),
      item('Bún Bò', '🍜', 2, 1, '2026-10-04T00:00:00.000Z'),
      item('Cà Phê', '☕', 3, 1, '2026-10-03T00:00:00.000Z'),
      item('Ăn Vặt', '🍢', 2, 1, '2026-10-02T00:00:00.000Z'),
    ]
    const copy = JSON.stringify(items)
    expect(names(sortItems(items, 'newest'))).toEqual(['Cá Chép', 'Bún Bò', 'Cà Phê', 'Ăn Vặt'])
    expect(names(sortItems(items, 'name'))).toEqual(['Ăn Vặt', 'Bún Bò', 'Cá Chép', 'Cà Phê'])
    expect(names(sortItems(items, 'depth'))).toEqual(['Cá Chép', 'Ăn Vặt', 'Bún Bò', 'Cà Phê'])
    expect(JSON.stringify(items)).toBe(copy) // không sửa mảng vào

    // hòa trên tên đã fold -> theo tên gốc
    const tie = [item('Cà', '1', 1, 1, '2026-10-01T00:00:00.000Z'), item('Ca', '2', 1, 1, '2026-10-01T00:00:00.000Z')]
    expect(names(sortItems(tie, 'name'))).toEqual(['Ca', 'Cà'])
  })

  it('AC-GAME-08: lựa chọn sắp xếp được lưu cục bộ cùng tiến độ', () => {
    const p = base()
    p.sort = 'depth'
    saveProgress(localStorage, p)
    expect(loadProgress(localStorage)!.sort).toBe('depth')
  })

  // ------------------------------------------------------------ AC-GAME-09
  it('AC-GAME-09: nhãn MỚI chỉ cho phần tử thêm ở mẻ hiện tại và không bị chặn', () => {
    const c = item('Món Mới', '🆕', 2, 7, '2026-10-20T00:00:00.000Z')
    const d = item('Món Cũ', '📜', 2, 6, '2026-10-19T00:00:00.000Z')
    const starter = item('Cay', '🌶️', 0, 0, '2026-10-01T00:00:00.000Z')
    expect(isNew(c, 7, NO_BLOCK)).toBe(true)
    expect(isNew(d, 7, NO_BLOCK)).toBe(false)
    expect(isNew(starter, 7, NO_BLOCK)).toBe(false)
    expect(isNew(c, 8, NO_BLOCK)).toBe(false)
    expect(isNew(c, 7, { elements: [c.id], recipes: [], images: [] })).toBe(false)
  })

  // ------------------------------------------------------------ AC-GAME-10
  it('AC-GAME-10: lưu rồi khôi phục tiến độ giống hệt (Đĩa, bàn, sắp xếp, đã xem hướng dẫn)', () => {
    const p = base()
    p.items.push(item('Tới Công Chuyện', '🔥', 1, 7, '2026-10-20T04:00:00.000Z'))
    p.table = [
      { uid: 't1', id: eid('Cay'), name: 'Cay', emoji: '🌶️', x: 120, y: 80 },
      { uid: 't2', id: eid('Toang'), name: 'Toang', emoji: '💀', x: 300, y: 210 },
    ]
    p.sort = 'name'
    p.tutorial_seen = true
    p.miss_streak = 2
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    saveProgress(localStorage, p)
    expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull()
    expect(loadProgress(localStorage)).toEqual(p)
    expect(fetchSpy).not.toHaveBeenCalled() // không gọi API ghi nào
    vi.unstubAllGlobals()
    vi.stubGlobal('crypto', webcrypto)
  })

  it('AC-GAME-10: dữ liệu cục bộ hỏng hoặc rỗng thì trả null, không ném lỗi', () => {
    expect(loadProgress(localStorage)).toBeNull()
    localStorage.setItem(PROGRESS_KEY, '{không phải json')
    expect(loadProgress(localStorage)).toBeNull()
    localStorage.setItem(PROGRESS_KEY, '"<script>alert(1)</script>"')
    expect(loadProgress(localStorage)).toBeNull()
  })

  // ------------------------------------------------------------ AC-GAME-11
  // Cập nhật 2026-10-24 (câu hỏi mở 71): bỏ "Chơi lại từ đầu" nên không còn hàm xóa tiến độ nào để kiểm ở tầng engine.
  // Hành vi "Dọn bàn chỉ xóa bàn, giữ Đĩa/UUID/nickname/Daily" và "không còn nút Chơi lại từ đầu" được kiểm ở Game.test.tsx.

  // ------------------------------------------------------------ AC-GAME-12
  it('AC-GAME-12: trạng thái đã xem hướng dẫn được lưu; tiến độ mới chưa xem', () => {
    const p = base()
    expect(p.tutorial_seen).toBe(false)
    saveProgress(localStorage, { ...p, tutorial_seen: true })
    expect(loadProgress(localStorage)!.tutorial_seen).toBe(true)
  })

  // ------------------------------------------------------------ AC-GAME-13
  it('AC-GAME-13: chế độ tối theo hệ thống khi chưa chọn; lựa chọn đã lưu ưu tiên hơn hệ thống', () => {
    expect(resolveTheme(null, true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('rác', true)).toBe('dark')
    expect(resolveTheme('<script>', false)).toBe('light')
    expect(typeof THEME_KEY).toBe('string')
  })

  // ------------------------------------------------------------ AC-GAME-14
  it('AC-GAME-14: 1000 lượt tra + giải mã (363 công thức) không gọi mạng, p95 < 50 ms', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('Không được gọi mạng')
    })
    vi.stubGlobal('fetch', fetchSpy)

    const pool = Array.from({ length: 28 }, (_, i) => `Nguyên Liệu ${i}`)
    const specs: Spec[] = []
    outer: for (let i = 0; i < pool.length; i++) {
      for (let j = i; j < pool.length; j++) {
        if (specs.length === 363) break outer
        specs.push({ a: pool[i]!, b: pool[j]!, name: `Món ${i}-${j}`, depth: 1 + ((i + j) % 8) })
      }
    }
    expect(specs).toHaveLength(363)
    const ctx = await ctxOf(specs)
    expect(Object.keys(ctx.graph.entries)).toHaveLength(363)

    let s = 20261020 >>> 0 // mulberry32, seed cố định
    const rnd = (): number => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    for (let w = 0; w < 5; w++) await lookupRecipe(ctx, pool[0]!, pool[1]!) // khởi động JIT
    const times: number[] = []
    let hits = 0
    for (let n = 0; n < 1000; n++) {
      const a = pool[Math.floor(rnd() * pool.length)]!
      const b = rnd() < 0.1 ? `Không Tồn Tại ${n}` : pool[Math.floor(rnd() * pool.length)]!
      const t0 = performance.now()
      const r = await lookupRecipe(ctx, a, b)
      times.push(performance.now() - t0)
      if (r) hits++
    }
    expect(hits).toBeGreaterThan(300)
    times.sort((x, y) => x - y)
    const p95 = times[Math.floor(times.length * 0.95)]!
    expect(p95).toBeLessThan(50)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.stubGlobal('crypto', webcrypto)
  }, 60_000)

  // ------------------------------------------------------------ AC-GAME-15
  it('AC-GAME-15: phần tử bị chặn bị ẩn khỏi Đĩa và bàn nhưng vẫn nằm trong lưu trữ; bỏ chặn thì hiện lại', () => {
    const e = item('Món Cấm', '🚫', 2, 5, '2026-10-10T00:00:00.000Z')
    const p = base()
    p.items.push(e)
    p.table = [
      { uid: 't1', id: e.id, name: e.name, emoji: e.emoji, x: 1, y: 2 },
      { uid: 't2', id: eid('Cay'), name: 'Cay', emoji: '🌶️', x: 3, y: 4 },
    ]
    saveProgress(localStorage, p)
    const blocked: Blocklist = { elements: [e.id], recipes: [], images: [] }

    const snapshot = JSON.stringify(p)
    expect(names(visibleItems(p, blocked))).toEqual(['Cay', 'Cười', 'Toang', 'Deadline'])
    expect(names(visibleTable(p, blocked))).toEqual(['Cay'])
    expect(JSON.stringify(p)).toBe(snapshot)
    expect(loadProgress(localStorage)!.items.map((i) => i.id)).toContain(e.id)

    expect(names(visibleItems(p, NO_BLOCK))).toContain('Món Cấm')
    expect(names(visibleTable(p, NO_BLOCK))).toEqual(['Món Cấm', 'Cay'])
  })

  it('AC-GAME-15: ghép ra phần tử bị chặn (theo phần tử hoặc theo công thức) được xử lý như ghép trượt', async () => {
    const specs: Spec[] = [
      { a: 'Cay', b: 'Cười', name: 'Món Cấm' },
      { a: 'Toang', b: 'Deadline', name: 'Món Cấm' }, // mọi công thức ra E đều trượt
      { a: 'Cay', b: 'Toang', name: 'Món Lành' },
    ]
    const byElement = await ctxOf(specs, { blocklist: { elements: [eid('Món Cấm')], recipes: [], images: [] } })
    for (const [a, b] of [
      ['Cay', 'Cười'],
      ['Cười', 'Cay'],
      ['Toang', 'Deadline'],
    ] as const) {
      expect(await lookupRecipe(byElement, a, b)).toBeNull()
      const out = await combine(byElement, base(), a, b)
      expect(out.kind).toBe('miss')
      if (out.kind !== 'miss') return
      expect(MISS_LINES).toContain(out.line)
      expect(out.progress.items).toHaveLength(4)
      expect(out.progress.items.some((i) => i.name === 'Món Cấm')).toBe(false)
    }
    const fine = await combine(byElement, base(), 'Cay', 'Toang')
    expect(fine.kind).toBe('hit')

    const byRecipe = await ctxOf(specs, {
      blocklist: { elements: [], recipes: [await lookupKey('Cay', 'Cười')], images: [] },
    })
    expect((await combine(byRecipe, base(), 'Cười', 'Cay')).kind).toBe('miss')
    expect((await combine(byRecipe, base(), 'Toang', 'Deadline')).kind).toBe('hit')
  })

  // ------------------------------------------------------------ AC-GAME-16 (phần logic: tiến độ không bị xóa khi lỗi)
  it('AC-GAME-16: loadProgress không đổi dữ liệu cục bộ (chỉ đọc), nên lỗi mạng không thể xóa tiến độ', () => {
    const p = base()
    p.items.push(item('Món Riêng', '🍲', 1, 7, '2026-10-20T04:00:00.000Z'))
    saveProgress(localStorage, p)
    const raw = localStorage.getItem(PROGRESS_KEY)
    loadProgress(localStorage)
    visibleItems(p, NO_BLOCK)
    expect(localStorage.getItem(PROGRESS_KEY)).toBe(raw)
  })

  // ------------------------------------------------------------ AC-GAME-17
  it('AC-GAME-17: đổi version graph giữ mọi phần tử đã khám phá và tra cứu theo graph mới', async () => {
    const v1 = initialProgress(manifestOf(1), T0)
    v1.items.push(item('Món Cũ', '📜', 1, 1, '2026-09-01T00:00:00.000Z'))
    v1.items.push(item('Món Hai', '2️⃣', 2, 1, '2026-09-02T00:00:00.000Z'))
    expect(v1.graph_version).toBe(1)

    const m2 = manifestOf(2)
    const migrated = migrateProgress(v1, m2)
    expect(migrated.graph_version).toBe(2)
    expect(migrated.items).toEqual(v1.items)
    expect(migrated.table).toEqual(v1.table)
    expect(migrated.sort).toBe(v1.sort)

    // graph V2 không còn công thức Cay + Cười = Món Cũ, mà là = Món Mới
    const ctx2: Ctx = {
      graph: await buildGraph(2, [{ a: 'Cay', b: 'Cười', name: 'Món Mới', added_version: 2 }]),
      manifest: m2,
      blocklist: NO_BLOCK,
      now: NOW,
    }
    const out = await combine(ctx2, migrated, 'Cay', 'Cười')
    expect(out.kind).toBe('hit')
    if (out.kind !== 'hit') return
    expect(out.result.name).toBe('Món Mới')
    expect(names(out.progress.items)).toEqual(expect.arrayContaining(['Món Cũ', 'Món Hai', 'Món Mới']))

    // graph V1 cũ không dùng được với khóa của V2 (salt khác) -> lookup trượt
    const stale: Ctx = {
      ...ctx2,
      graph: await buildGraph(1, [{ a: 'Cay', b: 'Cười', name: 'Món Cũ', added_version: 1 }]),
    }
    expect(await lookupRecipe({ ...stale, graph: { ...stale.graph, version: 2 } }, 'Cay', 'Cười')).toBeNull()
  })

  it('AC-GAME-17: phần tử bị chặn vẫn bị ẩn sau khi đổi version (AC-GAME-15)', () => {
    const v1 = initialProgress(manifestOf(1), T0)
    const e = item('Món Cấm', '🚫', 1, 1, '2026-09-01T00:00:00.000Z')
    v1.items.push(e)
    const migrated = migrateProgress(v1, manifestOf(2))
    expect(migrated.items.map((i) => i.id)).toContain(e.id)
    expect(names(visibleItems(migrated, { elements: [e.id], recipes: [], images: [] }))).not.toContain('Món Cấm')
  })
})
