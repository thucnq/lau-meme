import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('health', () => {
  it('AC-HEALTH-01: GET /api/health trả trạng thái và phiên bản schema', async () => {
    const res = await SELF.fetch('https://example.com/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', schema: '1' })
  })

  it('AC-HEALTH-01: đường API không tồn tại trả problem+json 404', async () => {
    const res = await SELF.fetch('https://example.com/api/khong-co')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
  })
})
