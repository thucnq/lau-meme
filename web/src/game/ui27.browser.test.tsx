/**
 * AC-GAME-27 (giao diện mới, cập nhật 2026-10-25: Helvetica của hệ điều hành, màu chủ đạo xanh lá) in real Chromium
 * (Vitest browser mode + Playwright), at the 5 viewports of AC-GAME-18, light and dark.
 *
 * What it checks, on the game page, the tutorial dialog ("?"), the leaderboard tab and the policy page:
 *   - one font family: body and headings resolve to "Helvetica Neue", Helvetica, Arial; no @font-face is declared and no
 *     font file (woff2/woff/ttf/otf) is requested; every request stays on the page's own origin (no Google Fonts, no CDN);
 *   - "Ầ ẫ ặ ỡ ự Đ" draws real glyphs in the body font (each differs from the missing-glyph box);
 *   - emoji use the OS colour emoji fonts (Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji);
 *   - the accent (game name, the selected tab) is green;
 *   - colours come from one token set on :root, with a different dark set;
 *   - visible text reaches 4.5:1 (3:1 for large text: >= 24 px, or >= 18.66 px bold) on its actual background;
 *   - no horizontal scroll at 360 px.
 * The layout ACs GAME-18..23 and TIER-02 keep their own files. CSS files outside src/styles/tokens.css carry no colour
 * literal (ADR 0017); the share image (src/share, drawn on a canvas into a PNG) is not CSS and is left out.
 * Theme is set through localStorage "laumeme:theme", as the player's own choice.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { PolicyPage } from '../privacy/PolicyPage'
import { initialProgress, saveProgress } from './engine'
import type { Manifest } from './engine'
import { Game } from './Game'
import indexCss from '../../index.css?raw'

const VIEWPORTS = [
  ['pc', 1366, 768],
  ['tablet-ngang', 1024, 768],
  ['tablet-doc', 768, 1024],
  ['mobile', 390, 844],
  ['mobile-nho', 360, 640],
] as const

const manifest = {
  version: 7,
  batch_at: new Date(Date.now() - 3_600_000).toISOString(),
  graph_url: '/api/graph/7',
  starters: [
    { id: 'cay', name: 'Cay', emoji: '🌶️' },
    { id: 'cuoi', name: 'Cười', emoji: '😂' },
    { id: 'toang', name: 'Toang', emoji: '💀' },
    { id: 'deadline', name: 'Deadline', emoji: '⏰' },
  ],
  miss_lines: ['Nồi trào rồi!'],
  daily: { element_id: 'x', emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 },
  policy_version: 1,
} as Manifest

const requested: string[] = []

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  requested.length = 0
  performance.clearResourceTimings()
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      requested.push(url)
      if (url.endsWith('/api/manifest')) return reply(manifest)
      if (url.includes('/api/graph/')) return reply({ format: 1, version: 7, entries: {} })
      if (url.endsWith('/api/blocklist')) return reply({ elements: [], recipes: [], images: [] })
      if (url.includes('/leaderboard'))
        return reply({
          version: 7,
          period: 'w',
          starts_at: '2026-10-18T17:00:00.000Z',
          ends_at: '2026-10-25T17:00:00.000Z',
          batches: 3,
          rows: [
            { rank: 1, nickname: 'Lẩu Thủ', solve_ms: 61000, streak: 4 },
            { rank: 2, nickname: 'Bếp Trưởng', solve_ms: 95000, streak: 2 },
          ],
          me: null,
        })
      return reply({ title: 'Not found' }, 404)
    }),
  )
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await page.viewport(1366, 768)
})

// ---------------------------------------------------------------- colour helpers
type Rgba = [number, number, number, number]
function parse(c: string): Rgba {
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (!m) throw new Error(`Không đọc được màu "${c}"`)
  const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number)
  return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]
}
const over = ([r, g, b, a]: Rgba, [R, G, B]: Rgba): Rgba => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1]
const lum = ([r, g, b]: Rgba): number => {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a: Rgba, b: Rgba): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}
function isGreen(c: Rgba): boolean {
  const [r, g, b] = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 40 || max !== g) return false
  const h = 60 * ((b - r) / (max - min) + 2)
  return h >= 85 && h <= 165
}

/** Solid background behind `el`: the nearest ancestor with a background colour, blended down to the page. */
function backgroundOf(el: Element): Rgba | null {
  const layers: Rgba[] = []
  for (let n: Element | null = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n)
    if (cs.backgroundImage !== 'none' && layers.length === 0) return null // text drawn straight on a gradient (tabletop)
    const c = parse(cs.backgroundColor)
    if (c[3] > 0) {
      layers.push(c)
      if (c[3] >= 1) break
    }
  }
  let bg: Rgba = layers.length && layers[layers.length - 1]![3] >= 1 ? layers.pop()! : parse(getComputedStyle(document.body).backgroundColor)
  while (layers.length) bg = over(layers.pop()!, bg)
  return bg
}

/** Every visible element holding its own text (not emoji, not disabled) meets 4.5:1, or 3:1 when large. */
function expectReadable(root: Element, where: string): number {
  let checked = 0
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .replace(/[\p{Extended_Pictographic}️‍\s]/gu, '')
    if (!own) continue
    if (el.closest('[aria-hidden="true"], .emoji') || (el as HTMLButtonElement).disabled) continue
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width === 0 || r.height === 0 || cs.visibility !== 'visible' || Number(cs.opacity) === 0) continue
    const bg = backgroundOf(el)
    if (!bg) continue
    const fg = over(parse(cs.color), bg)
    const size = Number.parseFloat(cs.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700)
    expect(contrast(fg, bg), `${where}: "${own.slice(0, 30)}" ${cs.color} trên ${bg.join(',')}`).toBeGreaterThanOrEqual(large ? 3 : 4.5)
    checked++
  }
  return checked
}

function expectHelvetica(el: Element, where: string): void {
  const families = getComputedStyle(el)
    .fontFamily.split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
  expect(families.slice(0, 3), `${where}: họ phông`).toEqual(['Helvetica Neue', 'Helvetica', 'Arial'])
}

function expectNoFontFilesNorOutsideRequests(where: string): void {
  expect([...document.fonts].length, `${where}: không khai báo @font-face`).toBe(0)
  const resources = performance.getEntriesByType('resource').map((e) => e.name)
  const all = [...resources, ...requested.map((u) => new URL(u, location.href).href)]
  expect(all.filter((u) => /\.(woff2?|ttf|otf)(\?|#|$)/i.test(u)), `${where}: tải file phông`).toEqual([])
  expect(all.filter((u) => new URL(u).origin !== location.origin), `${where}: request ra ngoài`).toEqual([])
}

async function mountGame(theme: 'light' | 'dark'): Promise<void> {
  const p = initialProgress(manifest, new Date())
  p.tutorial_seen = true
  saveProgress(localStorage, p)
  localStorage.setItem('laumeme:theme', theme)
  render(<Game />)
  await waitFor(() => expect(screen.getByTestId('pot').dataset.state).toBe('idle'))
  await screen.findByRole('region', { name: 'Món đặc biệt hôm nay' })
  await document.fonts.ready
  await settled()
}

/** Colour transitions (buttons fade over --motion-fast) finished, so computed colours are the final ones. */
async function settled(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(r))
  await Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined)))
}

// ================================================================ AC-GAME-27
describe.each(['light', 'dark'] as const)('ui27 giao diện mới (%s)', (theme) => {
  it.each(VIEWPORTS)(`AC-GAME-27: trang chơi, hướng dẫn và bảng xếp hạng - Helvetica, xanh lá, token, tương phản, không cuộn ngang (${theme}, %s)`, async (name, w, h) => {
    await page.viewport(w, h)
    await mountGame(theme)
    const where = `${theme}/${name}`

    // one family, system Helvetica; nothing downloaded, nothing outside the origin
    expectHelvetica(document.body, `${where} body`)
    expectHelvetica(screen.getByRole('heading', { level: 1 }), `${where} h1`)
    expectNoFontFilesNorOutsideRequests(where)

    // Vietnamese marks draw real glyphs: each one is unlike the missing-glyph box
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `16px ${getComputedStyle(document.body).fontFamily}`
    const tofu = ctx.measureText('\u{E000}').width
    for (const ch of 'ẦẫặỡựĐ') expect(ctx.measureText(ch).width, `${where}: "${ch}"`).not.toBe(tofu)

    // emoji: the OS colour emoji fonts
    const emoji = document.querySelector('.emoji, .daily-emoji')
    expect(emoji, `${where}: có emoji`).not.toBeNull()
    const ef = getComputedStyle(emoji!).fontFamily
    for (const f of ['Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji']) expect(ef, `${where}: phông emoji`).toContain(f)

    // accent: green game name and selected tab
    expect(isGreen(parse(getComputedStyle(screen.getByRole('heading', { level: 1 })).color)), `${where}: tên game xanh lá`).toBe(true)
    const selected = screen.getByRole('tab', { selected: true })
    expect(isGreen(parse(getComputedStyle(selected).backgroundColor)), `${where}: tab đang chọn xanh lá`).toBe(true)

    // one token set, light and dark differ
    const root = getComputedStyle(document.documentElement)
    for (const t of ['--color-bg', '--color-surface', '--color-text', '--color-accent', '--space-4', '--radius-md', '--text-md'])
      expect(root.getPropertyValue(t).trim(), `${where}: token ${t}`).not.toBe('')
    expect(document.documentElement.dataset.theme).toBe(theme)

    // contrast on the game page, the tutorial dialog and the leaderboard tab
    expect(expectReadable(document.body, `${where} trang chơi`)).toBeGreaterThan(10)
    fireEvent.click(screen.getByRole('button', { name: '?' }))
    const dialog = await screen.findByRole('dialog', { name: 'Hướng dẫn' })
    await settled()
    expectReadable(dialog, `${where} hướng dẫn`)
    fireEvent.click(screen.getByRole('button', { name: 'Đóng' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Bảng xếp hạng' }))
    await screen.findAllByText(/Lẩu Thủ/)
    await settled()
    expect(expectReadable(document.body, `${where} bảng xếp hạng`)).toBeGreaterThan(3)

    // no horizontal scroll (AC-GAME-27 at 360 px; no viewport may scroll sideways)
    expect(document.documentElement.scrollWidth, `${where}: cuộn ngang`).toBeLessThanOrEqual(document.documentElement.clientWidth)
  })

  it(`AC-GAME-27: trang chính sách - Helvetica, tương phản, không cuộn ngang ở 360 px (${theme})`, async () => {
    await page.viewport(360, 640)
    localStorage.setItem('laumeme:theme', theme)
    document.documentElement.dataset.theme = theme
    render(<PolicyPage />)
    await document.fonts.ready
    await settled()
    expectHelvetica(document.body, `${theme} chính sách`)
    expectNoFontFilesNorOutsideRequests(`${theme} chính sách`)
    expect(expectReadable(document.body, `${theme} chính sách`)).toBeGreaterThan(5)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth)
  })
})

it('AC-GAME-27: light and dark token sets differ; no colour literal in CSS outside tokens.css', () => {
  const pick = (theme: 'light' | 'dark') => {
    document.documentElement.dataset.theme = theme
    const cs = getComputedStyle(document.documentElement)
    return ['--color-bg', '--color-surface', '--color-text', '--color-accent'].map((t) => cs.getPropertyValue(t).trim())
  }
  const light = pick('light')
  const dark = pick('dark')
  light.forEach((v, i) => expect(v, `token ${i}`).not.toBe(dark[i]))
  delete document.documentElement.dataset.theme
  const literals = indexCss.match(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/gi) ?? []
  expect(literals, 'màu viết cứng trong index.css').toEqual([])
})
