/**
 * Game-show pieces of the mQuiz room (AC-QUIZ-29..38, ADR 0023): the timer and pause bars, the count-up score, the
 * podium, confetti and the invite QR. No animation library; every effect is skipped under prefers-reduced-motion.
 */
import { useEffect, useRef, useState } from 'react'
import { fold } from '../graph/crypto'

export const SHAPES = ['▲', '◆', '●', '■']
export const MEDALS = ['🥇', '🥈', '🥉']
const AVATARS = ['🍲', '🦐', '🦀', '🐟', '🍄', '🥬', '🌶', '🧄', '🥩', '🍢', '🥚', '🌽', '🦑', '🧅', '🍤', '🫑']
const URGENT_S = 5

export const reducedMotion = (): boolean => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

/** AC-QUIZ-35: the same nickname always gets the same hotpot emoji. */
export function avatarOf(nickname: string): string {
  let h = 0
  for (const ch of fold(nickname)) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return AVATARS[h % AVATARS.length]!
}

function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

/**
 * AC-QUIZ-30: seconds left as a shrinking bar, from a deadline already moved onto this device's clock; remount it for
 * each question. At 5 s it turns urgent and calls `onUrgent` once; `onTick` runs on each of the last 5 seconds.
 */
export function TimerBar({ deadline, seconds, onUrgent, onTick }: { deadline: number; seconds: number; onUrgent: () => void; onTick: () => void }) {
  const now = useNow()
  const left = Math.max(0, Math.ceil((deadline - now) / 1000))
  const urgent = left <= URGENT_S
  const lastTick = useRef<number | null>(null)
  useEffect(() => {
    if (!urgent || left === 0 || lastTick.current === left) return
    if (lastTick.current === null) onUrgent()
    lastTick.current = left
    onTick()
  }, [urgent, left, onUrgent, onTick])
  const pct = Math.min(100, (Math.max(0, deadline - now) / (seconds * 1000)) * 100)
  return (
    <div className="quiz-timebar">
      <div
        role="progressbar"
        aria-label="Thời gian còn lại"
        aria-valuemin={0}
        aria-valuemax={seconds}
        aria-valuenow={left}
        data-urgent={urgent ? 'true' : undefined}
        className="quiz-bar"
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <span role="timer" className="quiz-timer" aria-label="Thời gian còn lại">
        {`${left} s`}
      </span>
    </div>
  )
}

/** AC-QUIZ-31: the 4 s pause after a reveal, labelled with what comes next. */
export function PauseBar({ until, total, label }: { until: number; total: number; label: string }) {
  const now = useNow(100)
  const leftMs = Math.max(0, until - now)
  return (
    <div className="quiz-timebar quiz-pause">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total / 1000} aria-valuenow={Math.ceil(leftMs / 1000)} className="quiz-bar">
        <span style={{ width: `${(leftMs / total) * 100}%` }} />
      </div>
      <span className="quiz-note">{label}</span>
    </div>
  )
}

/** AC-QUIZ-33: a score that runs from `from` to `to` in 1 s; shown at once under reduced motion. Key it by both values. */
export function CountUp({ from, to }: { from: number; to: number }) {
  const [value, setValue] = useState(() => (reducedMotion() ? to : from))
  useEffect(() => {
    if (reducedMotion() || from === to) return
    const start = Date.now()
    const t = window.setInterval(() => {
      const k = Math.min(1, (Date.now() - start) / 1000)
      setValue(Math.round(from + (to - from) * k))
      if (k === 1) window.clearInterval(t)
    }, 50)
    return () => window.clearInterval(t)
  }, [from, to])
  return <>{value}</>
}

type PodiumRow = { key: string; nickname: string; score: number; rank: number }

/** AC-QUIZ-34: the top 3 left to right as 2nd, 1st, 3rd (2 players: 2 steps). */
export function Podium({ rows }: { rows: PodiumRow[] }) {
  const top = [...rows].sort((a, b) => a.rank - b.rank).slice(0, 3)
  const steps = [top[1], top[0], top[2]].filter((r): r is PodiumRow => r !== undefined)
  return (
    <ol aria-label="Bục nhận giải" className="quiz-podium">
      {steps.map((r) => (
        <li key={r.key} data-rank={Math.min(r.rank, 3)}>
          <span className="quiz-medal" aria-hidden="true">
            {MEDALS[Math.min(r.rank, 3) - 1]}
          </span>
          <span className="quiz-podium-name">{r.nickname}</span>
          <span className="quiz-podium-score">{`${r.score} điểm`}</span>
        </li>
      ))}
    </ol>
  )
}

const CONFETTI_MS = 2500
const CONFETTI_TOKENS = ['--quiz-1', '--quiz-2', '--quiz-3', '--quiz-4', '--color-broth']

/** AC-QUIZ-34: one burst of paper over the podium, gone within 3 s; never under reduced motion (AC-QUIZ-36). */
export function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null)
  const [done, setDone] = useState(reducedMotion)
  useEffect(() => {
    if (done) return
    const canvas = ref.current
    const g = canvas?.getContext('2d')
    const w = (canvas!.width = canvas!.clientWidth || 320)
    const h = (canvas!.height = canvas!.clientHeight || 240)
    const css = getComputedStyle(document.documentElement)
    const colors = CONFETTI_TOKENS.map((v) => css.getPropertyValue(v).trim() || 'currentColor')
    const bits = Array.from({ length: 80 }, (_, i) => ({
      x: (i * 37) % w,
      y: -((i * 53) % h),
      vy: 2 + (i % 5),
      vx: (i % 7) - 3,
      c: colors[i % colors.length]!,
    }))
    const draw = window.setInterval(() => {
      if (!g) return
      g.clearRect(0, 0, w, h)
      for (const b of bits) {
        b.x += b.vx
        b.y += b.vy
        g.fillStyle = b.c
        g.fillRect(b.x, b.y, 6, 10)
      }
    }, 30)
    const stop = window.setTimeout(() => setDone(true), CONFETTI_MS)
    return () => {
      window.clearInterval(draw)
      window.clearTimeout(stop)
    }
  }, [done])
  return done ? null : <canvas ref={ref} className="quiz-confetti" aria-hidden="true" />
}

/** AC-QUIZ-38: the invite link as a QR, built in the browser (`qrcode-generator`, loaded only here). */
export function QrCode({ text, label }: { text: string; label: string }) {
  const [cells, setCells] = useState<boolean[][] | null>(null)
  useEffect(() => {
    let live = true
    import('qrcode-generator').then(
      (mod) => {
        const qr = mod.default(0, 'M')
        qr.addData(text)
        qr.make()
        const n = qr.getModuleCount()
        if (live) setCells(Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c))))
      },
      () => undefined, // offline chunk: the link and its buttons are still there
    )
    return () => {
      live = false
    }
  }, [text])
  const n = cells?.length ?? 0
  return (
    <div role="img" aria-label={label} className="quiz-qr">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox={`-2 -2 ${n + 4} ${n + 4}`} shapeRendering="crispEdges">
        <rect className="quiz-qr-light" x={-2} y={-2} width={n + 4} height={n + 4} />
        {cells?.flatMap((row, r) => row.map((dark, c) => (dark ? <rect key={`${r}-${c}`} className="quiz-qr-dark" x={c} y={r} width={1} height={1} /> : null)))}
      </svg>
    </div>
  )
}
