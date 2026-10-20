// @vitest-environment node
/// <reference types="node" />
/**
 * Acceptance tests cho docs/acceptance/subpath.md, phần build thật của web: AC-SUBPATH-07 (quét thư mục build)
 * và AC-SUBPATH-11 (thẻ xem trước link và favicon). Chạy `vite build` bằng cấu hình thật vào thư mục tạm.
 * Các phần cần DOM (URL do api.ts gọi, localStorage, link chia sẻ) nằm ở subpath.ui.test.tsx.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { build } from 'vite'

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SITE = 'https://dinoduct.fun/lau-meme/'
const BUILD_TIMEOUT = 60_000

let outDir: string | null = null
let building: Promise<string> | null = null

function buildOnce(): Promise<string> {
  building ??= (async () => {
    outDir = mkdtempSync(join(tmpdir(), 'lau-meme-subpath-'))
    await build({
      root: WEB_ROOT,
      configFile: join(WEB_ROOT, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    })
    return outDir
  })()
  return building
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? ''
  return out
}

function headTags(html: string, name: 'meta' | 'link'): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => attrs(m[0]))
}

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

describe('subpath build', () => {
  // ============================================================== AC-SUBPATH-07
  it('AC-SUBPATH-07: index.html nằm ở <outDir>/lau-meme/index.html, asset ở <outDir>/lau-meme/assets/', async () => {
    const dir = await buildOnce()
    expect(existsSync(join(dir, 'lau-meme', 'index.html'))).toBe(true)
    expect(existsSync(join(dir, 'lau-meme', 'assets'))).toBe(true)
    expect(readdirSync(join(dir, 'lau-meme', 'assets')).length).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'index.html'))).toBe(false)
    expect(existsSync(join(dir, 'assets'))).toBe(false)
  }, BUILD_TIMEOUT)

  it('AC-SUBPATH-07: không file .html/.js/.css nào chứa đường dẫn tuyệt đối thiếu tiền tố /lau-meme/', async () => {
    const dir = await buildOnce()
    const files = walk(dir).filter((f) => ['.html', '.js', '.css'].includes(extname(f)))
    expect(files.length).toBeGreaterThan(0)
    const bad: { file: string; match: string }[] = []
    const patterns = [
      /["'`]\/(?:api|img|assets)\//g,
      /(?:href|src)=["']\/(?!lau-meme\/)/g,
      /url\(\s*["']?\/(?!lau-meme\/)/g,
    ]
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const re of patterns) for (const m of text.matchAll(re)) bad.push({ file: f.slice(dir.length), match: m[0] })
    }
    expect(bad).toEqual([])
    const html = readFileSync(join(dir, 'lau-meme', 'index.html'), 'utf8')
    expect(html).toMatch(/(?:src|href)="\/lau-meme\/assets\//)
  }, BUILD_TIMEOUT)

  // ============================================================== AC-SUBPATH-11
  it('AC-SUBPATH-11: <head> có canonical, og:url, og:title, og:image tuyệt đối, twitter:card và <title> Lẩu Meme', async () => {
    const dir = await buildOnce()
    const html = readFileSync(join(dir, 'lau-meme', 'index.html'), 'utf8')
    const head = html.slice(0, html.indexOf('</head>'))
    const links = headTags(head, 'link')
    const metas = headTags(head, 'meta')
    const prop = (p: string): string | undefined => metas.find((m) => m.property === p)?.content

    expect(links.find((l) => l.rel === 'canonical')?.href).toBe(SITE)
    expect(prop('og:url')).toBe(SITE)
    expect(prop('og:title')).toBe('Lẩu Meme')
    expect(prop('og:image')?.startsWith(SITE)).toBe(true)
    expect(metas.some((m) => m.name === 'twitter:card' && (m.content ?? '').length > 0)).toBe(true)
    expect(head.match(/<title>([^<]*)<\/title>/)?.[1]?.trim()).toBe('Lẩu Meme')
  }, BUILD_TIMEOUT)

  it('AC-SUBPATH-11: favicon có href bắt đầu bằng /lau-meme/', async () => {
    const dir = await buildOnce()
    const html = readFileSync(join(dir, 'lau-meme', 'index.html'), 'utf8')
    const icons = headTags(html, 'link').filter((l) => (l.rel ?? '').split(/\s+/).includes('icon'))
    expect(icons.length).toBeGreaterThan(0)
    for (const l of icons) expect(l.href?.startsWith('/lau-meme/'), l.href).toBe(true)
  }, BUILD_TIMEOUT)
})
