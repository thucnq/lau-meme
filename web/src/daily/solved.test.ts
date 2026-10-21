// @vitest-environment jsdom
/**
 * AC-DAILY-05: the "solved" state of the current batch survives a reload and is dropped for another batch.
 *
 * Expected module `./solved`:
 *   type SolvedDaily = { a: string; b: string; name: string }
 *   loadSolved(storage: Storage, version: number): SolvedDaily | null
 *   saveSolved(storage: Storage, version: number, s: SolvedDaily): void
 * One key 'laumeme:daily-solved' holding { version, a, b, name }.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { loadSolved, saveSolved } from './solved'

const KEY = 'laumeme:daily-solved'
const SOLVED = { a: 'Hết Cứu', b: 'Cay', name: 'Stonks' }

beforeEach(() => {
  localStorage.clear()
})

describe('solved', () => {
  it('AC-DAILY-05: chưa giải thì đọc ra null', () => {
    expect(loadSolved(localStorage, 7)).toBeNull()
  })

  it('AC-DAILY-05: lưu vào đúng một khóa laumeme:daily-solved dạng { version, a, b, name } và đọc lại được trong cùng mẻ', () => {
    saveSolved(localStorage, 7, SOLVED)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ version: 7, ...SOLVED })
    expect(loadSolved(localStorage, 7)).toEqual(SOLVED)
    expect(localStorage.length).toBe(1)
  })

  it('AC-DAILY-05: sang mẻ khác thì trạng thái của mẻ cũ đọc ra null; lưu mẻ mới ghi đè khóa cũ', () => {
    saveSolved(localStorage, 7, SOLVED)
    expect(loadSolved(localStorage, 8)).toBeNull()
    expect(loadSolved(localStorage, 6)).toBeNull()

    saveSolved(localStorage, 8, { a: 'Cay', b: 'Cười', name: 'Món Khác' })
    expect(loadSolved(localStorage, 7)).toBeNull()
    expect(loadSolved(localStorage, 8)).toEqual({ a: 'Cay', b: 'Cười', name: 'Món Khác' })
    expect(localStorage.length).toBe(1)
  })

  it('AC-DAILY-05: dữ liệu hỏng hoặc thiếu trường đọc ra null, không ném lỗi', () => {
    for (const bad of ['{not json', '[]', 'null', '"x"', JSON.stringify({ version: 7 }), JSON.stringify({ version: 7, a: 'x', b: 'y' })]) {
      localStorage.setItem(KEY, bad)
      expect(loadSolved(localStorage, 7), bad).toBeNull()
    }
  })
})
