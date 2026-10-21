import { useEffect, useState } from 'react'
import { useSession } from '../auth/session'
import { SendError } from '../disc/api'
import type { Manifest } from '../game/engine'
import { ConsentRequiredError } from '../privacy/client'
import { ConsentPrompt } from '../privacy/ConsentPrompt'
import {
  getDailyLeaderboard,
  getPeriodLeaderboard,
  submitDailyResult,
  type DailyLeaderboard,
  type DailyResult,
  type PeriodLeaderboard,
} from './api'
import { getCountdown } from './countdown'
import { DailyCard } from './DailyCard'
import { currentPeriods, formatSolveTime } from './period'
import type { SolvedDaily } from './solved'

type Props = { manifest: Manifest; storage: Storage | null; solved: SolvedDaily | null }
type Sent = { kind: 'result'; result: DailyResult } | { kind: 'consent' } | { kind: 'error'; text: string }
type Tab = 'batch' | 'week' | 'month'
type Board = { tab: 'batch'; data: DailyLeaderboard } | { tab: 'week' | 'month'; data: PeriodLeaderboard }

const INVITE = 'Đăng nhập bằng Google để lên bảng xếp hạng'
const BOARD_INVITE = 'Đăng nhập bằng Google để có tên trên bảng xếp hạng'
const TABS: Array<[Tab, string]> = [
  ['batch', 'Mẻ này'],
  ['week', 'Tuần'],
  ['month', 'Tháng'],
]

/**
 * Món đặc biệt (AC-DAILY-03..06, 08, 09, 12..15): card, countdown, the result of a signed-in account and the
 * leaderboards. Solving happens on the normal board (Game passes `solved`); the result goes out by itself once the
 * player is signed in - right away, or as soon as they sign in. The page remounts this panel per batch.
 */
export function DailyPanel({ manifest, storage, solved }: Props) {
  const { version, daily } = manifest
  const policyVersion = manifest.policy_version
  const session = useSession()
  const [sent, setSent] = useState<Sent | null>(null)
  const [tab, setTab] = useState<Tab | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [boardError, setBoardError] = useState(false)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Safe to repeat: a result already stored comes back as 409 with that result (AC-DAILY-08).
  const signedIn = session !== null
  useEffect(() => {
    if (!solved || !signedIn) return
    let live = true
    submitDailyResult(version, { a: solved.a, b: solved.b }, { storage, policyVersion }).then(
      ({ result }) => live && setSent({ kind: 'result', result }),
      (err: unknown) => {
        if (!live) return
        if (err instanceof ConsentRequiredError) return setSent({ kind: 'consent' })
        const text =
          err instanceof SendError && err.status === 429
            ? 'Gửi quá nhanh, thử lại sau.'
            : 'Không gửi được kết quả, thử lại sau.'
        setSent({ kind: 'error', text })
      },
    )
    return () => {
      live = false
    }
  }, [solved, signedIn, version, storage, policyVersion])

  // The open tab reloads when it changes and after a sign-in/out (the own row comes with the cookie).
  useEffect(() => {
    if (tab === null) return
    let live = true
    const periods = currentPeriods(new Date())
    const load: Promise<Board> =
      tab === 'batch'
        ? getDailyLeaderboard(version).then((data) => ({ tab, data }))
        : getPeriodLeaderboard(periods[tab]).then((data) => ({ tab, data }))
    load.then(
      (b) => {
        if (!live) return
        setBoard(b)
        setBoardError(false)
      },
      () => live && setBoardError(true),
    )
    return () => {
      live = false
    }
  }, [tab, version, signedIn])

  const countdown = getCountdown(manifest.batch_at, now)
  return (
    <div className="daily">
      <DailyCard daily={daily} solvedName={solved?.name ?? null} />
      <p className="daily-countdown">{countdown.kind === 'imminent' ? countdown.text : `Mẻ mới sau ${countdown.text}`}</p>

      {solved && !signedIn && <p className="daily-invite">{INVITE}</p>}
      {solved && signedIn && sent?.kind === 'result' && (
        <p role="status">
          Hạng #{sent.result.rank} · Streak {sent.result.streak.current}
        </p>
      )}
      {solved && signedIn && sent?.kind === 'consent' && <ConsentPrompt />}
      {solved && signedIn && sent?.kind === 'error' && <p role="status">{sent.text}</p>}

      <button type="button" onClick={() => setTab((t) => t ?? 'batch')} aria-expanded={tab !== null}>
        Bảng xếp hạng
      </button>
      {tab !== null && (
        <section className="daily-boards" aria-label="Bảng xếp hạng">
          <div role="tablist">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => {
                  setBoard(null)
                  setTab(key)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {!signedIn && <p>{BOARD_INVITE}</p>}
          {boardError && <p role="status">Không tải được bảng xếp hạng</p>}
          {board?.tab === tab && <BoardList board={board} />}
        </section>
      )}
    </div>
  )
}

function BoardList({ board }: { board: Board }) {
  if (board.tab === 'batch') {
    const { rows, me } = board.data
    if (rows.length === 0 && !me) return <p>Chưa có ai giải món này</p>
    return (
      <ol role="tabpanel">
        {rows.map((r) => (
          <li key={r.rank}>{`#${r.rank} ${r.nickname} - ${formatSolveTime(r.value)}`}</li>
        ))}
        {/* my own rank even outside the top 20 (AC-DAILY-09) */}
        {me && !rows.some((r) => r.rank === me.rank) && (
          <li>{`Bạn: #${me.rank} ${me.nickname} - ${formatSolveTime(me.value)}`}</li>
        )}
      </ol>
    )
  }
  const { rows, me, batches } = board.data
  if (rows.length === 0 && !me) return <p>Chưa có ai giải món nào trong kỳ</p>
  const line = (r: { rank: number; nickname: string; solved: number; total_ms: number }) =>
    `#${r.rank} ${r.nickname} - ${r.solved}/${batches} mẻ - ${formatSolveTime(r.total_ms)}`
  return (
    <ol role="tabpanel">
      {rows.map((r) => (
        <li key={r.rank}>{line(r)}</li>
      ))}
      {me && !rows.some((r) => r.rank === me.rank) && <li>{`Bạn: ${line(me)}`}</li>}
    </ol>
  )
}
