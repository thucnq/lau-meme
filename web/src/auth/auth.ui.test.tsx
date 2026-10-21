// @vitest-environment jsdom
/// <reference types="node" />
/**
 * Acceptance tests for docs/acceptance/auth.md, web part: AC-AUTH-01, 02, 05, 06.
 *
 * PUBLIC SURFACE THIS TEST REQUIRES
 *   web/src/auth/api.ts:     type SessionInfo = { nickname: string | null; created_at: string }
 *                            signIn(credential, opts: PlayerOpts): Promise<SessionInfo>   POST api/auth/google via playerFetch
 *                            getSession(): Promise<SessionInfo | null>                    GET api/auth/session, 401 -> null
 *                            signOut(): Promise<void>                                     DELETE api/auth/session
 *   web/src/auth/AuthBar.tsx: AuthBar({ policyVersion, storage, onChange? }), uses window.google.accounts.id
 *   PolicyPage, MyDataPanel (existing) with the AUTH additions.
 */
import { webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MyDataPanel } from '../privacy/MyDataPanel'
import { PolicyPage } from '../privacy/PolicyPage'
import { ConsentRequiredError } from '../privacy/client'
import { saveConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { getSession, signIn, signOut, type SessionInfo } from './api'
import { AuthBar } from './AuthBar'

// ---------------------------------------------------------------- fixtures
const CREATED = '2026-10-19T01:00:00.000Z'
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const problem = (status: number): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
const methodOf = (input: RequestInfo | URL, init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
const headerOf = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(name)

let fetchMock: ReturnType<typeof vi.fn>
/** Server-side session as the mocked API sees it; null means 401. */
let serverSession: SessionInfo | null = null
/** What POST api/auth/google answers on success. */
let signInAs: SessionInfo = { nickname: null, created_at: CREATED }

function installNet(): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    if (url.endsWith('/api/auth/google') && method === 'POST') {
      serverSession = signInAs
      return json(signInAs)
    }
    if (url.endsWith('/api/auth/session') && method === 'GET') return serverSession ? json(serverSession) : problem(401)
    if (url.endsWith('/api/auth/session') && method === 'DELETE') {
      serverSession = null
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/api/me') && method === 'GET') return json(myData(null))
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
}
const calls = () =>
  fetchMock.mock.calls.map((c) => ({
    url: urlOf(c[0] as RequestInfo),
    method: methodOf(c[0] as RequestInfo, c[1] as RequestInit | undefined),
    player: headerOf(c[0] as RequestInfo, c[1] as RequestInit | undefined, 'X-Player-Id'),
    init: c[1] as RequestInit | undefined,
  }))
const signInCalls = () => calls().filter((c) => c.url.endsWith('/api/auth/google'))
const opts = () => ({ storage: localStorage as Storage | null, policyVersion: 1 })

// Google Identity Services stub: renderButton appends a button whose click delivers a fake credential.
type GisCfg = { client_id: string; callback: (r: { credential: string }) => void }
function installGis() {
  let cfg: GisCfg | null = null
  const id = {
    initialize: vi.fn((c: GisCfg) => {
      cfg = c
    }),
    renderButton: vi.fn((el: HTMLElement) => {
      const b = document.createElement('button')
      b.textContent = 'Đăng nhập bằng Google'
      b.addEventListener('click', () => cfg!.callback({ credential: 'fake.id.token' }))
      el.appendChild(b)
    }),
    prompt: vi.fn(),
    disableAutoSelect: vi.fn(),
  }
  vi.stubGlobal('google', { accounts: { id } })
  return id
}

function myData(account: unknown) {
  return {
    nickname: null,
    account,
    discoveries: [],
    daily_results: [],
    streak: { current: 0, longest: 0 },
    reports: [],
    votes: [],
    consents: [],
    event_counts: {},
  }
}

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
beforeEach(() => {
  localStorage.clear()
  serverSession = null
  signInAs = { nickname: null, created_at: CREATED }
  installNet()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.stubGlobal('crypto', webcrypto)
})

const signInButtons = () => screen.findAllByRole('button', { name: 'Đăng nhập bằng Google' })

// ================================================================ AC-AUTH-01
describe('auth: đăng nhập bằng Google', () => {
  it('AC-AUTH-01: chưa đồng ý thì bấm đăng nhập hiện lời mời đồng ý và không gửi gì tới api/auth/google', async () => {
    const onChange = vi.fn()
    render(<AuthBar policyVersion={1} storage={localStorage} onChange={onChange} />)
    const [button] = await signInButtons()
    fireEvent.click(button!)
    expect(await screen.findByText(/Cần đồng ý chính sách dữ liệu để gửi/)).toBeTruthy()
    expect(signInCalls()).toEqual([])
    expect(screen.queryByText(/Đã đăng nhập/)).toBeNull()
  })

  it('AC-AUTH-01: signIn ném ConsentRequiredError mà không gọi mạng khi chưa đồng ý', async () => {
    await expect(signIn('fake.id.token', opts())).rejects.toBeInstanceOf(ConsentRequiredError)
    expect(signInCalls()).toEqual([])
  })

  it('AC-AUTH-01: signIn gửi POST api/auth/google { credential } kèm X-Player-Id và trả SessionInfo', async () => {
    saveConsent(localStorage, 1, 'granted')
    const info = await signIn('fake.id.token', opts())
    expect(info).toEqual({ nickname: null, created_at: CREATED })
    const [c] = signInCalls()
    expect(c!.url).toBe('/lau-meme/api/auth/google')
    expect(c!.method).toBe('POST')
    expect(c!.player).toBe(getPlayerId(localStorage))
    expect(JSON.parse(String(c!.init?.body))).toEqual({ credential: 'fake.id.token' })
  })

  it('AC-AUTH-01: signIn ném lỗi khi server trả 401', async () => {
    saveConsent(localStorage, 1, 'granted')
    fetchMock.mockImplementationOnce(async () => problem(401))
    await expect(signIn('bad', opts())).rejects.toBeDefined()
  })

  it('AC-AUTH-01: đã đồng ý thì khởi tạo GIS, bấm nút gửi credential rồi hiện "Đã đăng nhập" và "Thực khách ẩn danh" khi chưa có nickname', async () => {
    saveConsent(localStorage, 1, 'granted')
    const gis = installGis()
    const onChange = vi.fn()
    render(<AuthBar policyVersion={1} storage={localStorage} onChange={onChange} />)

    await waitFor(() => expect(gis.initialize).toHaveBeenCalled())
    const cfg = gis.initialize.mock.calls[0]![0]
    expect(typeof cfg.client_id).toBe('string')
    expect(typeof cfg.callback).toBe('function')
    await waitFor(() => expect(gis.renderButton).toHaveBeenCalled())

    const [button] = await signInButtons()
    fireEvent.click(button!)

    expect(await screen.findByText(/Đã đăng nhập/)).toBeTruthy()
    expect(screen.getByText(/Thực khách ẩn danh/)).toBeTruthy()
    const [c] = signInCalls()
    expect(c!.method).toBe('POST')
    expect(c!.player).toBe(getPlayerId(localStorage))
    expect(JSON.parse(String(c!.init?.body))).toEqual({ credential: 'fake.id.token' })
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ nickname: null })))
  })

  it('AC-AUTH-01: tài khoản đã có nickname thì hiện "Đã đăng nhập" kèm nickname', async () => {
    saveConsent(localStorage, 1, 'granted')
    signInAs = { nickname: 'Lẩu Thủ', created_at: CREATED }
    installGis()
    render(<AuthBar policyVersion={1} storage={localStorage} />)
    const [button] = await signInButtons()
    fireEvent.click(button!)
    expect(await screen.findByText(/Đã đăng nhập/)).toBeTruthy()
    expect(screen.getByText(/Lẩu Thủ/)).toBeTruthy()
    expect(screen.queryByText(/Thực khách ẩn danh/)).toBeNull()
  })
})

// ================================================================ AC-AUTH-02
describe('auth: phiên qua tải lại', () => {
  it('AC-AUTH-02: khi tải trang mà server còn phiên thì hiện "Đã đăng nhập" và nickname mà không cần bấm gì', async () => {
    serverSession = { nickname: 'Lẩu Thủ', created_at: CREATED }
    render(<AuthBar policyVersion={1} storage={localStorage} />)
    expect(await screen.findByText(/Đã đăng nhập/)).toBeTruthy()
    expect(screen.getByText(/Lẩu Thủ/)).toBeTruthy()
    expect(calls().some((c) => c.method === 'GET' && c.url.endsWith('/api/auth/session'))).toBe(true)
    expect(signInCalls()).toEqual([])
  })

  it('AC-AUTH-02: server trả 401 thì hiện giao diện chưa đăng nhập', async () => {
    render(<AuthBar policyVersion={1} storage={localStorage} />)
    expect((await signInButtons()).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Đã đăng nhập/)).toBeNull()
    expect(await getSession()).toBeNull()
  })

  it('AC-AUTH-02: getSession trả SessionInfo khi 200 (GET api/auth/session)', async () => {
    serverSession = { nickname: null, created_at: CREATED }
    expect(await getSession()).toEqual({ nickname: null, created_at: CREATED })
    const c = calls().find((x) => x.url.endsWith('/api/auth/session'))!
    expect(c.method).toBe('GET')
    expect(c.url).toBe('/lau-meme/api/auth/session')
  })

  it('AC-AUTH-02: client không tự đọc hay ghi mã phiên: document.cookie và localStorage không có laumeme_sid sau khi đăng nhập', async () => {
    saveConsent(localStorage, 1, 'granted')
    installGis()
    render(<AuthBar policyVersion={1} storage={localStorage} />)
    const [button] = await signInButtons()
    fireEvent.click(button!)
    await screen.findByText(/Đã đăng nhập/)
    expect(document.cookie).not.toContain('laumeme_sid')
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      expect(`${k}=${localStorage.getItem(k)}`).not.toContain('laumeme_sid')
    }
  })
})

// ================================================================ AC-AUTH-05
describe('auth: đăng xuất', () => {
  it('AC-AUTH-05: bấm "Đăng xuất" gửi DELETE api/auth/session rồi nút "Đăng nhập bằng Google" trở lại', async () => {
    saveConsent(localStorage, 1, 'granted')
    installGis()
    serverSession = { nickname: 'Lẩu Thủ', created_at: CREATED }
    const onChange = vi.fn()
    render(<AuthBar policyVersion={1} storage={localStorage} onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))

    await waitFor(() => expect(calls().some((c) => c.method === 'DELETE' && c.url === '/lau-meme/api/auth/session')).toBe(true))
    expect((await signInButtons()).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Đã đăng nhập/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Đăng xuất' })).toBeNull()
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null))
  })

  it('AC-AUTH-05: signOut gửi DELETE api/auth/session', async () => {
    await signOut()
    const c = calls().find((x) => x.method === 'DELETE')!
    expect(c.url).toBe('/lau-meme/api/auth/session')
  })
})

// ================================================================ AC-AUTH-06
describe('auth: chính sách và xem dữ liệu', () => {
  it('AC-AUTH-06: PolicyPage nêu mã tài khoản Google dạng băm, mục đích định danh trên bảng xếp hạng, thời hạn đến khi xóa', () => {
    render(<PolicyPage />)
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/mã tài khoản Google dạng băm/i)
    expect(text).toMatch(/định danh trên bảng xếp hạng/i)
    expect(text).toMatch(/đến khi (bạn )?xóa/i)
  })

  it('AC-AUTH-06: MyDataPanel có phiên thì hiện "Tài khoản Google" và số phiên đang mở, không có băm sub', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).endsWith('/api/me') && methodOf(input, init) === 'GET') {
        return json(
          myData({
            created_at: CREATED,
            open_sessions: 2,
            nickname: 'Lẩu Thủ',
            daily_results: [],
            streak: { current: 3, longest: 3 },
          }),
        )
      }
      return new Response(null, { status: 204 })
    })
    saveConsent(localStorage, 1, 'granted')
    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    expect(await screen.findByText(/Tài khoản Google/)).toBeTruthy()
    expect(await screen.findByText(/2 phiên đang mở/)).toBeTruthy()
    expect(document.body.textContent ?? '').not.toMatch(/sub_hash/i)
  })

  it('AC-AUTH-06: MyDataPanel không hiện dòng "Tài khoản Google" khi account là null', async () => {
    saveConsent(localStorage, 1, 'granted')
    render(<MyDataPanel policyVersion={1} storage={localStorage} />)
    await screen.findByRole('heading', { name: 'Dữ liệu của tôi' })
    await waitFor(() => expect(calls().some((c) => c.url === '/lau-meme/api/me' && c.method === 'GET')).toBe(true))
    expect(screen.queryByText(/Tài khoản Google/)).toBeNull()
    expect(screen.queryByText(/phiên đang mở/)).toBeNull()
  })
})
