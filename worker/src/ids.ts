/**
 * Element ids and recipe lookup keys (ADR 0002) — the server-side twin of web/src/graph/crypto.ts.
 * Must stay byte-compatible with pipeline/src/lau_meme_pipeline/{text,ids}.py.
 */
const enc = new TextEncoder()

/** Same as Python `text.fold`: đ→d, strip combining marks, lowercase, collapse whitespace. */
export function fold(text: string): string {
  return text
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

function b64u(bytes: ArrayBuffer): string {
  let bin = ''
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256b64u(text: string): Promise<string> {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

/** Sort two folded names by UTF-8 bytes (what Python's `sorted(key=encode)` does). */
function sortedPair(a: string, b: string): [string, string] {
  const [ea, eb] = [enc.encode(a), enc.encode(b)]
  for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
    if (ea[i] !== eb[i]) return (ea[i] ?? 0) < (eb[i] ?? 0) ? [a, b] : [b, a]
  }
  return ea.length <= eb.length ? [a, b] : [b, a]
}

export function elementId(name: string): Promise<string> {
  return sha256b64u('lm1|e|' + fold(name))
}

export function recipeId(a: string, b: string): Promise<string> {
  const [x, y] = sortedPair(fold(a), fold(b))
  return sha256b64u('lm1|k|' + x + '\0' + y)
}
