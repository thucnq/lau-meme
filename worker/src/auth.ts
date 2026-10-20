/** Bearer token check in constant time (ADR 0005): compare SHA-256 of both values, never the raw strings. */
async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
}

export async function hasBearer(req: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false // secret not configured ⇒ fail closed
  const header = req.headers.get('Authorization') ?? ''
  const presented = /^Bearer (.+)$/.exec(header)?.[1]
  if (!presented) return false
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)])
  return crypto.subtle.timingSafeEqual(a, b)
}
