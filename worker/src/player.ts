import { HttpError } from './http'

/** Anonymous player (ADR 0004): `X-Player-Id` = browser UUID v4. Not authentication - only an owner key. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Player id when the header is present, null when absent; a malformed id is a 400. */
export function optionalPlayerId(req: Request): string | null {
  const raw = req.headers.get('X-Player-Id')
  if (raw === null) return null
  if (!UUID_V4.test(raw)) throw new HttpError(400, 'X-Player-Id không hợp lệ', 'Cần UUID v4.')
  return raw.toLowerCase()
}

export function playerId(req: Request): string {
  const id = optionalPlayerId(req)
  if (id === null) throw new HttpError(400, 'Thiếu X-Player-Id', 'Cần UUID v4.')
  return id
}

export const ANONYMOUS = 'Thực khách ẩn danh'
