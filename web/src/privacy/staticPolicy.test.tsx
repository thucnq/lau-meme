// @vitest-environment jsdom
/**
 * Acceptance test cho docs/acceptance/subpath.md, phần web: AC-SUBPATH-14.
 * web/chinh-sach-tinh.html là bản HTML tĩnh của PolicyPage cho bot không chạy JS: chữ phải giống hệt.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PolicyPage } from './PolicyPage'

const pages = import.meta.glob('../../chinh-sach-tinh.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const words = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

describe('trang chính sách tĩnh', () => {
  it('AC-SUBPATH-14: web/chinh-sach-tinh.html có cùng chữ với PolicyPage, không script, không canonical hay og:url', () => {
    const html = Object.values(pages)[0]
    expect(html, 'thiếu web/chinh-sach-tinh.html').toBeTypeOf('string')
    const doc = new DOMParser().parseFromString(html!, 'text/html')
    expect(doc.documentElement.lang).toBe('vi')
    expect(doc.querySelector('script')).toBeNull()
    expect(doc.querySelector('link[rel="canonical"], meta[property="og:url"], #root')).toBeNull()

    const { container } = render(<PolicyPage />)
    expect(words(doc.querySelector('main'))).toBe(words(container.querySelector('main')))
  })
})
