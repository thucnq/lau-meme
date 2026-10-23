// The event queue is capped so one long session cannot flush an unbounded number of batches (review follow-up).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMetrics } from './metrics'

const PLAYER = '3f0a7f0e-2f52-4c7a-9f5f-0c2b1a1d9e11'

type Body = { player_id: string; events: Array<{ type: string; target?: string }> }

let beacon: ReturnType<typeof vi.fn>

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  beacon = vi.fn(() => true)
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: beacon })
})

afterEach(() => {
  setVisibility('visible')
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: undefined })
})

describe('metrics queue cap', () => {
  it('keeps at most 200 queued events and drops the oldest first', () => {
    const m = createMetrics({ getPlayerId: () => PLAYER })
    m.start()
    m.track({ type: 'report', target: 'image' })
    for (let i = 0; i < 250; i++) m.track({ type: 'report', target: 'element' })
    setVisibility('hidden')
    const events = beacon.mock.calls.flatMap(([, body]) => (JSON.parse(body as string) as Body).events)
    expect(beacon).toHaveBeenCalledTimes(4)
    expect(events).toHaveLength(200)
    expect(events.every((e) => e.target === 'element')).toBe(true)
    m.stop()
  })
})
