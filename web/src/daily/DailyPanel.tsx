import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../auth/session'
import { SITE_URL } from '../base'
import { SendError } from '../disc/api'
import type { Manifest } from '../game/engine'
import { trackDailyStart } from '../metrics/app'
import { ConsentRequiredError } from '../privacy/client'
import { ConsentPrompt } from '../privacy/ConsentPrompt'
import { ShareCard, type DailyCardData } from '../share'
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

type Props = { manifest: Manifest; storage: Storage | null; solved: SolvedDaily | null; onShowBoard?: () => void }
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
const MEDALS = ['🥇', '🥈', '🥉']
const GMT7_MS = 7 * 3_600_000

/**
 * The Daily share card (AC-SHARE-01): batch day and hour in GMT+7, the server's solve time and rank. Only shown with
 * a server result: only signed-in solves are recorded, so an unsigned player gets no card (open question 58).
 */
function dailyCard(batchAt: string, emoji: string, result: DailyResult): DailyCardData {
  const local = new Date(Date.parse(batchAt) + GMT7_MS)
  return {
    day: local.toISOString().slice(0, 10),
    batchHour: local.getUTCHours(),
    emoji,
    solveSeconds: Math.floor(result.solve_ms / 1000),
    rank: result.rank,
    link: SITE_URL,
  }
}

/**
 * Món đặc biệt (AC-DAILY-03..06, 08, 12, 13, 16): the challenge card with its countdown and the result of a
 * signed-in account. Solving happens on the normal board (Game passes `solved`); the result goes out by itself once
 * the player is signed in - right away, or as soon as they sign in. The page remounts this panel per batch. The
 * leaderboards have their own screen (`Leaderboards`, AC-DAILY-17).
 */
export function DailyPanel({ manifest, storage, solved, onShowBoard }: Props) {
  const { version, daily } = manifest
  const policyVersion = manifest.policy_version
  const session = useSession()
  const [sent, setSent] = useState<Sent | null>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => trackDailyStart(version), [version])

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

  const result = sent?.kind === 'result' ? sent.result : null
  const card = useMemo(
    () => (result ? dailyCard(manifest.batch_at, daily.emoji, result) : null),
    [result, manifest.batch_at, daily.emoji],
  )

  const countdown = getCountdown(manifest.batch_at, now, manifest.schedule_hours_utc)
  return (
    <DailyCard daily={daily} solvedName={solved?.name ?? null}>
      <p className="daily-countdown">{countdown.kind === 'imminent' ? countdown.text : `Mẻ mới sau ${countdown.text}`}</p>
      {solved && !signedIn && <p className="daily-invite">{INVITE}</p>}
      {solved && signedIn && sent?.kind === 'result' && (
        <p role="status">
          Hạng #{sent.result.rank} · Streak {sent.result.streak.current}
        </p>
      )}
      {solved && signedIn && card && <ShareCard card="daily" data={card} player={{ storage, policyVersion }} />}
      {solved && signedIn && sent?.kind === 'consent' && <ConsentPrompt />}
      {solved && signedIn && sent?.kind === 'error' && <p role="status">{sent.text}</p>}
      {onShowBoard && (
        <button type="button" className="daily-board-link" onClick={onShowBoard}>
          Xem bảng xếp hạng
        </button>
      )}
    </DailyCard>
  )
}

/**
 * The "Bảng xếp hạng" screen (AC-DAILY-09, 14, 15, 17): batch, week and month boards, medals for the first three,
 * the viewer's own row marked with `aria-current` (found by `me.rank`).
 */
export function Leaderboards({ version }: { version: number }) {
  const signedIn = useSession() !== null
  const [tab, setTab] = useState<Tab>('batch')
  const [board, setBoard] = useState<Board | null>(null)
  const [boardError, setBoardError] = useState(false)

  // The open tab reloads when it changes and after a sign-in/out (the own row comes with the cookie).
  useEffect(() => {
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

  return (
    <section className="daily-boards" aria-label="Bảng xếp hạng">
      <div role="tablist" aria-label="Kỳ xếp hạng">
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
      {!signedIn && <p className="daily-board-invite">{BOARD_INVITE}</p>}
      {boardError && <p role="status">Không tải được bảng xếp hạng</p>}
      {board?.tab === tab && <BoardList board={board} />}
    </section>
  )
}

function Row({ rank, mine, text }: { rank: number; mine: boolean; text: string }) {
  const medal = MEDALS[rank - 1]
  return (
    <li className={rank <= 3 ? 'top' : undefined} aria-current={mine ? 'true' : undefined}>
      <span>
        {medal && <span className="medal">{medal} </span>}
        {text}
      </span>
    </li>
  )
}

function BoardList({ board }: { board: Board }) {
  if (board.tab === 'batch') {
    const { rows, me } = board.data
    if (rows.length === 0 && !me) return <p>Chưa có ai giải món này</p>
    return (
      <ol role="tabpanel" className="board-rows">
        {rows.map((r) => (
          <Row
            key={r.rank}
            rank={r.rank}
            mine={me?.rank === r.rank}
            text={`#${r.rank} ${r.nickname} - ${formatSolveTime(r.value)}`}
          />
        ))}
        {/* my own rank even outside the top 20 (AC-DAILY-09) */}
        {me && !rows.some((r) => r.rank === me.rank) && (
          <Row rank={me.rank} mine text={`Bạn: #${me.rank} ${me.nickname} - ${formatSolveTime(me.value)}`} />
        )}
      </ol>
    )
  }
  const { rows, me, batches } = board.data
  if (rows.length === 0 && !me) return <p>Chưa có ai giải món nào trong kỳ</p>
  const line = (r: { rank: number; nickname: string; solved: number; total_ms: number }) =>
    `#${r.rank} ${r.nickname} - ${r.solved}/${batches} mẻ - ${formatSolveTime(r.total_ms)}`
  return (
    <ol role="tabpanel" className="board-rows">
      {rows.map((r) => (
        <Row key={r.rank} rank={r.rank} mine={me?.rank === r.rank} text={line(r)} />
      ))}
      {me && !rows.some((r) => r.rank === me.rank) && <Row rank={me.rank} mine text={`Bạn: ${line(me)}`} />}
    </ol>
  )
}
