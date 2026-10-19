import { createHash, webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptEntry, elementId, fold, lookupKey } from './crypto'

const enc = new TextEncoder()
const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url')
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url')

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

// Dựng một mục graph đúng ADR 0002, độc lập với module đang kiểm thử.
async function buildEntry(version: number, x: string, y: string, plain: object) {
  const key = sha('lm1|k|' + x + '\0' + y)
  const ikm = await webcrypto.subtle.importKey('raw', enc.encode(x + '\0' + y), 'HKDF', false, ['deriveBits'])
  const okm = new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('lm1|graph|v' + version), info: enc.encode('lm1|aes-gcm') },
      ikm,
      44 * 8,
    ),
  )
  const aes = await webcrypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt'])
  const ct = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: okm.slice(32), additionalData: enc.encode(key) },
    aes,
    enc.encode(JSON.stringify(plain)),
  )
  return { key, value: b64u(new Uint8Array(ct)) }
}

const RESULT = {
  added_version: 0,
  depth: 1,
  emoji: '🔥',
  id: sha('lm1|e|toi cong chuyen'),
  image_key: null,
  name: 'Tới Công Chuyện',
}

async function makeGraph(version = 5) {
  const { key, value } = await buildEntry(version, 'cay', 'cuoi', RESULT)
  return { format: 1 as const, version, entries: { [key]: value } }
}

describe('graph crypto', () => {
  it('AC-GRAPH-01: lookupKey không phụ thuộc thứ tự và dài 43 ký tự', async () => {
    const k = await lookupKey('Cay', 'Cười')
    expect(k).toHaveLength(43)
    expect(k).toBe(await lookupKey('Cười', 'Cay'))
    expect(k).not.toBe(await lookupKey('Cay', 'Toang'))
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('AC-GRAPH-01: elementId và lookupKey khớp công thức SHA-256 của ADR 0002 (cùng giá trị với Python)', async () => {
    expect(await elementId('Cay')).toBe(sha('lm1|e|cay'))
    expect(await elementId('Cà Khịa')).toBe(await elementId('ca khia'))
    expect(await lookupKey('Cay', 'Cười')).toBe(sha('lm1|k|cay\0cuoi'))
    expect(await lookupKey('Cười', 'Cay')).toBe(sha('lm1|k|cay\0cuoi'))
  })

  it('AC-GRAPH-01: fold bỏ dấu, đ thành d, chữ thường, gộp khoảng trắng', () => {
    expect(fold('Đơn Nghỉ  Việc')).toBe('don nghi viec')
    expect(fold('  Cười ')).toBe('cuoi')
  })

  it('AC-GRAPH-02: giải mã bằng (a, b) và (b, a) ra đúng kết quả', async () => {
    const graph = await makeGraph()
    expect(await decryptEntry(graph, 'Cay', 'Cười')).toEqual(RESULT)
    expect(await decryptEntry(graph, 'Cười', 'Cay')).toEqual(RESULT)
    expect(await decryptEntry(graph, 'cay', 'CƯỜI')).toEqual(RESULT)
  })

  it('AC-GRAPH-02: sai đối tác hoặc thiếu mục thì trả null, không ném lỗi', async () => {
    const graph = await makeGraph()
    await expect(decryptEntry(graph, 'Cay', 'Toang')).resolves.toBeNull()
    await expect(decryptEntry(graph, 'Không', 'Có')).resolves.toBeNull()
    await expect(decryptEntry({ ...graph, entries: {} }, 'Cay', 'Cười')).resolves.toBeNull()
  })

  it('AC-GRAPH-02: mục bị đặt sai khóa hoặc bản mã hỏng thì trả null', async () => {
    const graph = await makeGraph()
    const [[key, value]] = Object.entries(graph.entries)
    const otherKey = sha('lm1|k|cay\0toang')
    await expect(
      decryptEntry({ ...graph, entries: { [otherKey]: value } }, 'Cay', 'Toang'),
    ).resolves.toBeNull()
    await expect(decryptEntry({ ...graph, entries: { [key]: 'AAAA' } }, 'Cay', 'Cười')).resolves.toBeNull()
    await expect(decryptEntry({ ...graph, version: 6 }, 'Cay', 'Cười')).resolves.toBeNull()
  })
})
