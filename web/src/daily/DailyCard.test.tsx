// @vitest-environment jsdom
// AC-DAILY-03 (web part): thẻ Daily hiện emoji + gợi ý, tên hiện "???".
// Expected module `./DailyCard` exporting
//   DailyCard(props: {
//     daily: { element_id: string; emoji: string; hint: string; depth: number }   // manifest.daily
//     solvedName?: string | null                                                  // tên lộ ra khi đã ghép được
//     onStart?: () => void                                                        // bấm nút "Thử thách"
//   })
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DailyCard } from './DailyCard'

const daily = { element_id: 'x'.repeat(43), emoji: '📈', hint: 'Món lên như diều gặp gió', depth: 4 }

afterEach(cleanup)

describe('DailyCard', () => {
  it('AC-DAILY-03: thẻ Daily hiện emoji và gợi ý, tên là "???", không có tên món', () => {
    const { container } = render(<DailyCard daily={daily} />)
    expect(container.textContent).toContain('📈')
    expect(screen.getByText(daily.hint)).toBeTruthy()
    expect(screen.getByText('???')).toBeTruthy()
    expect(container.textContent?.toLowerCase()).not.toContain('stonks')
  })

  it('AC-DAILY-03: bấm "Thử thách" gọi onStart; khi đã giải được thì hiện tên thay cho "???"', () => {
    const onStart = vi.fn()
    const { rerender } = render(<DailyCard daily={daily} onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: /thử thách/i }))
    expect(onStart).toHaveBeenCalledTimes(1)

    rerender(<DailyCard daily={daily} solvedName="Stonks" onStart={onStart} />)
    expect(screen.getByText('Stonks')).toBeTruthy()
    expect(screen.queryByText('???')).toBeNull()
  })
})
