import { useState } from 'react'
import type { MetricEvent } from '../metrics/metrics'
import { submitVote, type VoteValue } from './api'

type Props = {
  a: string
  b: string
  policyVersion: number
  storage: Storage | null
  metrics: { track(event: MetricEvent): void }
}

const BUTTONS: Array<{ value: VoteValue; label: string }> = [
  { value: 'ngon', label: 'Ngon' },
  { value: 'nhat', label: 'Nhạt' },
]

/**
 * "Ngon" / "Nhạt" on the recipe just combined (AC-FEEDBACK-01): the button is marked only once the vote is stored,
 * and only then a `feedback` event goes to the metrics queue (open question 63).
 */
export function FeedbackButtons({ a, b, policyVersion, storage, metrics }: Props) {
  const [chosen, setChosen] = useState<VoteValue | null>(null)

  const vote = (value: VoteValue) => {
    submitVote({ a, b, value }, { storage, policyVersion }).then(
      () => {
        setChosen(value)
        metrics.track({ type: 'feedback', value })
      },
      () => {}, // refused or no consent: nothing is marked, nothing is tracked
    )
  }

  return (
    <div className="feedback" role="group" aria-label="Món này thế nào?">
      {BUTTONS.map((btn) => (
        <button key={btn.value} type="button" aria-pressed={chosen === btn.value} onClick={() => vote(btn.value)}>
          {btn.label}
        </button>
      ))}
    </div>
  )
}
