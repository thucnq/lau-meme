import { problem, json } from '../../http'
import { uuidv7 } from '../../uuid'
import { ID43 } from '../../validate'
import { hashKey, isWebp, readCapped } from '../pipeline/images'
import { bad, sha256hex } from './admin'

/** AC-ART-13, ADR 0016: the admin page normalizes the drawing in the browser; the Worker only checks the result. */
const MAX_DRAWING_BYTES = 1_048_576
const SIDE = 256

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u24 = (b: Uint8Array, at: number) => u16(b, at) | (b[at + 2]! << 16)
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4))

/**
 * Width and height from the first chunk header (VP8X canvas, VP8L or lossy VP8 frame), or null when unreadable.
 * The RIFF size must match the body (no truncated or padded files) and VP8X must not be animated: the key is
 * content-addressed, so a bad file stored once could not be fixed later.
 */
export function webpSize(b: Uint8Array): { w: number; h: number } | null {
  if (!isWebp(b) || b.length < 30 || u32(b, 4) + 8 !== b.length) return null
  switch (fourcc(b, 12)) {
    case 'VP8X':
      if (b[20]! & 0x02) return null
      return { w: u24(b, 24) + 1, h: u24(b, 27) + 1 }
    case 'VP8L': {
      if (b[20] !== 0x2f) return null
      const bits = (u16(b, 21) | (u16(b, 23) << 16)) >>> 0
      return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
    }
    case 'VP8 ':
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
      return { w: u16(b, 26) & 0x3fff, h: u16(b, 28) & 0x3fff }
    default:
      return null
  }
}

/**
 * PUT /api/admin/elements/{id}/image - every 4xx happens before R2 or D1 is written, so it leaves no audit
 * (AC-ADMIN-09). R2 is content-addressed like the pipeline's images (ADR 0012); the element, its source and the
 * single admin_image_change row go in one batch. Batches never overwrite an 'admin' image (publishBatch).
 */
export async function setElementImage(req: Request, env: Env, _ctx: ExecutionContext, params: string[]): Promise<Response> {
  const id = params[0] ?? ''
  if (!ID43.test(id)) bad('id: id phần tử không hợp lệ')
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'image/webp') bad('Thân phải là image/webp')
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DRAWING_BYTES) bad('Ảnh quá lớn (tối đa 1 MB)')
  const bytes = await readCapped(req, MAX_DRAWING_BYTES)
  if (bytes === null) bad('Ảnh quá lớn (tối đa 1 MB)')
  const size = webpSize(bytes!)
  if (!size) bad('Thân không phải ảnh WebP')
  if (size!.w !== SIDE || size!.h !== SIDE) bad(`Ảnh phải là WebP ${SIDE}x${SIDE}`)

  const db = env.DB
  const exists = await db.prepare('SELECT 1 FROM element WHERE id = ?').bind(id).first()
  if (!exists) return problem(404, 'Không tìm thấy phần tử')

  // Written before D1: if the batch fails the object stays orphaned, which is harmless (same bytes, same key).
  const key = await hashKey(bytes!)
  const r2Key = `img/${key}`
  if ((await env.IMG.head(r2Key)) === null) {
    await env.IMG.put(r2Key, bytes!, { httpMetadata: { contentType: 'image/webp' } })
  }
  const now = Date.now()
  const fp = (await sha256hex(env.ADMIN_TOKEN ?? '')).slice(0, 8)
  // before_key is read inside the batch, ahead of the UPDATE, so concurrent uploads each audit the key they replaced.
  const [audit] = await db.batch<{ before_key: string | null }>([
    db
      .prepare(
        'INSERT INTO admin_image_change (id, element_id, before_key, after_key, token_fp, created_at) ' +
          'SELECT ?, id, image_key, ?, ?, ? FROM element WHERE id = ? RETURNING before_key',
      )
      .bind(uuidv7(now), key, fp, now, id),
    db.prepare("UPDATE element SET image_key = ?, image_source = 'admin', updated_at = ? WHERE id = ?").bind(key, now, id),
  ])
  const row = audit?.results[0]
  if (!row) return problem(404, 'Không tìm thấy phần tử')
  return json({ element_id: id, before_key: row.before_key, after_key: key })
}
