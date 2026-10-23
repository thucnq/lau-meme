// Acceptance test for docs/acceptance/metric.md AC-METRIC-01: the home page HTML carries the Cloudflare Web Analytics
// beacon (cookieless), the token comes from a build variable, and no other third-party tracking script is loaded.
// Black-box on web/index.html (the Vite entry HTML, ADR 0007 sub-path build).
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import html from '../../index.html?raw'

const BEACON_HOST = 'static.cloudflareinsights.com'

function scriptSrcs(source: string): string[] {
  return [...source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!)
}

describe('cloudflare web analytics beacon', () => {
  it('AC-METRIC-01: HTML có script beacon Cloudflare Web Analytics với data-cf-beacon', () => {
    expect(html).toContain(`${BEACON_HOST}/beacon.min.js`)
    expect(html).toMatch(/data-cf-beacon\s*=/)
  })

  it('AC-METRIC-01: token beacon lấy từ biến build (%VITE_...%), không cứng trong repo', () => {
    const attr = /data-cf-beacon\s*=\s*(?:'([^']*)'|"([^"]*)")/.exec(html)
    expect(attr).not.toBeNull()
    const value = attr![1] ?? attr![2] ?? ''
    expect(value).toMatch(/%VITE_[A-Z0-9_]+%/)
    expect(value).not.toMatch(/[0-9a-f]{32}/i) // no literal 32-hex token
  })

  it('AC-METRIC-01: không nạp script theo dõi bên thứ ba nào khác ngoài beacon Cloudflare', () => {
    const external = scriptSrcs(html).filter((src) => /^(https?:)?\/\//i.test(src))
    expect(external.filter((src) => !src.includes(BEACON_HOST))).toEqual([])
    for (const banned of ['google-analytics', 'googletagmanager', 'gtag', 'facebook.net', 'fbevents', 'hotjar', 'clarity.ms', 'segment.', 'mixpanel', 'plausible', 'umami']) {
      expect(html.toLowerCase()).not.toContain(banned)
    }
  })

  it('AC-METRIC-01: HTML không đặt cookie (không document.cookie, không meta set-cookie)', () => {
    expect(html).not.toMatch(/document\.cookie/i)
    expect(html).not.toMatch(/http-equiv\s*=\s*["']set-cookie["']/i)
  })
})
