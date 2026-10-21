import { problem } from '../../http'

/** ADR 0012: the pipeline uploads a moderated illustration; the Worker checks it before R2 ever sees it. */
const IMAGE_KEY = /^[0-9a-f]{12}\.webp$/
const MAX_IMAGE_BYTES = 524_288

function isWebp(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
}

async function hashKey(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('') + '.webp'
}

/**
 * PUT /api/pipeline/images/{key} - AC-ART-04: `key` must be the content hash and the body a WebP, so a leaked
 * pipeline token can neither overwrite an image nor store anything else. Content-addressed: an existing object is
 * left as is (204 either way).
 */
export async function putPipelineImage(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const key = params[0] ?? ''
  if (!IMAGE_KEY.test(key)) return problem(400, 'Khóa ảnh không hợp lệ')
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'image/webp') return problem(415, 'Thân phải là image/webp')
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_IMAGE_BYTES) return problem(413, 'Ảnh quá lớn (tối đa 512 KB)')
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.length > MAX_IMAGE_BYTES) return problem(413, 'Ảnh quá lớn (tối đa 512 KB)')
  if (!isWebp(bytes)) return problem(422, 'Thân không phải ảnh WebP')
  if ((await hashKey(bytes)) !== key) return problem(422, 'Khóa không khớp SHA-256 của ảnh')
  const r2Key = `img/${key}`
  if ((await env.IMG.head(r2Key)) === null) {
    await env.IMG.put(r2Key, bytes, { httpMetadata: { contentType: 'image/webp' } })
  }
  return new Response(null, { status: 204 })
}
