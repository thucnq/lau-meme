// Acceptance tests for docs/acceptance/subpath.md: AC-SUBPATH-01..06 (Worker side).
/// <reference types="vite/client" />
// Worker tests run on the real static assets (web/dist), so the web must be built before this file runs.
import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import stackToml from '../../.dk/stack.toml?raw'
import wranglerRaw from '../wrangler.jsonc?raw'

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
  vars: { BASE_PATH?: string }
  routes: RouteCfg[]
  workers_dev?: boolean
  env: { staging: { vars: { BASE_PATH?: string }; routes: RouteCfg[] } }
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

  it('AC-SUBPATH-01: routes đúng một mục cho production và đúng một mục cho staging, workers_dev bật', () => {
    const wrangler = parseJsonc(wranglerRaw)
    const base = basePathJson.basePath
    expect(wrangler.routes).toEqual([{ pattern: `dinoduct.fun${base}*`, zone_name: 'dinoduct.fun' }])
    expect(wrangler.env.staging.routes).toEqual([{ pattern: `staging.dinoduct.fun${base}*`, zone_name: 'dinoduct.fun' }])
    for (const r of [...wrangler.routes, ...wrangler.env.staging.routes]) {
      expect(r.pattern).not.toBe('dinoduct.fun/*')
      expect(r.pattern).toContain(base)
    }
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
})
