// @vitest-environment jsdom
/// <reference types="node" />
/// <reference types="vite/client" />
/**
 * Acceptance tests cho docs/acceptance/subpath.md, phần chạy trong DOM:
 * AC-SUBPATH-07 (URL do api.ts và game gọi), 08 (khóa localStorage), 09 (chuyển khóa cũ), 10 (link chia sẻ).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU
 *   web/src/base.ts:    withBase(path), SITE_URL, shareUrl(ref)      (import.meta.env.BASE_URL = '/lau-meme/')
 *   web/src/storage.ts: PREFIX = 'laumeme:', migrateLegacyKeys(storage)
 *   web/src/api.ts:     getHealth(), getManifest(), getBlocklist(), getGraph(url)
 */
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBlocklist, getGraph, getHealth, getManifest } from './api'
import { SITE_URL, shareUrl, withBase } from './base'
import { loadSolved, saveSolved } from './daily/solved'
import { fold } from './graph/crypto'
import type { Graph, GraphResult } from './graph/crypto'
import { Game } from './game/Game'
import { initialProgress, saveProgress } from './game/engine'
import type { Item, Manifest } from './game/engine'
import { PREFIX, migrateLegacyKeys } from './storage'

// ---------------------------------------------------------------- fixtures (ADR 0002, như Game.test.tsx)
const enc = new TextEncoder()
const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url')
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))

async function buildGraph(version: number, a: string, b: string, name: string): Promise<Graph> {
  const plain: GraphResult = { added_version: version, depth: 1, emoji: '🔥', id: eid(name), image_key: null, name }
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
  return { format: 1, version, entries: { [key]: b64u(new Uint8Array(ct)) } }
}

const T0 = new Date('2026-10-20T03:00:00.000Z')
const VERSION = 7
const STARTERS = [
  { id: eid('Cay'), name: 'Cay', emoji: '🌶️' },
  { id: eid('Cười'), name: 'Cười', emoji: '😂' },
  { id: eid('Toang'), name: 'Toang', emoji: '💀' },
  { id: eid('Deadline'), name: 'Deadline', emoji: '⏰' },
]
const manifest = (): Manifest =>
  ({
    version: VERSION,
    batch_at: '2026-10-20T00:00:00.000Z',
    graph_url: `/api/graph/${VERSION}`,
    starters: STARTERS,
    miss_lines: Array.from({ length: 30 }, (_, i) => `Nồi trào kiểu ${i}, khét rồi!`),
    daily: { element_id: eid('Tới Công Chuyện'), emoji: '🍜', hint: 'gợi ý', depth: 1 },
    policy_version: 1,
  }) as Manifest

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

let fetchMock: ReturnType<typeof vi.fn>

async function installNet(): Promise<void> {
  const graph = await buildGraph(VERSION, 'Cay', 'Cười', 'Tới Công Chuyện')
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes('/manifest')) return json(manifest())
    if (url.includes('/graph/')) return json(graph)
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const fetchedUrls = (): string[] => fetchMock.mock.calls.map((c) => urlOf(c[0] as RequestInfo | URL))

// ---------------------------------------------------------------- kéo thả (như Game.test.tsx)
let dropTarget: Element | null = null
function drag(src: Element, dest: Element): void {
  dropTarget = dest
  const base = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
  fireEvent.pointerDown(src, { ...base, buttons: 1, clientX: 5, clientY: 5 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: 50, clientY: 50 })
  fireEvent.pointerMove(src, { ...base, buttons: 1, clientX: 100, clientY: 100 })
  fireEvent.pointerUp(src, { ...base, buttons: 0, clientX: 100, clientY: 100 })
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
const plateEl = (): HTMLElement => screen.getByRole('list', { name: 'Đĩa nhúng' })
const plateItem = (name: string): HTMLElement => {
  const el = [...plateEl().querySelectorAll<HTMLElement>('[data-testid="plate-item"]')].find((e) => e.dataset.name === name)
  if (!el) throw new Error(`Không có "${name}" trong Đĩa`)
  return el
}
const plateNames = (): string[] =>
  [...plateEl().querySelectorAll<HTMLElement>('[data-testid="plate-item"]')].map((e) => e.dataset.name ?? '')
const tableNames = (): string[] => screen.queryAllByTestId('table-item').map((e) => e.dataset.name ?? '')
const pot = (): HTMLElement => screen.getByTestId('pot')

async function mountReady(): Promise<void> {
  render(<Game />)
  await screen.findByRole('list', { name: 'Đĩa nhúng' })
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}

async function playSomeCombine(): Promise<void> {
  const close = screen.queryByRole('button', { name: 'Đóng' })
  if (close) fireEvent.click(close)
  drag(plateItem('Cay'), screen.getByTestId('pot-slot-1'))
  drag(plateItem('Cười'), screen.getByTestId('pot-slot-2'))
  await advance(1300)
  await waitFor(() => expect(pot().dataset.state).toBe('idle'))
}

function storageKeys(s: Storage = localStorage): string[] {
  return Array.from({ length: s.length }, (_, i) => s.key(i)!)
}
function dump(s: Storage = localStorage): Record<string, string> {
  return Object.fromEntries(storageKeys(s).map((k) => [k, s.getItem(k)!]))
}

/** Một Storage mà mọi thao tác đều ném lỗi (trình duyệt chặn lưu trữ). */
function blockedStorage(): Storage {
  const boom = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  return {
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    clear: boom,
    key: boom,
    get length(): number {
      return boom()
    },
  } as unknown as Storage
}

function installThrowingLocalStorage(): Storage {
  const s = blockedStorage()
  vi.stubGlobal('localStorage', s)
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => s })
  return s
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(T0)
  localStorage.clear()
  dropTarget = null
  ;(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => dropTarget
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => (dropTarget ? [dropTarget] : [])
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ AC-SUBPATH-07 (URL)
describe('subpath: URL gọi ra ngoài', () => {
  it('AC-SUBPATH-07: withBase ghép /lau-meme/ với đường dẫn có hoặc không có dấu / đầu', () => {
    expect(import.meta.env.BASE_URL).toBe('/lau-meme/')
    expect(withBase('/api/graph/12')).toBe('/lau-meme/api/graph/12')
    expect(withBase('api/health')).toBe('/lau-meme/api/health')
    expect(withBase('/img/0123456789ab.webp')).toBe('/lau-meme/img/0123456789ab.webp')
  })

  it('AC-SUBPATH-07: getHealth/getManifest/getBlocklist fetch /lau-meme/api/health|manifest|blocklist', async () => {
    const f = vi.fn(async () => json({ status: 'ok', env: 'test', schema: '1' }))
    vi.stubGlobal('fetch', f)
    for (const call of [getHealth, getManifest, getBlocklist]) await Promise.resolve(call()).catch(() => undefined)
    const urls = f.mock.calls.map((c) => urlOf((c as unknown[])[0] as RequestInfo | URL))
    expect(urls).toEqual(['/lau-meme/api/health', '/lau-meme/api/manifest', '/lau-meme/api/blocklist'])
  })

  it('AC-SUBPATH-07: getGraph với graph_url "/api/graph/12" fetch /lau-meme/api/graph/12', async () => {
    const f = vi.fn(async () => json({ format: 1, version: 12, entries: {} }))
    vi.stubGlobal('fetch', f)
    await Promise.resolve(getGraph('/api/graph/12')).catch(() => undefined)
    expect(f.mock.calls.map((c) => urlOf((c as unknown[])[0] as RequestInfo | URL))).toEqual(['/lau-meme/api/graph/12'])
  })

  it('AC-SUBPATH-07: game chạy thật chỉ gọi các URL bắt đầu bằng /lau-meme/', async () => {
    await installNet()
    await mountReady()
    const urls = fetchedUrls()
    expect(urls.length).toBeGreaterThanOrEqual(3)
    for (const u of urls) expect(u.startsWith('/lau-meme/'), u).toBe(true)
    expect(urls).toContain(`/lau-meme/api/graph/${VERSION}`)
  })
})

// ================================================================ AC-SUBPATH-08
describe('subpath: khóa localStorage', () => {
  it('AC-SUBPATH-08: PREFIX là "laumeme:"', () => {
    expect(PREFIX).toBe('laumeme:')
  })

  it('AC-SUBPATH-08: ghép món và đổi giao diện sáng/tối chỉ ghi các khóa bắt đầu bằng laumeme:', async () => {
    await installNet()
    await mountReady()
    await playSomeCombine()
    expect(tableNames()).toContain('Tới Công Chuyện')
    fireEvent.click(screen.getByRole('button', { name: /chuyển chế độ/i }))
    const keys = storageKeys()
    expect(keys).toContain('laumeme:game.progress')
    expect(keys).toContain('laumeme:theme')
    for (const k of keys) expect(k.startsWith('laumeme:'), k).toBe(true)
  })

  it('AC-SUBPATH-08: lưu trạng thái đã giải Daily chỉ ghi khóa bắt đầu bằng laumeme:', () => {
    saveSolved(localStorage, VERSION, { a: 'Hết Cứu', b: 'Cay', name: 'Stonks' })
    const keys = storageKeys()
    expect(keys).toContain('laumeme:daily-solved')
    for (const k of keys) expect(k.startsWith('laumeme:'), k).toBe(true)
  })

  it('AC-SUBPATH-08: localStorage ném lỗi ở mọi thao tác thì game vẫn chạy và không ném lỗi ra ngoài', async () => {
    await installNet()
    installThrowingLocalStorage()
    await mountReady()
    await playSomeCombine()
    expect(tableNames()).toContain('Tới Công Chuyện')
    expect(plateNames()).toContain('Tới Công Chuyện')
    expect(() => fireEvent.click(screen.getByRole('button', { name: /chuyển chế độ/i }))).not.toThrow()
    expect(['dark', 'light']).toContain(document.documentElement.dataset.theme)
  })

  it('AC-SUBPATH-08: Daily và migrateLegacyKeys không ném lỗi khi Storage bị chặn', async () => {
    const blocked = blockedStorage()
    expect(() => migrateLegacyKeys(blocked)).not.toThrow()
    expect(() => saveSolved(blocked, VERSION, { a: 'Hết Cứu', b: 'Cay', name: 'Stonks' })).not.toThrow()
    expect(() => loadSolved(blocked, VERSION)).not.toThrow()
    expect(loadSolved(blocked, VERSION)).toBeNull()
  })
})

// ================================================================ AC-SUBPATH-09
describe('subpath: chuyển khóa cũ', () => {
  /** Giá trị tiến độ thật: ghi bằng saveProgress vào Storage tạm rồi lấy giá trị duy nhất ra. */
  function realProgressValue(extra: Item[]): string {
    const mem = new Map<string, string>()
    const tmp = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size
      },
    } as Storage
    const p = initialProgress(manifest(), T0)
    p.tutorial_seen = true
    p.items.push(...extra)
    saveProgress(tmp, p)
    return [...mem.values()][0]!
  }
  const oldItem: Item = {
    id: eid('Món Cũ'),
    name: 'Món Cũ',
    emoji: '📜',
    depth: 2,
    added_version: 6,
    image_key: null,
    discovered_at: '2026-10-19T00:00:00.000Z',
  }
  const DAILY_VALUE = '{"version":7,"steps":2}'

  it('AC-SUBPATH-09: khi game khởi động, khóa cũ được chuyển sang khóa mới, xóa khóa cũ, Đĩa hiện đủ tiến độ cũ', async () => {
    const progress = realProgressValue([oldItem])
    localStorage.setItem('lm.game.progress', progress)
    localStorage.setItem('lm.theme', 'light')
    localStorage.setItem('lau-meme:daily-challenge', DAILY_VALUE)
    localStorage.setItem('lm.player_id', '3f0a7f0e-2f52-4c7a-9f5f-0c2b1a1d9e11')
    localStorage.setItem('other-game:score', '42')
    await installNet()
    await mountReady()

    expect(localStorage.getItem('lm.game.progress')).toBeNull()
    expect(localStorage.getItem('lm.theme')).toBeNull()
    expect(localStorage.getItem('lau-meme:daily-challenge')).toBeNull()
    expect(localStorage.getItem('laumeme:theme')).toBe('light')
    expect(localStorage.getItem('laumeme:daily-challenge')).toBe(DAILY_VALUE)
    const moved = JSON.parse(localStorage.getItem('laumeme:game.progress')!) as { items: { name: string }[] }
    expect(moved.items.map((i) => i.name)).toContain('Món Cũ')
    expect(plateNames()).toEqual(expect.arrayContaining(['Món Cũ', 'Cay', 'Cười', 'Toang', 'Deadline']))
    expect(document.documentElement.dataset.theme).toBe('light')
    // khóa của game khác / khóa ngoài danh sách không bị đụng
    expect(localStorage.getItem('other-game:score')).toBe('42')
    expect(localStorage.getItem('lm.player_id')).toBe('3f0a7f0e-2f52-4c7a-9f5f-0c2b1a1d9e11')
  })

  it('AC-SUBPATH-09: nếu khóa mới đã có thì giữ khóa mới và chỉ xóa khóa cũ', () => {
    localStorage.setItem('laumeme:theme', 'dark')
    localStorage.setItem('lm.theme', 'light')
    localStorage.setItem('laumeme:game.progress', '{"new":true}')
    localStorage.setItem('lm.game.progress', '{"old":true}')
    migrateLegacyKeys(localStorage)
    expect(localStorage.getItem('laumeme:theme')).toBe('dark')
    expect(localStorage.getItem('laumeme:game.progress')).toBe('{"new":true}')
    expect(localStorage.getItem('lm.theme')).toBeNull()
    expect(localStorage.getItem('lm.game.progress')).toBeNull()
  })

  it('AC-SUBPATH-09: chạy lại lần hai không đổi gì và không đụng khóa của game khác', () => {
    localStorage.setItem('lm.game.progress', '{"items":[]}')
    localStorage.setItem('lm.theme', 'dark')
    localStorage.setItem('lau-meme:daily-challenge', DAILY_VALUE)
    localStorage.setItem('lm.nickname', 'Thực khách')
    localStorage.setItem('lm.streak', '{"current":3}')
    localStorage.setItem('other-game:score', '42')
    migrateLegacyKeys(localStorage)
    const first = dump()
    expect(first).toEqual({
      'laumeme:game.progress': '{"items":[]}',
      'laumeme:theme': 'dark',
      'laumeme:daily-challenge': DAILY_VALUE,
      'lm.nickname': 'Thực khách',
      'lm.streak': '{"current":3}',
      'other-game:score': '42',
    })
    migrateLegacyKeys(localStorage)
    expect(dump()).toEqual(first)
  })
})

// ================================================================ AC-SUBPATH-10
describe('subpath: link chia sẻ', () => {
  it('AC-SUBPATH-10: SITE_URL mặc định là https://dinoduct.fun/lau-meme/', () => {
    expect(SITE_URL).toBe('https://dinoduct.fun/lau-meme/')
  })

  it('AC-SUBPATH-10: shareUrl("daily") và shareUrl("disc") ra link tuyệt đối có ?ref=', () => {
    expect(shareUrl('daily')).toBe('https://dinoduct.fun/lau-meme/?ref=daily')
    expect(shareUrl('disc')).toBe('https://dinoduct.fun/lau-meme/?ref=disc')
  })
})
