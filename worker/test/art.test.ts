// Acceptance tests for docs/acceptance/art.md, Worker side: AC-ART-05 (GET /img/{key}, operationId getImage).
//
// Interface assumptions: R2 binding `IMG` (bucket lau-meme-img), object key `img/<12 hex>.webp`,
// route `/lau-meme/img/<12 hex>.webp`, Cache API (`caches.default`) keyed by the request URL.
import { SELF, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Bucket = {
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown>
  get(key: string): Promise<unknown>
  delete(key: string): Promise<void>
}
const IMG = (env as unknown as { IMG: Bucket }).IMG

const BASE = 'https://example.com/lau-meme'
const IMAGE_NAME = 'abc123def456.webp'
const URL_OF = (key: string) => `${BASE}/img/${key}`
// A tiny WebP-looking payload; the Worker serves bytes as stored, it does not decode them.
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

const edgeCache = () => (caches as unknown as { default: Cache }).default

describe('art: GET /img/{key}', () => {
  // caches.default is not reset between tests: clear every key these tests use.
  beforeEach(async () => {
    for (const k of [IMAGE_NAME, '0123456789ab.webp', 'ABC123DEF456.webp']) await edgeCache().delete(URL_OF(k))
  })

  it('AC-ART-05: ảnh tồn tại trả 200 image/webp, đúng byte, Cache-Control public immutable một năm', async () => {
    await IMG.put(`img/${IMAGE_NAME}`, WEBP)
    const res = await SELF.fetch(URL_OF(IMAGE_NAME))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP)
  })

  it('AC-ART-05: lần đầu ảnh được đưa vào Cache API; lần sau vẫn 200 dù R2 đã mất đối tượng', async () => {
    await IMG.put(`img/${IMAGE_NAME}`, WEBP)
    expect(await edgeCache().match(URL_OF(IMAGE_NAME))).toBeUndefined()

    const first = await SELF.fetch(URL_OF(IMAGE_NAME))
    expect(first.status).toBe(200)
    await first.arrayBuffer()

    await vi.waitFor(async () => {
      const cached = await edgeCache().match(URL_OF(IMAGE_NAME))
      expect(cached).toBeDefined()
      expect(cached!.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    })

    await IMG.delete(`img/${IMAGE_NAME}`)
    const again = await SELF.fetch(URL_OF(IMAGE_NAME))
    expect(again.status).toBe(200)
    expect(again.headers.get('content-type')).toBe('image/webp')
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(WEBP)
  })

  it('AC-ART-05: khóa đúng định dạng nhưng không tồn tại trả 404 problem+json, không được cache', async () => {
    const missing = '0123456789ab.webp'
    const res = await SELF.fetch(URL_OF(missing))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(await res.json()).toMatchObject({ status: 404 })
    expect(res.headers.get('cache-control') ?? '').not.toContain('immutable')
    expect(await edgeCache().match(URL_OF(missing))).toBeUndefined()
  })

  it('AC-ART-05: khóa sai định dạng (không khớp ^[0-9a-f]{12}\\.webp$) trả 400 problem+json', async () => {
    const bad = [
      'ABC123DEF456.webp', // chữ hoa
      'abc123def45.webp', // 11 ký tự
      'abc123def4567.webp', // 13 ký tự
      'abc123def456.png', // sai đuôi
      'abc123def456', // thiếu đuôi
      'abc123def456.webp.exe',
      'zzzzzzzzzzzz.webp', // không phải hex
      '..%2F..%2Fsecret.webp', // đi ngược thư mục
      '%3Cscript%3E.webp', // thẻ script
    ]
    for (const key of bad) {
      const res = await SELF.fetch(URL_OF(key))
      expect(res.status, key).toBe(400)
      expect(res.headers.get('content-type'), key).toContain('application/problem+json')
      expect(await res.json(), key).toMatchObject({ status: 400 })
    }
  })

  it('AC-ART-05: khóa sai định dạng không chạm tới R2 và không vào cache (đối tượng cùng tên khác định dạng không lộ ra)', async () => {
    await IMG.put('img/ABC123DEF456.webp', WEBP)
    const res = await SELF.fetch(URL_OF('ABC123DEF456.webp'))
    expect(res.status).toBe(400)
    expect(await edgeCache().match(URL_OF('ABC123DEF456.webp'))).toBeUndefined()
  })
})
