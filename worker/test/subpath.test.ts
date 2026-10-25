// Acceptance tests for docs/acceptance/subpath.md: AC-SUBPATH-01..06 (Worker side).
/// <reference types="vite/client" />
// Worker tests run on the real static assets (web/dist), so the web must be built before this file runs.
import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import stackToml from '../../.dk/stack.toml?raw'
import wranglerRaw from '../wrangler.jsonc?raw'
import worker from '../src/index'

const BASE = '/lau-meme'

// base-path.json is read through a glob so a missing file fails AC-SUBPATH-01 only (not the whole file).
const basePathFiles = import.meta.glob('../../base-path.json', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>
const basePathJson: { basePath?: string } = JSON.parse(Object.values(basePathFiles)[0] ?? '{}')
const ORIGIN = 'https://example.com'
const HTML = { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' }

// ---------------------------------------------------------------- helpers
// Minimal JSONC parser: strips line and block comments outside strings, and trailing commas.
type RouteCfg = { pattern: string; zone_name: string }
type WranglerCfg = {
  vars: { BASE_PATH?: string; ADMIN_HOST?: string }
  routes: RouteCfg[]
  workers_dev?: boolean
  env: { staging: { vars: { BASE_PATH?: string; ADMIN_HOST?: string }; routes: RouteCfg[] } }
}

function parseJsonc(text: string): WranglerCfg {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const get = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { headers, ...init })

const isHtml = (res: Response) => (res.headers.get('content-type') ?? '').includes('text/html')

describe('subpath', () => {
  // ============================================================== AC-SUBPATH-01
  it('AC-SUBPATH-01: BASE_PATH của Worker (production và staging) bằng base-path.json', () => {
    const wrangler = parseJsonc(wranglerRaw)
    expect(basePathJson.basePath).toBe(BASE)
    expect(wrangler.vars.BASE_PATH).toBe(basePathJson.basePath)
    expect(wrangler.env.staging.vars.BASE_PATH).toBe(basePathJson.basePath)
    expect((env as unknown as { BASE_PATH?: string }).BASE_PATH).toBe(basePathJson.basePath)
  })

  it('AC-SUBPATH-01: mỗi môi trường đúng một route game, một route host quản trị (ADR 0008) và một route robots.txt (AC-SUBPATH-15), không route nào khác, workers_dev bật', () => {
    const wrangler = parseJsonc(wranglerRaw)
    const base = basePathJson.basePath
    const byPattern = (a: RouteCfg, b: RouteCfg) => a.pattern.localeCompare(b.pattern)
    const prodExpected: RouteCfg[] = [
      { pattern: `dinoduct.fun${base}*`, zone_name: 'dinoduct.fun' },
      { pattern: 'laumeme-admin.dinoduct.fun/*', zone_name: 'dinoduct.fun' },
      { pattern: 'dinoduct.fun/robots.txt', zone_name: 'dinoduct.fun' },
    ]
    const stagingExpected: RouteCfg[] = [
      { pattern: `staging.dinoduct.fun${base}*`, zone_name: 'dinoduct.fun' },
      { pattern: 'laumeme-admin-staging.dinoduct.fun/*', zone_name: 'dinoduct.fun' },
      { pattern: 'staging.dinoduct.fun/robots.txt', zone_name: 'dinoduct.fun' },
    ]
    expect(wrangler.routes).toHaveLength(3)
    expect(wrangler.env.staging.routes).toHaveLength(3)
    expect([...wrangler.routes].sort(byPattern)).toEqual([...prodExpected].sort(byPattern))
    expect([...wrangler.env.staging.routes].sort(byPattern)).toEqual([...stagingExpected].sort(byPattern))
    const forbidden = ['dinoduct.fun/*', 'staging.dinoduct.fun/*', 'dinoduct.fun/', 'staging.dinoduct.fun/', 'dinoduct.fun', 'staging.dinoduct.fun']
    for (const r of [...wrangler.routes, ...wrangler.env.staging.routes]) {
      expect(forbidden).not.toContain(r.pattern)
      expect(r.pattern.includes(base ?? '/lau-meme') || r.pattern.startsWith('laumeme-admin') || r.pattern.endsWith('.fun/robots.txt')).toBe(true)
    }
    expect(wrangler.vars.ADMIN_HOST).toBe('laumeme-admin.dinoduct.fun')
    expect(wrangler.env.staging.vars.ADMIN_HOST).toBe('laumeme-admin-staging.dinoduct.fun')
    expect(wrangler.workers_dev).toBe(true)
  })

  it('AC-SUBPATH-01: deploy.health trong .dk/stack.toml là /lau-meme/api/health', () => {
    expect(stackToml).toMatch(/health\s*=\s*"\/lau-meme\/api\/health"/)
    expect(stackToml).not.toMatch(/health\s*=\s*"\/api\/health"/)
  })

  // ============================================================== AC-SUBPATH-02
  it('AC-SUBPATH-02: GET /lau-meme/api/health trả 200 {status, env, schema}', async () => {
    const res = await get(`${BASE}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(typeof body.env).toBe('string')
    expect(body.schema).toBeDefined()
  })

  it('AC-SUBPATH-02: GET /lau-meme/api/khong-co trả 404 problem+json', async () => {
    const res = await get(`${BASE}/api/khong-co`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
  })

  it('AC-SUBPATH-02: các API khác chỉ trả lời dưới /lau-meme/api/*', async () => {
    // Under the prefix the route exists (manifest: 200 or 503 before the first batch; state: 401 without token).
    expect([200, 503]).toContain((await get(`${BASE}/api/manifest`)).status)
    expect((await get(`${BASE}/api/pipeline/state`)).status).toBe(401)
    // Without the prefix nothing answers.
    for (const p of ['/api/manifest', '/api/pipeline/state', '/api/graph/1', '/api/daily/1/leaderboard', '/api/health']) {
      const res = await get(p)
      expect(res.status, p).toBe(404)
      expect(isHtml(res), p).toBe(false)
    }
  })

  // ============================================================== AC-SUBPATH-03
  it('AC-SUBPATH-03: GET /lau-meme (thiếu dấu gạch chéo cuối) chuyển 301 sang /lau-meme/', async () => {
    const res = await get(BASE, {}, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/lau-meme/')
  })

  it('AC-SUBPATH-03: GET /lau-meme?ref=daily giữ query string', async () => {
    const res = await get(`${BASE}?ref=daily`, {}, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/lau-meme/?ref=daily')
  })

  // ============================================================== AC-SUBPATH-04
  it('AC-SUBPATH-04: ngoài tiền tố mọi đường dẫn là 404 (có và không có Accept: text/html), không trả HTML game', async () => {
    const paths = ['/', '/lau-meme-abc', '/api/health', '/index.html', '/assets/x.js']
    for (const p of paths) {
      for (const headers of [{}, HTML]) {
        const res = await get(p, headers)
        const label = `${p} ${JSON.stringify(headers)}`
        expect(res.status, label).toBe(404)
        expect(isHtml(res), label).toBe(false)
        expect(await res.text(), label).not.toContain('id="root"')
      }
    }
  })

  // ============================================================== AC-SUBPATH-05
  it('AC-SUBPATH-05: điều hướng tới /lau-meme/, /lau-meme/bat-ky, /lau-meme/a/b/c?x=1 trả index.html của game', async () => {
    for (const p of ['/lau-meme/', '/lau-meme/bat-ky', '/lau-meme/a/b/c?x=1']) {
      const res = await get(p, HTML)
      expect(res.status, p).toBe(200)
      expect(isHtml(res), p).toBe(true)
      expect(await res.text(), p).toContain('<div id="root">')
    }
  })

  it('AC-SUBPATH-05: file không tồn tại mà không phải điều hướng trả 404, không trả HTML', async () => {
    const res = await get('/lau-meme/assets/khong-co.js', { Accept: '*/*', 'Sec-Fetch-Mode': 'no-cors' })
    expect(res.status).toBe(404)
    expect(isHtml(res)).toBe(false)
    expect(await res.text()).not.toContain('<div id="root">')
  })

  it('AC-SUBPATH-05: file tĩnh có thật dưới /lau-meme/assets/ (tham chiếu từ index.html) trả 200', async () => {
    const html = await (await get('/lau-meme/', HTML)).text()
    const m = html.match(/["'](\/lau-meme\/assets\/[^"']+\.js)["']/)
    expect(m, 'index.html phải tham chiếu một file .js dưới /lau-meme/assets/').not.toBeNull()
    const res = await get(m![1]!, { Accept: '*/*' })
    expect(res.status).toBe(200)
    expect(isHtml(res)).toBe(false)
  })

  // ============================================================== AC-SUBPATH-06
  it('AC-SUBPATH-06: GET /lau-meme/img/<id>.webp trả 404 problem+json, không trả HTML game', async () => {
    for (const headers of [{}, HTML]) {
      const res = await get('/lau-meme/img/0123456789ab.webp', headers)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
      expect(await res.text()).not.toContain('<div id="root">')
    }
  })

  // ============================================================== AC-SUBPATH-13
  // Trang chính sách /lau-meme/chinh-sach phải mở được bằng GET/HEAD không cần Accept: text/html
  // (trình quét của Meta/Threads gửi Accept */* hoặc không có Accept).
  const POLICY_PATHS = ['/lau-meme/chinh-sach', '/lau-meme/chinh-sach/']
  const POLICY_HEADER_SETS: Array<[string, Record<string, string>]> = [
    ['không Accept', {}],
    ['Accept */*', { Accept: '*/*' }],
    ['User-Agent facebookexternalhit/1.1', { 'User-Agent': 'facebookexternalhit/1.1' }],
  ]

  it('AC-SUBPATH-13: GET trang chính sách (có và không có dấu / cuối) trả 200 text/html là index.html dù không có Accept: text/html', async () => {
    const dbSpy = vi.spyOn(env.DB, 'prepare')
    for (const p of POLICY_PATHS) {
      for (const [name, headers] of POLICY_HEADER_SETS) {
        const label = `GET ${p} (${name})`
        const res = await get(p, headers)
        expect(res.status, label).toBe(200)
        expect(isHtml(res), label).toBe(true)
        expect(await res.text(), label).toContain('<div id="root">')
      }
    }
    expect(dbSpy).not.toHaveBeenCalled()
    dbSpy.mockRestore()
  })

  it('AC-SUBPATH-13: HEAD trang chính sách trả 200 text/html và body rỗng', async () => {
    for (const p of POLICY_PATHS) {
      for (const [name, headers] of POLICY_HEADER_SETS) {
        const label = `HEAD ${p} (${name})`
        const res = await get(p, headers, { method: 'HEAD' })
        expect(res.status, label).toBe(200)
        expect(isHtml(res), label).toBe(true)
        expect(await res.text(), label).toBe('')
      }
    }
  })

  it('AC-SUBPATH-13: POST /lau-meme/chinh-sach không trả HTML của game', async () => {
    const headerSets: Array<Record<string, string>> = [{}, { Accept: '*/*' }, HTML]
    for (const headers of headerSets) {
      const res = await get('/lau-meme/chinh-sach', headers, { method: 'POST', body: '{}' })
      const label = JSON.stringify(headers)
      expect(res.status, label).toBeGreaterThanOrEqual(400)
      expect(isHtml(res), label).toBe(false)
      expect(await res.text(), label).not.toContain('<div id="root">')
    }
  })

  it('AC-SUBPATH-13: file không có trong /lau-meme/assets/ với Accept */* vẫn 404, không trả HTML', async () => {
    const res = await get('/lau-meme/assets/khong-co.js', { Accept: '*/*' })
    expect(res.status).toBe(404)
    expect(isHtml(res)).toBe(false)
    expect(await res.text()).not.toContain('<div id="root">')
  })

  it('AC-SUBPATH-13: /lau-meme/chinh-sach-abc không có Accept vẫn 404, không trả HTML', async () => {
    const res = await get('/lau-meme/chinh-sach-abc')
    expect(res.status).toBe(404)
    expect(isHtml(res)).toBe(false)
    expect(await res.text()).not.toContain('<div id="root">')
  })

  // ============================================================== AC-SUBPATH-14
  // Trang chính sách tĩnh cho bot của Meta: không chạy JS, không đi theo canonical về production.
  const STATIC_POLICY = '/lau-meme/chinh-sach-tinh'

  it('AC-SUBPATH-14: GET /lau-meme/chinh-sach-tinh trả 200 HTML tĩnh có sẵn chữ chính sách, không canonical, og:url, root hay script', async () => {
    const dbSpy = vi.spyOn(env.DB, 'prepare')
    for (const [name, headers] of POLICY_HEADER_SETS) {
      const label = `GET ${STATIC_POLICY} (${name})`
      const res = await get(STATIC_POLICY, headers)
      expect(res.status, label).toBe(200)
      expect(isHtml(res), label).toBe(true)
      const body = await res.text()
      expect(body, label).toContain('Chính sách quyền riêng tư')
      expect(body, label).toContain('mailto:')
      expect(body, label).not.toMatch(/rel=["']?canonical/)
      expect(body, label).not.toContain('og:url')
      expect(body, label).not.toContain('<div id="root">')
      expect(body, label).not.toMatch(/<script/i)
    }
    expect(dbSpy).not.toHaveBeenCalled()
    dbSpy.mockRestore()
  })

  it('AC-SUBPATH-14: HEAD /lau-meme/chinh-sach-tinh trả 200 text/html và body rỗng', async () => {
    for (const [name, headers] of POLICY_HEADER_SETS) {
      const label = `HEAD ${STATIC_POLICY} (${name})`
      const res = await get(STATIC_POLICY, headers, { method: 'HEAD' })
      expect(res.status, label).toBe(200)
      expect(isHtml(res), label).toBe(true)
      expect(await res.text(), label).toBe('')
    }
  })

  // ============================================================== AC-SUBPATH-15
  // Bot của Meta đọc /robots.txt trước; gốc miền không có máy chủ (522) thì Meta coi như bị chặn.
  const ROBOTS_PROD = 'User-agent: *\nAllow: /\n'
  const ROBOTS_NONPROD = 'User-agent: facebookexternalhit\nAllow: /\n\nUser-agent: *\nDisallow: /\n'

  /** The Worker with another APP_ENV (tests run on the top-level, production vars). */
  async function fetchAs(appEnv: string, path: string, init: RequestInit = {}): Promise<Response> {
    const ctx = createExecutionContext()
    const res = await (worker as unknown as { fetch: (r: Request, e: unknown, c: ExecutionContext) => Promise<Response> }).fetch(
      new Request(`${ORIGIN}${path}`, init),
      { ...env, APP_ENV: appEnv },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    return res
  }

  it('AC-SUBPATH-15: production - GET /robots.txt trả 200 text/plain cho mọi bot, HEAD không thân, không đụng D1', async () => {
    const dbSpy = vi.spyOn(env.DB, 'prepare')
    for (const [name, headers] of POLICY_HEADER_SETS) {
      const res = await get('/robots.txt', headers)
      expect(res.status, name).toBe(200)
      expect(res.headers.get('content-type') ?? '', name).toContain('text/plain')
      expect(await res.text(), name).toBe(ROBOTS_PROD)
    }
    const head = await get('/robots.txt', {}, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type') ?? '').toContain('text/plain')
    expect(await head.text()).toBe('')
    expect(dbSpy).not.toHaveBeenCalled()
    dbSpy.mockRestore()
  })

  it('AC-SUBPATH-15: staging và preview - /robots.txt chỉ cho facebookexternalhit, cấm mọi bot khác', async () => {
    for (const appEnv of ['staging', 'preview']) {
      const res = await fetchAs(appEnv, '/robots.txt')
      expect(res.status, appEnv).toBe(200)
      expect(res.headers.get('content-type') ?? '', appEnv).toContain('text/plain')
      expect(await res.text(), appEnv).toBe(ROBOTS_NONPROD)
    }
  })

  it('AC-SUBPATH-15: POST /robots.txt trả 405 problem+json', async () => {
    const res = await get('/robots.txt', {}, { method: 'POST', body: '{}' })
    expect(res.status).toBe(405)
    expect(res.headers.get('content-type') ?? '').toContain('application/problem+json')
  })

  it('AC-SUBPATH-15: /robots.txt trên host quản trị vẫn 404', async () => {
    const res = await SELF.fetch('https://laumeme-admin.dinoduct.fun/robots.txt')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('User-agent')
  })
})
