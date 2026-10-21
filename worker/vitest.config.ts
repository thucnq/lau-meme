import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Tests run inside workerd (Miniflare) with a local D1 built from migrations/. No network, no real account.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // Miniflare D1 costs ~66 ms per query on WSL2, so heavy tests outrun the default 5 s.
      testTimeout: 30_000,
      coverage: { provider: 'istanbul' as const, include: ['src/**'], thresholds: { lines: 80 } },
    },
  }
})
