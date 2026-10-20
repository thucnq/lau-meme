// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/priv.md, phần web: AC-PRIV-01, 02, 03 (client), 04, 05, 08, 09.
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (web/src/privacy/)
 *   player.ts:  getPlayerId(storage), resetPlayerId(storage)        khóa 'laumeme:player-id'
 *   consent.ts: readConsent(storage), saveConsent(storage, version, choice), canSend(storage, policyVersion)   khóa 'laumeme:consent'
 *   client.ts:  ConsentRequiredError, playerFetch(path, init, {storage, policyVersion}), grantConsent(opts, purpose),
 *               withdrawConsent(opts), getMyData(storage), deleteMyData(storage)
 *   ConsentBanner, ConsentPrompt, MyDataPanel, PolicyPage;  web/src/Root.tsx: <Root />
 */
import { createHash, webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold } from '../graph/crypto'
import type { Manifest } from '../game/engine'
import { Root } from '../Root'
import { ConsentBanner } from './ConsentBanner'
import { ConsentPrompt } from './ConsentPrompt'
import { MyDataPanel } from './MyDataPanel'
import { PolicyPage } from './PolicyPage'
import { canSend, readConsent, saveConsent } from './consent'
import { ConsentRequiredError, deleteMyData, getMyData, grantConsent, playerFetch, withdrawConsent } from './client'
import { getPlayerId, resetPlayerId } from './player'

// ---------------------------------------------------------------- fixtures
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')
const eid = (name: string): string => sha('lm1|e|' + fold(name))
const VERSION = 7
const STARTERS = ['Cay', 'Cười', 'Toang', 'Deadline'].map((name) => ({ id: eid(name), name, emoji: '🌶️' }))
const manifest = (policy: number): Manifest =>
  ({
    version: VERSION,
    batch_at: '2026-10-20T00:00:00.000Z',
    graph_url: `/api/graph/${VERSION}`,
    starters: STARTERS,
    miss_lines: Array.from({ length: 30 }, (_, i) => `Nồi trào kiểu ${i}, khét rồi!`),
    daily: { element_id: eid('Tới Công Chuyện'), emoji: '🍜', hint: 'gợi ý', depth: 1 },
    policy_version: policy,
  }) as Manifest

const MY_DATA = {
  nickname: 'Bếp Trưởng',
  discoveries: [{ element_id: 'el-1', discovered_at: '2026-10-19T01:00:00.000Z' }],
  daily_results: [],
  streak: { current: 3, longest: 5 },
  reports: [],
  votes: [],
  consents: [{ purpose: 'play', action: 'grant', policy_version: 1, created_at: '2026-10-19T00:00:00.000Z' }],
  event_counts: { session_start: 2 },
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

let fetchMock: ReturnType<typeof vi.fn>
let policy = 1

function installNet(): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.includes('/manifest')) return json(manifest(policy))
    if (url.includes('/graph/')) return json({ format: 1, version: VERSION, entries: {} })
    if (url.includes('/blocklist')) return json({ elements: [], recipes: [], images: [] })
    if (url.includes('/health')) return json({ status: 'ok', env: 'test', schema: '1' })
    if (url.endsWith('/api/consents') && method === 'POST') {
      const b = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return json({ ...b, created_at: '2026-10-20T00:00:00.000Z' }, 201)
    }
    if (url.endsWith('/api/me') && method === 'GET') return json(MY_DATA)
    if (url.endsWith('/api/me') && method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const calls = () => fetchMock.mock.calls.map((c) => ({ url: urlOf(c[0] as RequestInfo), method: methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined), player: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id'), init: c[1] as RequestInit | undefined }))
const withPlayerHeader = () => calls().filter((c) => c.player !== null)

const opts = (version = 1) => ({ storage: localStorage as Storage | null, policyVersion: version })
const bannerEl = (): HTMLElement | null => screen.queryByRole('dialog') ?? screen.queryByRole('region', { name: /đồng ý|dữ liệu|quyền riêng tư/i }) ?? screen.queryByRole('region')

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  localStorage.clear()
  policy = 1
  window.history.pushState({}, '', '/lau-meme/')
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  })
  installNet()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ AC-PRIV-01
describe('priv: trang chính sách', () => {
  it('AC-PRIV-01: PolicyPage nêu dữ liệu thu, thời hạn lưu, không gửi bên thứ ba/AI, không cookie theo dõi', () => {
    render(<PolicyPage />)
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/UUID/)
    expect(text).toMatch(/nickname/i)
    expect(text).toMatch(/IP/)
    expect(text).toMatch(/băm/i)
    expect(text).toMatch(/sự kiện/i)
    expect(text).toMatch(/mục đích/i)
    expect(text).toContain('7 ngày')
    expect(text).toContain('90 ngày')
    expect(text).toMatch(/đến khi bạn xóa/i)
    expect(text).toMatch(/\bAI\b/)
    expect(text).toMatch(/bên thứ ba/i)
    expect(text).toMatch(/cookie/i)
  })

  it('AC-PRIV-01: PolicyPage nêu quyền xem/xuất/xóa/rút đồng ý, mục Liên hệ, phiên bản và ngày hiệu lực', () => {
    render(<PolicyPage />)
    const text = document.body.textContent ?? ''
    for (const right of [/xem/i, /xuất|tải về/i, /xóa/i, /rút (lại )?đồng ý/i]) expect(text).toMatch(right)
    expect(text).toMatch(/Dữ liệu của tôi/)
    expect(screen.getByRole('heading', { name: /liên hệ/i })).toBeTruthy()
    expect(text).toMatch(/Phiên bản/)
    expect(text).toMatch(/hiệu lực/i)
  })

  it('AC-PRIV-01: mở /lau-meme/chinh-sach chỉ hiện trang chính sách (không game, không hộp đồng ý)', async () => {
    window.history.pushState({}, '', '/lau-meme/chinh-sach')
    render(<Root />)
    expect(await screen.findByRole('heading', { name: /liên hệ/i })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Đĩa nhúng' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Đồng ý' })).toBeNull()
    expect(withPlayerHeader()).toEqual([])
  })

  it('AC-PRIV-01: chân trang chủ có link "Chính sách quyền riêng tư" tới /lau-meme/chinh-sach', async () => {
    render(<Root />)
    const link = await screen.findByRole('link', { name: /Chính sách quyền riêng tư/i })
    expect(link.getAttribute('href')).toBe('/lau-meme/chinh-sach')
  })
})

// ================================================================ AC-PRIV-02
describe('priv: đồng ý trước khi gửi', () => {
  it('AC-PRIV-02: chưa có bản ghi đồng ý thì hiện hộp với link chính sách, hai nút, không lựa chọn nào chọn sẵn', async () => {
    render(<Root />)
    expect(await screen.findByRole('button', { name: 'Đồng ý' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Chỉ chơi, không gửi gì' })).toBeTruthy()
    const box = bannerEl()
    expect(box).not.toBeNull()
    const link = within(box!).getByRole('link', { name: /chính sách/i })
    expect(link.getAttribute('href')).toMatch(/chinh-sach$/)
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type=radio], input[type=checkbox]')) {
      expect(input.checked).toBe(false)
    }
    expect(readConsent(localStorage)).toBeNull()
  })

  it('AC-PRIV-02: trước khi bấm "Đồng ý" không có yêu cầu nào mang X-Player-Id', async () => {
    render(<Root />)
    await screen.findByRole('button', { name: 'Đồng ý' })
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    expect(calls().length).toBeGreaterThan(0) // manifest/graph/blocklist do load
    expect(withPlayerHeader()).toEqual([])
    expect(calls().some((c) => c.url.includes('/consents'))).toBe(false)
  })

  it('AC-PRIV-02: bấm "Đồng ý" gửi POST /lau-meme/api/consents (play, grant, version) kèm X-Player-Id rồi lưu granted', async () => {
    render(<Root />)
    fireEvent.click(await screen.findByRole('button', { name: 'Đồng ý' }))
    await waitFor(() => expect(readConsent(localStorage)).toEqual({ version: 1, choice: 'granted' }))
    const post = calls().find((c) => c.url === '/lau-meme/api/consents')
    expect(post).toBeDefined()
    expect(post!.method).toBe('POST')
    expect(post!.player).toBe(getPlayerId(localStorage))
    expect(JSON.parse(String(post!.init?.body))).toEqual({ purpose: 'play', action: 'grant', policy_version: 1 })
    await waitFor(() => expect(bannerEl()).toBeNull())
  })

  it('AC-PRIV-02: bấm "Chỉ chơi, không gửi gì" lưu declined, không gửi gì, vẫn chơi được và nút gửi hiện lời mời đồng ý', async () => {
    render(<Root />)
    fireEvent.click(await screen.findByRole('button', { name: 'Chỉ chơi, không gửi gì' }))
    await waitFor(() => expect(readConsent(localStorage)).toEqual({ version: 1, choice: 'declined' }))
    expect(withPlayerHeader()).toEqual([])
    expect(calls().some((c) => c.url.includes('/consents'))).toBe(false)
    expect(await screen.findByRole('list', { name: 'Đĩa nhúng' })).toBeTruthy()
    expect(canSend(localStorage, 1)).toBe(false)
  })

  it('AC-PRIV-02: playerFetch ném ConsentRequiredError mà KHÔNG gọi fetch khi chưa đồng ý hoặc đã từ chối', async () => {
    await expect(playerFetch('/api/me/streak', {}, opts())).rejects.toBeInstanceOf(ConsentRequiredError)
    saveConsent(localStorage, 1, 'declined')
    await expect(playerFetch('/api/me/streak', {}, opts())).rejects.toBeInstanceOf(ConsentRequiredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('AC-PRIV-02: playerFetch sau khi đồng ý gọi /lau-meme/api/... kèm X-Player-Id là UUID v4 đã lưu', async () => {
    saveConsent(localStorage, 1, 'granted')
    await playerFetch('/api/me/streak', {}, opts())
    const [c] = withPlayerHeader()
    expect(c!.url).toBe('/lau-meme/api/me/streak')
    expect(c!.player).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(localStorage.getItem('laumeme:player-id')).toBe(c!.player)
  })

  it('AC-PRIV-02: ConsentPrompt hiện lời mời "Cần đồng ý chính sách dữ liệu để gửi"', () => {
    render(<ConsentPrompt />)
    expect(screen.getByText(/Cần đồng ý chính sách dữ liệu để gửi/)).toBeTruthy()
  })

  it('AC-PRIV-02: getPlayerId sinh UUID một lần, giữ ổn định; storage null thì giữ trong bộ nhớ; reset sinh UUID mới', () => {
    const a = getPlayerId(localStorage)
    expect(getPlayerId(localStorage)).toBe(a)
    expect(localStorage.getItem('laumeme:player-id')).toBe(a)
    const mem = getPlayerId(null)
    expect(mem).toMatch(/^[0-9a-f-]{36}$/i)
    expect(getPlayerId(null)).toBe(mem)
    const b = resetPlayerId(localStorage)
    expect(b).not.toBe(a)
    expect(getPlayerId(localStorage)).toBe(b)
  })
})

// ================================================================ AC-PRIV-03 (client)
describe('priv: bằng chứng đồng ý (client)', () => {
  it('AC-PRIV-03: grantConsent(nickname) gửi POST consents purpose nickname, action grant, đúng version', async () => {
    saveConsent(localStorage, 1, 'granted')
    await grantConsent(opts(), 'nickname')
    const post = calls().find((c) => c.url === '/lau-meme/api/consents')
    expect(post!.method).toBe('POST')
    expect(JSON.parse(String(post!.init?.body))).toEqual({ purpose: 'nickname', action: 'grant', policy_version: 1 })
    expect(post!.player).toBe(getPlayerId(localStorage))
  })
})

// ================================================================ AC-PRIV-04
describe('priv: rút lại đồng ý', () => {
  it('AC-PRIV-04: withdrawConsent gửi bản ghi withdraw (play) rồi lưu declined và ngừng gửi mọi yêu cầu kèm UUID', async () => {
    saveConsent(localStorage, 1, 'granted')
    await withdrawConsent(opts())
    const post = calls().find((c) => c.url === '/lau-meme/api/consents')
    expect(JSON.parse(String(post!.init?.body))).toEqual({ purpose: 'play', action: 'withdraw', policy_version: 1 })
    expect(readConsent(localStorage)?.choice).toBe('declined')
    expect(canSend(localStorage, 1)).toBe(false)
    fetchMock.mockClear()
    await expect(playerFetch('/api/me/streak', {}, opts())).rejects.toBeInstanceOf(ConsentRequiredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('AC-PRIV-04: nút "Rút lại đồng ý" trong "Dữ liệu của tôi" gửi withdraw rồi hỏi "Xóa dữ liệu luôn?" với hai nút', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rút lại đồng ý' }))
    expect(await screen.findByText(/Xóa dữ liệu luôn\?/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Xóa dữ liệu' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Giữ lại' })).toBeTruthy()
    const post = calls().find((c) => c.url === '/lau-meme/api/consents')
    expect(JSON.parse(String(post!.init?.body))).toMatchObject({ purpose: 'play', action: 'withdraw' })
    expect(canSend(localStorage, 1)).toBe(false)
    expect(calls().some((c) => c.method === 'DELETE')).toBe(false) // "Giữ lại" is still possible
  })

  it('AC-PRIV-04: nút "Rút lại đồng ý" chỉ hiện khi đang đồng ý', async () => {
    saveConsent(localStorage, 1, 'declined')
    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    await screen.findByRole('heading', { name: 'Dữ liệu của tôi' })
    expect(screen.queryByRole('button', { name: 'Rút lại đồng ý' })).toBeNull()
  })
})

// ================================================================ AC-PRIV-05
describe('priv: xóa dữ liệu của mình', () => {
  it('AC-PRIV-05: "Xóa dữ liệu của tôi" cần bước xác nhận "Xóa vĩnh viễn" rồi mới DELETE /lau-meme/api/me và sinh UUID mới', async () => {
    saveConsent(localStorage, 1, 'granted')
    const old = getPlayerId(localStorage)
    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Xóa dữ liệu của tôi' }))
    expect(calls().some((c) => c.method === 'DELETE')).toBe(false) // not yet: needs confirmation
    fireEvent.click(await screen.findByRole('button', { name: 'Xóa vĩnh viễn' }))
    await waitFor(() => expect(calls().some((c) => c.method === 'DELETE')).toBe(true))
    const del = calls().find((c) => c.method === 'DELETE')!
    expect(del.url).toBe('/lau-meme/api/me')
    expect(del.player).toBe(old)
    await waitFor(() => expect(getPlayerId(localStorage)).not.toBe(old))
  })

  it('AC-PRIV-05: deleteMyData không cần đồng ý, gửi DELETE kèm UUID cũ rồi đổi UUID cục bộ', async () => {
    const old = getPlayerId(localStorage) // no consent saved at all
    await deleteMyData(localStorage)
    const del = calls().find((c) => c.method === 'DELETE')!
    expect(del.url).toBe('/lau-meme/api/me')
    expect(del.player).toBe(old)
    expect(getPlayerId(localStorage)).not.toBe(old)
  })

  it('AC-PRIV-05: bấm "Giữ lại" sau khi rút đồng ý không gửi DELETE', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rút lại đồng ý' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Giữ lại' }))
    expect(calls().some((c) => c.method === 'DELETE')).toBe(false)
  })
})

// ================================================================ AC-PRIV-08
describe('priv: xem và xuất dữ liệu', () => {
  it('AC-PRIV-08: getMyData không cần đồng ý, GET /lau-meme/api/me kèm X-Player-Id và trả dữ liệu', async () => {
    const data = await getMyData(localStorage)
    const c = calls().find((x) => x.url === '/lau-meme/api/me')!
    expect(c.method).toBe('GET')
    expect(c.player).toBe(getPlayerId(localStorage))
    expect(data).toMatchObject({ nickname: 'Bếp Trưởng', streak: { current: 3, longest: 5 } })
  })

  it('AC-PRIV-08: MyDataPanel có tiêu đề "Dữ liệu của tôi" và hiện dữ liệu tải từ /me', async () => {
    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    expect(await screen.findByRole('heading', { name: 'Dữ liệu của tôi' })).toBeTruthy()
    expect(await screen.findByText(/Bếp Trưởng/)).toBeTruthy()
  })

  it('AC-PRIV-08: nút "Tải về" tạo file JSON lau-meme-du-lieu.json chứa đúng dữ liệu', async () => {
    let blob: Blob | null = null
    const createObjectURL = vi.fn((b: Blob) => {
      blob = b
      return 'blob:lau-meme-test'
    })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
    const clicked: { download: string; href: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href })
    })

    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    await screen.findByText(/Bếp Trưởng/)
    fireEvent.click(screen.getByRole('button', { name: 'Tải về' }))

    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(clicked[0]!.download).toBe('lau-meme-du-lieu.json')
    expect(clicked[0]!.href).toContain('blob:lau-meme-test')
    expect(blob).not.toBeNull()
    const text = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(r.error)
      r.readAsText(blob!)
    })
    expect(JSON.parse(text)).toEqual(MY_DATA)
  })

  it('AC-PRIV-08: chân trang có nút "Dữ liệu của tôi" mở bảng dữ liệu', async () => {
    render(<Root />)
    fireEvent.click(await screen.findByRole('button', { name: 'Dữ liệu của tôi' }))
    expect(await screen.findByRole('heading', { name: 'Dữ liệu của tôi' })).toBeTruthy()
    await waitFor(() => expect(calls().some((c) => c.url === '/lau-meme/api/me' && c.method === 'GET')).toBe(true))
  })
})

// ================================================================ AC-PRIV-09
describe('priv: chính sách đổi version', () => {
  it('AC-PRIV-09: ConsentBanner không hiện khi đã có lựa chọn cho đúng version (cả hai lựa chọn)', () => {
    for (const choice of ['granted', 'declined'] as const) {
      saveConsent(localStorage, 1, choice)
      const { unmount } = render(<ConsentBanner policyVersion={1} storage={localStorage} />)
      expect(bannerEl(), choice).toBeNull()
      expect(screen.queryByRole('button', { name: 'Đồng ý' }), choice).toBeNull()
      unmount()
    }
  })

  it('AC-PRIV-09: đã đồng ý version 1, manifest lên version 2 thì hộp đồng ý hiện lại và client không gửi gì kèm UUID', async () => {
    saveConsent(localStorage, 1, 'granted')
    policy = 2
    render(<Root />)
    expect(await screen.findByRole('button', { name: 'Đồng ý' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Chỉ chơi, không gửi gì' })).toBeTruthy()
    expect(canSend(localStorage, 2)).toBe(false)
    expect(canSend(localStorage, 1)).toBe(true)
    await screen.findByRole('list', { name: 'Đĩa nhúng' })
    expect(withPlayerHeader()).toEqual([])
  })

  it('AC-PRIV-09: đồng ý version 2 thì POST policy_version 2, lưu version 2 và canSend(2) là true', async () => {
    saveConsent(localStorage, 1, 'granted')
    policy = 2
    render(<Root />)
    fireEvent.click(await screen.findByRole('button', { name: 'Đồng ý' }))
    await waitFor(() => expect(readConsent(localStorage)).toEqual({ version: 2, choice: 'granted' }))
    const post = calls().find((c) => c.url === '/lau-meme/api/consents')!
    expect(JSON.parse(String(post.init?.body))).toEqual({ purpose: 'play', action: 'grant', policy_version: 2 })
    expect(canSend(localStorage, 2)).toBe(true)
  })

  it('AC-PRIV-09: canSend chỉ true khi lựa chọn granted và version khớp', () => {
    expect(canSend(localStorage, 1)).toBe(false)
    saveConsent(localStorage, 1, 'declined')
    expect(canSend(localStorage, 1)).toBe(false)
    saveConsent(localStorage, 1, 'granted')
    expect(canSend(localStorage, 1)).toBe(true)
    expect(canSend(localStorage, 2)).toBe(false)
    expect(readConsent(localStorage)).toEqual({ version: 1, choice: 'granted' })
  })
})
