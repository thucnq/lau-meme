import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

afterEach(() => vi.unstubAllGlobals())

describe('App', () => {
  it('AC-HEALTH-02: hiện trạng thái máy chủ', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', env: 'staging', schema: '1' })))
    render(<App />)
    expect(await screen.findByText('Máy chủ: ok (staging)')).toBeInTheDocument()
  })

  it('AC-HEALTH-02: báo lỗi khi máy chủ không phản hồi', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Không kết nối được máy chủ.')
  })
})
