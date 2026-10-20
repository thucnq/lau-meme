import { HttpError } from './http'

/** Small hand-written validators: every write body is checked before it touches D1 (unknown fields rejected). */
type Obj = Record<string, unknown>

export const ID43 = /^[A-Za-z0-9_-]{43}$/

export function fail(detail: string): never {
  throw new HttpError(422, 'Dữ liệu không hợp lệ', detail)
}

export function obj(value: unknown, path: string, allowed: readonly string[], required: readonly string[] = allowed): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${path}: phải là object`)
  const o = value as Obj
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}: trường không được phép`)
  for (const k of required) if (!(k in o)) fail(`${path}.${k}: bắt buộc`)
  return o
}

export function str(value: unknown, path: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(`${path}: chuỗi ${min}–${max} ký tự`)
  return value as string
}

export function int(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`${path}: số nguyên ${min}–${max}`)
  return value as number
}

export function id43(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ID43.test(value)) fail(`${path}: id không hợp lệ`)
  return value as string
}

export function arr(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${path}: mảng ${min}–${max} phần tử`)
  return value as unknown[]
}

export function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(`${path}: phải là một trong ${options.join(', ')}`)
  return value as T
}

export function instant(value: unknown, path: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(value as string)) fail(`${path}: thời điểm ISO 8601`)
  return ms
}
