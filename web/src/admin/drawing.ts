/**
 * Tranh vẽ tay (AC-ART-13, ADR 0016): the Worker cannot convert images, so the page turns the admin's PNG/WebP into
 * the same 256×256 WebP the pipeline draws - cut to a centred square, then scaled.
 */
export const MAX_DRAWING_BYTES = 1_048_576
export const DRAWING_TYPES = ['image/png', 'image/webp'] as const
const SIDE = 256

/** Vietnamese reason the file is refused before any request, or null when it may be sent. */
export function drawingProblem(file: File): string | null {
  if (!(DRAWING_TYPES as readonly string[]).includes(file.type)) return 'Ảnh phải là PNG hoặc WebP, tối đa 1 MB.'
  if (file.size > MAX_DRAWING_BYTES) return 'Ảnh quá lớn: tối đa 1 MB (PNG hoặc WebP).'
  return null
}

export class DrawingError extends Error {}

export async function toWebp256(file: File): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new DrawingError('Không đọc được ảnh này.')
  }
  const canvas = document.createElement('canvas')
  canvas.width = SIDE
  canvas.height = SIDE
  const g = canvas.getContext('2d')
  if (!g) throw new DrawingError('Trình duyệt không vẽ được ảnh.')
  const side = Math.min(bitmap.width, bitmap.height)
  g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIDE, SIDE)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9))
  // a browser without a WebP encoder silently gives PNG
  if (!blob || blob.type !== 'image/webp') throw new DrawingError('Trình duyệt này không xuất được WebP, hãy dùng Chrome hoặc Firefox.')
  return blob
}
