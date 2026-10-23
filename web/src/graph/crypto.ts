/**
 * Graph lookup and decryption in the browser (ADR 0002) - WebCrypto only, no network.
 * Must stay byte-compatible with pipeline/src/lau_meme_pipeline/{text,ids,graph}.py.
 */

export type GraphResult = {
  id: string
  name: string
  emoji: string
  depth: number
  added_version: number
  image_key: string | null
  /** 1-5, set by the admin (TIER); graphs published before TIER have none - shown as 1 (AC-TIER-03) */
  tier?: number
}

export type Graph = { format: 1; version: number; entries: Record<string, string> }

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

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64u(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
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

export function lookupKey(a: string, b: string): Promise<string> {
  const [x, y] = sortedPair(fold(a), fold(b))
  return sha256b64u('lm1|k|' + x + '\0' + y)
}

/** Plaintext of the entry for (a, b), or null when there is none or the names do not open it. Never throws. */
export async function decryptEntry(graph: Graph, a: string, b: string): Promise<GraphResult | null> {
  try {
    const key = await lookupKey(a, b)
    const value = graph.entries[key]
    if (typeof value !== 'string') return null
    const [x, y] = sortedPair(fold(a), fold(b))
    const ikm = await crypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
    const okm = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + graph.version), info: enc.encode('lm1|aes-gcm') },
        ikm,
        44 * 8,
      ),
    )
    const aes = await crypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['decrypt'])
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) },
      aes,
      unb64u(value),
    )
    return JSON.parse(new TextDecoder().decode(plain)) as GraphResult
  } catch {
    return null
  }
}
