/** RFC 9457 problem details - every API error has the same shape (same rule as the Java golden path). */
export function problem(
  status: number,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { type: 'about:blank', title, status, ...(detail ? { detail } : {}), ...extra },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  )
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { 'cache-control': 'no-store', ...(init.headers ?? {}) } })
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(title)
  }
}

/** A ready response thrown from deep inside a handler (e.g. a 429 with Retry-After). */
export class ResponseError extends Error {
  constructor(readonly response: Response) {
    super(`HTTP ${response.status}`)
  }
}

const MAX_BODY_BYTES = 5 * 1024 * 1024

/** Parse a JSON object body; anything else is a 400 (413 when too large). */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Nội dung quá lớn')
  if (text.trim() === '') return {}
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'JSON không hợp lệ')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new HttpError(400, 'Thân yêu cầu phải là object JSON')
  return data as Record<string, unknown>
}
