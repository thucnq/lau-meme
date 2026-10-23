/// <reference types="vitest/config" />
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'

// The game lives under a sub-path (ADR 0007); base-path.json is the only place the prefix is written.
const { basePath } = JSON.parse(readFileSync(new URL('../base-path.json', import.meta.url), 'utf8')) as { basePath: string }
const base = `${basePath}/`
const dir = basePath.slice(1)
// always with a trailing slash: share links and og:image are appended to it
const siteUrl = (process.env.VITE_SITE_URL ?? `https://dinoduct.fun${base}`).replace(/\/?$/, '/')

/**
 * Moves every built file under `<outDir>/lau-meme/` so the Worker's static assets serve them at the URLs `base`
 * already wrote into the bundle (asset "x" is referenced as "/lau-meme/x" and now lives at "lau-meme/x").
 * Done after writing: Rolldown does not let plugins rename bundle entries.
 */
function underBasePath(): Plugin {
  return {
    name: 'lau-meme:under-base-path',
    apply: 'build',
    writeBundle(options, bundle) {
      const outDir = options.dir!
      for (const fileName of Object.keys(bundle)) {
        const to = join(outDir, dir, fileName)
        mkdirSync(dirname(to), { recursive: true })
        renameSync(join(outDir, fileName), to)
      }
      const assets = join(outDir, 'assets')
      if (existsSync(assets)) rmdirSync(assets) // now empty; throws if Vite ever writes something we did not move
    },
  }
}

/** Absolute site URL for canonical/OG tags in index.html. */
function siteUrlInHtml(): Plugin {
  return { name: 'lau-meme:site-url', transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl) }
}

/** Cloudflare Web Analytics beacon (AC-METRIC-01): without a token at build time (dev, tests) the tag is dropped. */
function analyticsBeacon(): Plugin {
  const token = process.env.VITE_CF_BEACON_TOKEN ?? ''
  return {
    name: 'lau-meme:cf-beacon',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        /^[0-9a-f]{32}$/i.test(token)
          ? html.replaceAll('%VITE_CF_BEACON_TOKEN%', token)
          : html.replace(/\s*<!-- Cloudflare Web Analytics[^>]*-->\s*<script[^>]*cloudflareinsights[^>]*><\/script>/, ''),
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), siteUrlInHtml(), analyticsBeacon(), underBasePath()],
  define: { 'import.meta.env.VITE_SITE_URL': JSON.stringify(siteUrl) },
  // Files outside the bundle would be copied to the root of outDir, outside the base path; reference assets from index.html instead.
  publicDir: false,
  // Two pages: the game, and the admin page served only on its own origin (ADR 0008; the Worker never serves it here).
  build: {
    rollupOptions: {
      input: { main: fileURLToPath(new URL('index.html', import.meta.url)), admin: fileURLToPath(new URL('admin.html', import.meta.url)) },
    },
  },
  // `npm run dev` here + `npm --prefix ../worker run dev` (port 8787): same origin for the API in dev.
  server: { port: 5173, proxy: { [`${basePath}/api`]: 'http://localhost:8787' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // jsdom is slow on WSL2; the default 5 s is too tight for the heavier engine tests.
    testTimeout: 30_000,
    // Vitest serves from "/" and sets BASE_URL to "/"; give the code under test the base the build uses.
    env: { BASE_URL: base },
    coverage: { provider: 'istanbul', include: ['src/**'], exclude: ['src/main.tsx', 'src/test/**'], thresholds: { lines: 70 } },
    // Layout checks need a real engine (jsdom computes no boxes): *.browser.test.tsx run in Chromium via Playwright, with CSS.
    projects: [
      { extends: true, test: { name: 'unit', exclude: ['**/node_modules/**', 'src/**/*.browser.test.tsx'] } },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.tsx'],
          css: true,
          browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: 'chromium' }] },
        },
      },
    ],
  },
})
