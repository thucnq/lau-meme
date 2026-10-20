// @vitest-environment node
/// <reference types="node" />
// AC-ADMIN-10 (web/admin.html): node environment so import.meta.url is a file: URL (same pattern as subpath.test.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url))

describe('admin html', () => {
  it('AC-ADMIN-10: web/admin.html có thẻ meta robots "noindex, nofollow"', () => {
    const html = readFileSync(join(WEB_ROOT, 'admin.html'), 'utf8')
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
  })
})
