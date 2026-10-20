// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/disc.md, phần web: api.ts và NicknameForm
 * (AC-DISC-02, 03, 04, 05, 09, 11).
 *
 * BỀ MẶT CÔNG KHAI MÀ TEST NÀY YÊU CẦU (web/src/disc/)
 *   api.ts: submitDiscovery(combo, {storage, policyVersion}), listDiscoveries(ids), putNickname(nickname, opts),
 *           NicknameError { reason: 'invalid' | 'taken' | 'consent' }, heirloomLine(nickname)
 *   NicknameForm.tsx: <NicknameForm policyVersion storage />
 */
import { webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsentRequiredError } from '../privacy/client'
import { saveConsent } from '../privacy/consent'
import { MyDataPanel } from '../privacy/MyDataPanel'
import { getPlayerId } from '../privacy/player'
import { NicknameError, heirloomLine, listDiscoveries, putNickname, submitDiscovery } from './api'
import { NicknameForm } from './NicknameForm'

// ---------------------------------------------------------------- mạng giả
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' } })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

let fetchMock: ReturnType<typeof vi.fn>
let nicknameStatus = 200
let nicknameBody: unknown = { nickname: 'Bếp Trưởng 99' }
let discoveriesReply: () => Response = () => json({ element_id: 'x', nickname: 'Bếp', discovered_at: '2026-10-20T00:00:00.000Z', first: true }, 201)

function installNet(): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.endsWith('/api/consents') && method === 'POST') {
      const b = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return json({ ...b, created_at: '2026-10-20T00:00:00.000Z' }, 201)
    }
    if (url.endsWith('/api/me/nickname') && method === 'PUT') return json(nicknameBody, nicknameStatus)
    if (url.includes('/api/discoveries') && method === 'POST') return discoveriesReply()
    if (url.includes('/api/discoveries') && method === 'GET') return json({ items: [] })
    if (url.endsWith('/api/me') && method === 'GET')
      return json({ nickname: null, discoveries: [], daily_results: [], streak: { current: 0, longest: 0 }, reports: [], votes: [], consents: [], event_counts: {} })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const calls = () =>
  fetchMock.mock.calls.map((c) => ({
    url: urlOf(c[0] as RequestInfo),
    method: methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined),
    player: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id'),
    body: (c[1] as RequestInit | undefined)?.body as string | undefined,
  }))
const opts = (version = 1) => ({ storage: localStorage as Storage | null, policyVersion: version })
const COMBO = { a: 'Cay', b: 'Cười', result: 'Tới Công Chuyện' }

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  localStorage.clear()
  nicknameStatus = 200
  nicknameBody = { nickname: 'Bếp Trưởng 99' }
  installNet()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

// ================================================================ api.ts
describe('disc: api', () => {
  it('AC-DISC-05: submitDiscovery chưa đồng ý ném ConsentRequiredError và KHÔNG gọi fetch', async () => {
    await expect(submitDiscovery(COMBO, opts())).rejects.toBeInstanceOf(ConsentRequiredError)
    saveConsent(localStorage, 1, 'declined')
    await expect(submitDiscovery(COMBO, opts())).rejects.toBeInstanceOf(ConsentRequiredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('AC-DISC-05: submitDiscovery sau khi đồng ý POST /lau-meme/api/discoveries kèm X-Player-Id và trả kết quả của máy chủ', async () => {
    saveConsent(localStorage, 1, 'granted')
    const reply = { element_id: 'e'.repeat(43), nickname: 'Bếp Trưởng', discovered_at: '2026-10-20T00:00:00.000Z', first: true }
    discoveriesReply = () => json(reply, 201)
    const got = await submitDiscovery(COMBO, opts())
    expect(got).toEqual(reply)
    const post = calls().find((c) => c.method === 'POST' && c.url === '/lau-meme/api/discoveries')
    expect(post).toBeDefined()
    expect(post!.player).toBe(getPlayerId(localStorage))
    expect(JSON.parse(post!.body!)).toEqual(COMBO)
  })

  it('AC-DISC-06: submitDiscovery nhận cả 200 first:false (đã có người khám phá)', async () => {
    saveConsent(localStorage, 1, 'granted')
    const reply = { element_id: 'e'.repeat(43), nickname: 'Thực khách ẩn danh', discovered_at: '2026-10-19T00:00:00.000Z', first: false }
    discoveriesReply = () => json(reply, 200)
    expect(await submitDiscovery(COMBO, opts())).toEqual(reply)
  })

  it('AC-DISC-09: listDiscoveries rỗng trả [] mà không gọi fetch', async () => {
    expect(await listDiscoveries([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('AC-DISC-09: listDiscoveries GET ids phân tách bằng dấu phẩy, KHÔNG gửi X-Player-Id, trả danh sách items', async () => {
    const items = [{ element_id: 'a'.repeat(43), nickname: 'Bếp Trưởng', discovered_at: '2026-10-19T00:00:00.000Z' }]
    fetchMock.mockImplementation(async () => json({ items }))
    const got = await listDiscoveries(['a'.repeat(43), 'b'.repeat(43)])
    expect(got).toEqual(items)
    const [c] = calls()
    expect(c!.method).toBe('GET')
    expect(decodeURIComponent(c!.url)).toBe(`/lau-meme/api/discoveries?ids=${'a'.repeat(43)},${'b'.repeat(43)}`)
    expect(c!.player).toBeNull()
  })

  it('AC-DISC-09: listDiscoveries chia danh sách hơn 50 id thành nhiều yêu cầu (mỗi yêu cầu tối đa 50) và gộp kết quả', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i).padStart(43, 'x'))
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const q = decodeURIComponent(urlOf(input)).split('ids=')[1] ?? ''
      return json({ items: q.split(',').slice(0, 1).map((id) => ({ element_id: id, nickname: 'Bếp', discovered_at: '2026-10-19T00:00:00.000Z' })) })
    })
    const got = await listDiscoveries(ids)
    const cs = calls()
    expect(cs).toHaveLength(3)
    const sizes = cs.map((c) => decodeURIComponent(c.url).split('ids=')[1]!.split(',').length)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50)
    expect(sizes.reduce((x, y) => x + y, 0)).toBe(120)
    expect(got).toHaveLength(3)
  })

  it('AC-DISC-09: heirloomLine nối "Công thức gia truyền của <nickname>"', () => {
    expect(heirloomLine('Bếp Trưởng')).toBe('Công thức gia truyền của Bếp Trưởng')
    expect(heirloomLine('Thực khách ẩn danh')).toBe('Công thức gia truyền của Thực khách ẩn danh')
  })

  it('AC-DISC-02: putNickname PUT /lau-meme/api/me/nickname và trả nickname đã cắt khoảng trắng của máy chủ', async () => {
    saveConsent(localStorage, 1, 'granted')
    const got = await putNickname('  Bếp Trưởng 99 ', opts())
    expect(got).toBe('Bếp Trưởng 99')
    const put = calls().find((c) => c.method === 'PUT')!
    expect(put.url).toBe('/lau-meme/api/me/nickname')
    expect(put.player).toBe(getPlayerId(localStorage))
    expect(JSON.parse(put.body!)).toHaveProperty('nickname')
  })

  it.each([
    [422, 'invalid', 'Nickname không hợp lệ'],
    [409, 'taken', 'Nickname đã có người dùng'],
    [403, 'consent', 'Cần đồng ý'],
  ] as const)('AC-DISC-03: putNickname với trạng thái %i ném NicknameError reason %s', async (status, reason, title) => {
    saveConsent(localStorage, 1, 'granted')
    nicknameStatus = status
    nicknameBody = { type: 'about:blank', title, status }
    const err = await putNickname('Bếp', opts()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NicknameError)
    expect((err as NicknameError).reason).toBe(reason)
  })
})

// ================================================================ NicknameForm
describe('disc: NicknameForm', () => {
  const fill = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Nickname' }), { target: { value } })
  const box = () => screen.getByRole('checkbox', { name: 'Cho phép hiện nickname công khai' }) as HTMLInputElement
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Lưu nickname' }))

  it('AC-DISC-02: form có ô "Nickname", ô tick "Cho phép hiện nickname công khai" KHÔNG chọn sẵn và nút "Lưu nickname"', () => {
    saveConsent(localStorage, 1, 'granted')
    render(<NicknameForm policyVersion={1} storage={localStorage} />)
    expect(screen.getByRole('textbox', { name: 'Nickname' })).toBeTruthy()
    expect(box().checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Lưu nickname' })).toBeTruthy()
  })

  it('AC-DISC-02: chưa tick đồng ý nickname thì báo "Cần đồng ý hiện nickname công khai" và không gửi gì', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(<NicknameForm policyVersion={1} storage={localStorage} />)
    fill('Bếp Trưởng 99')
    save()
    expect(await screen.findByText(/Cần đồng ý hiện nickname công khai/)).toBeTruthy()
    expect(calls()).toEqual([])
  })

  it('AC-DISC-02: chưa đồng ý chính sách dữ liệu (play) thì hiện lời mời "Cần đồng ý chính sách dữ liệu để gửi" và không gửi gì', async () => {
    render(<NicknameForm policyVersion={1} storage={localStorage} />)
    fill('Bếp Trưởng 99')
    fireEvent.click(box())
    save()
    expect(await screen.findByText(/Cần đồng ý chính sách dữ liệu để gửi/)).toBeTruthy()
    expect(calls()).toEqual([])
  })

  it('AC-DISC-02: tick + lưu gửi POST consents (nickname, grant, version) rồi PUT nickname và hiện "Đã lưu nickname"', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(<NicknameForm policyVersion={1} storage={localStorage} />)
    fill('Bếp Trưởng 99')
    fireEvent.click(box())
    save()
    expect(await screen.findByText(/Đã lưu nickname/)).toBeTruthy()
    const cs = calls()
    const iConsent = cs.findIndex((c) => c.url === '/lau-meme/api/consents' && c.method === 'POST')
    const iPut = cs.findIndex((c) => c.url === '/lau-meme/api/me/nickname' && c.method === 'PUT')
    expect(iConsent).toBeGreaterThanOrEqual(0)
    expect(iPut).toBeGreaterThan(iConsent)
    expect(JSON.parse(cs[iConsent]!.body!)).toEqual({ purpose: 'nickname', action: 'grant', policy_version: 1 })
    expect(JSON.parse(cs[iPut]!.body!)).toEqual({ nickname: 'Bếp Trưởng 99' })
    expect(cs[iPut]!.player).toBe(getPlayerId(localStorage))
  })

  it('AC-DISC-03: máy chủ trả 422 thì hiện "Nickname không hợp lệ" chung chung, không nhắc lại từ đã gõ', async () => {
    saveConsent(localStorage, 1, 'granted')
    nicknameStatus = 422
    nicknameBody = { type: 'about:blank', title: 'Nickname không hợp lệ', status: 422 }
    render(<NicknameForm policyVersion={1} storage={localStorage} />)
    fill('tucam')
    fireEvent.click(box())
    save()
    expect(await screen.findByText(/Nickname không hợp lệ/)).toBeTruthy()
    expect(screen.queryByText(/Đã lưu nickname/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/từ cấm/i)
  })

  it('AC-DISC-04: máy chủ trả 409 thì hiện "Nickname đã có người dùng"', async () => {
    saveConsent(localStorage, 1, 'granted')
    nicknameStatus = 409
    nicknameBody = { type: 'about:blank', title: 'Nickname đã có người dùng', status: 409 }
    render(<NicknameForm policyVersion={1} storage={localStorage} />)
    fill('bep truong')
    fireEvent.click(box())
    save()
    expect(await screen.findByText(/Nickname đã có người dùng/)).toBeTruthy()
    await waitFor(() => expect(calls().some((c) => c.method === 'PUT')).toBe(true))
  })

  it('AC-DISC-02: bảng "Dữ liệu của tôi" có ô nhập "Nickname" (form đặt nickname)', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    expect(await screen.findByRole('textbox', { name: 'Nickname' })).toBeTruthy()
  })
})
