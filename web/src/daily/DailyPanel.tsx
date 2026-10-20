import { useCallback, useEffect, useRef, useState } from 'react'
import { SendError } from '../disc/api'
import type { Manifest } from '../game/engine'
import type { GraphResult } from '../graph/crypto'
import { ConsentRequiredError } from '../privacy/client'
import { ConsentPrompt } from '../privacy/ConsentPrompt'
import { storageKey } from '../storage'
import { getDailyLeaderboard, submitDailyResult, type DailyLeaderboard, type DailyResult } from './api'
import { openChallenge, type Challenge, type ChallengeState, type ElementRef } from './challenge'
import { getCountdown } from './countdown'
import { DailyCard } from './DailyCard'

type Props = {
  manifest: Manifest
  lookup: (a: string, b: string) => Promise<GraphResult | null>
  onDiscover: (el: ElementRef) => void
  storage: Storage | null
}
type Sent = { kind: 'result'; result: DailyResult } | { kind: 'consent' } | { kind: 'error'; text: string }

/** Version whose board the player opened, so a reload goes straight back to it (AC-DAILY-05). */
const OPEN_KEY = storageKey('daily-open')

function openedVersion(storage: Storage | null): number | null {
  try {
    const v = Number(storage?.getItem(OPEN_KEY))
    return Number.isInteger(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** `lookup` and `onDiscover` must stay valid for the whole batch: the page passes stable callbacks. */
function startChallenge(
  manifest: Manifest,
  storage: Storage | null,
  lookup: Props['lookup'],
  onDiscover: Props['onDiscover'],
): Challenge {
  const challenge = openChallenge({
    version: manifest.version,
    daily: manifest.daily,
    starters: manifest.starters,
    lookup,
    onDiscover,
    storage: storage ?? undefined,
  })
  try {
    storage?.setItem(OPEN_KEY, String(manifest.version))
  } catch {
    // storage blocked: the board just does not reopen by itself
  }
  return challenge
}

/** Món đặc biệt: card, countdown, challenge board, result and leaderboard (AC-DAILY-03..06, 08, 09, 12). */
export function DailyPanel({ manifest, lookup, onDiscover, storage }: Props) {
  const { version, daily } = manifest
  const policyVersion = manifest.policy_version
  // The page remounts this panel per batch (key = version): reopen the board the player had open (AC-DAILY-05).
  const [initial] = useState(() =>
    openedVersion(storage) === version ? startChallenge(manifest, storage, lookup, onDiscover) : null,
  )
  const challengeRef = useRef<Challenge | null>(initial)
  const [state, setState] = useState<ChallengeState | null>(() => initial?.getState() ?? null)
  const [picked, setPicked] = useState<ElementRef | null>(null)
  const [missed, setMissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<Sent | null>(null)
  const [board, setBoard] = useState<DailyLeaderboard | null>(null)
  const [boardError, setBoardError] = useState(false)
  const [broken, setBroken] = useState(false)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const open = () => {
    if (challengeRef.current) return
    const challenge = startChallenge(manifest, storage, lookup, onDiscover)
    challengeRef.current = challenge
    setState(challenge.getState())
  }

  // Safe to repeat: a result already stored comes back as 409 with that result (AC-DAILY-08).
  const submit = useCallback(
    (challenge: Challenge) => {
      submitDailyResult(version, challenge.submission(), { storage, policyVersion }).then(
        ({ result }) => setSent({ kind: 'result', result }),
        (err: unknown) => {
          if (err instanceof ConsentRequiredError) return setSent({ kind: 'consent' })
          const text =
            err instanceof SendError && err.status === 429
              ? 'Gửi quá nhanh, thử lại sau.'
              : 'Không gửi được kết quả, thử lại sau.'
          setSent({ kind: 'error', text })
        },
      )
    },
    [version, storage, policyVersion],
  )

  // A board restored already solved (reload after a failed or not-yet-allowed send): send it now (AC-DAILY-05/06).
  useEffect(() => {
    if (initial?.getState().solved) submit(initial)
  }, [initial, submit])

  const pick = (el: ElementRef) => {
    const challenge = challengeRef.current
    if (!challenge || busy || challenge.getState().solved) return
    if (!picked) return setPicked(el)
    setPicked(null)
    setBusy(true)
    setBroken(false)
    challenge
      .combine(picked, el)
      .then((out) => {
        setMissed(!out.ok)
        setState(challenge.getState())
        if (out.solved) submit(challenge)
      })
      .catch(() => setBroken(true)) // the step was not counted (challenge.ts)
      .finally(() => setBusy(false))
  }

  const showBoard = () => {
    setBoardError(false)
    getDailyLeaderboard(version, { storage, policyVersion }).then(setBoard, () => setBoardError(true))
  }

  return (
    <div className="daily">
      <DailyCard daily={daily} solvedName={state?.solved ? state.targetLabel : null} onStart={open} />
      <p className="daily-countdown">
        {(() => {
          const c = getCountdown(manifest.batch_at, now)
          return c.kind === 'imminent' ? c.text : `Mẻ mới sau ${c.text}`
        })()}
      </p>

      {state && (
        <section className="daily-board" aria-label="Bàn thử thách">
          <p>Bước: {state.steps}</p>
          <div className="daily-items">
            {state.board.map((el) => (
              <button
                key={el.id}
                type="button"
                aria-pressed={picked?.id === el.id}
                disabled={busy || state.solved}
                onClick={() => pick(el)}
              >
                {el.emoji} {el.name}
              </button>
            ))}
          </div>
          {missed && !state.solved && <p role="status">💨 Trượt rồi</p>}
          {broken && <p role="status">Nồi trục trặc, thử lại nhé.</p>}
          {state.solved && <p>Xong sau {state.steps} bước</p>}
          {sent?.kind === 'result' && (
            <p role="status">
              Hạng #{sent.result.rank} · Streak {sent.result.streak.current} ngày
            </p>
          )}
          {sent?.kind === 'consent' && <ConsentPrompt />}
          {sent?.kind === 'error' && <p role="status">{sent.text}</p>}
          {state.solved && sent !== null && sent.kind !== 'result' && (
            <button type="button" onClick={() => challengeRef.current && submit(challengeRef.current)}>
              Gửi lại kết quả
            </button>
          )}
        </section>
      )}

      <button type="button" onClick={showBoard}>
        Bảng xếp hạng
      </button>
      {boardError && <p role="status">Không tải được bảng xếp hạng</p>}
      {board && (
        <ol aria-label="Bảng xếp hạng">
          {board.rows.map((r) => (
            <li key={r.rank}>
              #{r.rank} {r.nickname} — {r.value} bước
            </li>
          ))}
          {/* my own rank even outside the top 20 (AC-DAILY-09) */}
          {board.me && !board.rows.some((r) => r.rank === board.me?.rank) && (
            <li>
              Bạn: #{board.me.rank} — {board.me.value} bước
            </li>
          )}
        </ol>
      )}
    </div>
  )
}
