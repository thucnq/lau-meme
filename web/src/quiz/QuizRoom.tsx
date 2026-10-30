import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ElementIcon } from '../art/ElementIcon'
import { readConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { localStore, storageKey } from '../storage'
import { getRoom, hostKey, joinedKey, roomLink, savedNickname, socketUrl, type GameSummary, type Item } from './api'
import { avatarOf, Confetti, CountUp, MEDALS, PauseBar, Podium, QrCode, reducedMotion, SHAPES, TimerBar } from './QuizFx'
import { buzz, createQuizSound, readSoundOn, soundSupported, writeSoundOn, type Cue } from './quizSound'
import { checkSoloAnswer, soloCorrectPair } from './solo'

/** One mQuiz room (AC-QUIZ-03..17, 26, 29..39): lobby, questions, reveal, final board, and the offline solo game. */
type Target = Omit<Item, 'id'>
type Player = { seat: number; nickname: string; connected: boolean }
type BoardRow = { seat: number; nickname: string; score: number; rank: number }
type Result = { seat: number; picks: string[] | null; ok: boolean; points: number }
/** AC-QUIZ-32: my result strip; `streak` counts right answers in a row since I (re)joined. */
type Feedback = { kind: 'right' | 'wrong' | 'timeout'; points: number; streak: number }
type Progress = { q: number; answered: number; total: number }
type FinalRow = { seat: number; nickname: string; score: number; correct: number; rank: number }
type Question = { q: number; total: number; target: Target; options: Item[]; deadline: number }
type Reveal = { correct: string[]; mine: string[]; top: BoardRow[]; me: { seat: number; score: number; rank: number }; until: number; before: Map<number, Standing> }
type Lobby = { players: Player[]; host: number; you: number; questions: number; seconds: number; entering: number[] }
/** Rank and score per seat at the previous reveal, for the arrows and the count-up (AC-QUIZ-33). */
type Standing = { rank: number; score: number }
type SoloItem = { target: Target; options: Item[]; answer_hash: string }
type SoloPack = { game_no: number; total: number; seconds: number; salt: string; items: SoloItem[] }
type SoloSave = { pack: SoloPack; q: number; score: number; correct: number }

type Screen =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'started' }
  | { kind: 'join' }
  | { kind: 'lobby' }
  | { kind: 'question' }
  | { kind: 'final'; rows: FinalRow[] }
  | { kind: 'history'; game: GameSummary }
  | { kind: 'solo' }
  | { kind: 'solo-done'; score: number; correct: number; total: number }

const PAUSE_MS = 4_000
const EMPHASIS_MS = 600
const medal = (rank: number) => (rank <= 3 ? `${MEDALS[rank - 1]} ` : `${rank}. `)
/** AC-QUIZ-12, the same rule as the server, for the solo game only. */
const points = (ok: boolean, ms: number, seconds: number) =>
  ok ? Math.round(1000 * (1 - (0.5 * Math.min(Math.max(ms, 0), seconds * 1000)) / (seconds * 1000))) : 0

const soloKey = (code: string) => storageKey(`quiz:solo:${code}`)

function read<T>(storage: Storage | null, key: string): T | null {
  try {
    const raw = storage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function write(storage: Storage | null, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key)
    else storage?.setItem(key, JSON.stringify(value))
  } catch {
    // storage blocked: the game still runs, it just cannot resume after a reload
  }
}

const soloQuestion = (save: SoloSave): Question => {
  const item = save.pack.items[save.q - 1]!
  return { q: save.q, total: save.pack.total, target: item.target, options: item.options, deadline: Date.now() + save.pack.seconds * 1000 }
}

const nextStreak = (streak: number, kind: Feedback['kind']) => (kind === 'right' ? streak + 1 : 0)

export function QuizRoom({ code, onLeave }: { code: string; onLeave?: () => void }) {
  const [storage] = useState(localStore)
  const id = useId()
  // a solo game saved on this device resumes at once, without the server (AC-QUIZ-17)
  const [resumed] = useState(() => {
    const saved = read<SoloSave>(storage, soloKey(code))
    return saved && saved.q <= saved.pack.total ? { save: saved, question: soloQuestion(saved) } : null
  })
  const [screen, setScreen] = useState<Screen>(resumed ? { kind: 'solo' } : { kind: 'loading' })
  const [solo, setSolo] = useState<SoloSave | null>(resumed?.save ?? null)
  const [question, setQuestion] = useState<Question | null>(resumed?.question ?? null)
  const [nickname, setNickname] = useState(() => read<string>(storage, joinedKey(code)) ?? '')
  const [error, setError] = useState<string | null>(null)
  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [picks, setPicks] = useState<string[]>([])
  const [answered, setAnswered] = useState(false)
  const [confirmed, setConfirmed] = useState(false) // the server took my answer (AC-QUIZ-30)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [copied, setCopied] = useState(false)
  const [lost, setLost] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [emphasis, setEmphasis] = useState(false)
  const [confetti, setConfetti] = useState(false)
  const [soundOn, setSoundOn] = useState(() => readSoundOn(storage))
  const [sound] = useState(createQuizSound)
  const ws = useRef<WebSocket | null>(null)
  const picksRef = useRef<string[]>([])
  const timers = useRef<number[]>([])
  const youRef = useRef<number | null>(null)
  const questionRef = useRef<number | null>(null)
  const streakRef = useRef(0)
  const standings = useRef<Map<number, Standing>>(new Map())
  const seatsSeen = useRef<Set<number> | null>(null)
  const soundOnRef = useRef(soundOn)
  useEffect(() => {
    soundOnRef.current = soundOn
  }, [soundOn])

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])
  useEffect(() => {
    const list = timers.current
    return () => {
      list.forEach((t) => window.clearTimeout(t))
      ws.current?.close(1000)
    }
  }, [])

  // AC-QUIZ-39: Web Audio starts on the player's first gesture, never on page load
  useEffect(() => {
    const unlock = () => soundOnRef.current && sound.unlock()
    const events = ['pointerdown', 'keydown', 'click'] as const
    events.forEach((e) => document.addEventListener(e, unlock))
    return () => events.forEach((e) => document.removeEventListener(e, unlock))
  }, [sound])
  const cue = useCallback((c: Cue) => soundOnRef.current && sound.play(c), [sound])
  const onUrgent = useCallback(() => soundOnRef.current && buzz(), [])
  const onTick = useCallback(() => cue('tick'), [cue])

  /** AC-QUIZ-32: the strip and its sound for my own result. */
  const showFeedback = useCallback(
    (kind: Feedback['kind'], points: number) => {
      streakRef.current = nextStreak(streakRef.current, kind)
      setFeedback({ kind, points, streak: streakRef.current })
      cue(kind === 'right' ? 'right' : 'wrong')
    },
    [cue],
  )

  /** AC-QUIZ-31: the new question's title stands out briefly. */
  const emphasize = useCallback(() => {
    if (reducedMotion()) return
    setEmphasis(true)
    later(() => setEmphasis(false), EMPHASIS_MS)
  }, [later])

  // ------------------------------------------------------------------ solo (AC-QUIZ-17): everything on this device
  const openSolo = useCallback(
    (save: SoloSave) => {
      write(storage, soloKey(code), save)
      if (save.q === 1 && save.score === 0) {
        // a fresh solo run: no streak or confetti carried over from the previous one
        streakRef.current = 0
        setConfetti(false)
      }
      setSolo(save)
      setReveal(null)
      setPicks([])
      picksRef.current = []
      setAnswered(false)
      setFeedback(null)
      setQuestion(soloQuestion(save))
      setScreen({ kind: 'solo' })
      emphasize()
    },
    [storage, code, emphasize],
  )

  const soloAnswer = useCallback(
    async (save: SoloSave, chosen: string[], startedAt: number) => {
      const item = save.pack.items[save.q - 1]!
      const ok = chosen.length === 2 && (await checkSoloAnswer(save.pack.salt, save.q, chosen as [string, string], item.answer_hash))
      const right = await soloCorrectPair(save.pack.salt, save.q, item.options.map((o) => o.id), item.answer_hash)
      const next: SoloSave = {
        ...save,
        q: save.q + 1,
        score: save.score + points(ok, Date.now() - startedAt, save.pack.seconds),
        correct: save.correct + (ok ? 1 : 0),
      }
      write(storage, soloKey(code), next)
      setSolo(next)
      setReveal({ correct: right ?? [], mine: chosen, top: [], me: { seat: 1, score: next.score, rank: 1 }, until: Date.now() + PAUSE_MS, before: new Map() })
      showFeedback(chosen.length === 0 ? 'timeout' : ok ? 'right' : 'wrong', next.score - save.score)
      later(() => {
        if (next.q > save.pack.total) {
          setScreen({ kind: 'solo-done', score: next.score, correct: next.correct, total: save.pack.total })
          cue('final')
        } else openSolo(next)
      }, PAUSE_MS)
    },
    [storage, code, openSolo, later, showFeedback, cue],
  )

  // ------------------------------------------------------------------ server messages
  const onMessage = useCallback(
    (m: Record<string, unknown>) => {
      switch (m.type) {
        case 'lobby': {
          const players = m.players as Player[]
          // AC-QUIZ-35: cards of players who were not in the previous list pop in
          const seen = seatsSeen.current
          const entering = seen && !reducedMotion() ? players.filter((p) => !seen.has(p.seat)).map((p) => p.seat) : []
          seatsSeen.current = new Set(players.map((p) => p.seat))
          youRef.current = m.you as number
          setLobby({ players, host: m.host_seat as number, you: m.you as number, questions: m.questions as number, seconds: m.seconds as number, entering })
          setError(null)
          setScreen({ kind: 'lobby' })
          return
        }
        case 'started':
          setTotal(m.total as number)
          streakRef.current = 0
          standings.current = new Map()
          setConfetti(false)
          return
        case 'question': {
          const skew = (m.server_now as number) - Date.now()
          setQuestion({ q: m.q as number, total: m.total as number, target: m.target as Target, options: m.options as Item[], deadline: (m.deadline as number) - skew })
          setTotal(m.total as number)
          setPicks([])
          picksRef.current = []
          setAnswered(false)
          setConfirmed(false)
          setReveal(null)
          setFeedback(null)
          setProgress(null)
          questionRef.current = m.q as number
          setScreen({ kind: 'question' })
          emphasize()
          return
        }
        case 'answered':
          setAnswered(true)
          setConfirmed(true)
          return
        case 'progress':
          // AC-QUIZ-37: only for the question still open
          if (m.q === questionRef.current) setProgress({ q: m.q as number, answered: m.answered as number, total: m.total as number })
          return
        case 'reveal': {
          questionRef.current = null
          setProgress(null)
          const board = m.board as { top: BoardRow[]; me: Reveal['me'] }
          const before = standings.current
          standings.current = new Map([...board.top, board.me].map((r) => [r.seat, { rank: r.rank, score: r.score }]))
          setReveal({ correct: m.correct as string[], mine: picksRef.current, top: board.top, me: board.me, until: Date.now() + PAUSE_MS, before })
          const mine = (m.results as Result[] | undefined)?.find((r) => r.seat === youRef.current)
          if (mine) showFeedback(mine.picks === null ? 'timeout' : mine.ok ? 'right' : 'wrong', mine.points)
          return
        }
        case 'final':
          setScreen({ kind: 'final', rows: m.standings as FinalRow[] })
          setConfetti(true)
          cue('final')
          return
        case 'solo_pack': {
          const pack = m as unknown as SoloPack
          openSolo({ pack: { game_no: pack.game_no, total: pack.total, seconds: pack.seconds, salt: pack.salt, items: pack.items }, q: 1, score: 0, correct: 0 })
          return
        }
        case 'error':
          if (m.code === 'nickname_rejected') setScreen({ kind: 'join' })
          if (m.code === 'already_started') setScreen({ kind: 'started' })
          setError(typeof m.message === 'string' && m.message ? m.message : 'Có lỗi, thử lại sau')
          return
      }
    },
    [openSolo, emphasize, showFeedback, cue],
  )

  const connect = useCallback(
    (name: string) => {
      const send = (s: WebSocket) => s.send(JSON.stringify({ type: 'join', uuid: getPlayerId(storage), nickname: name }))
      const open = ws.current
      if (open && open.readyState === WebSocket.OPEN) return send(open)
      const s = new WebSocket(socketUrl(code))
      ws.current = s
      s.addEventListener('open', () => send(s))
      s.addEventListener('message', (e: MessageEvent) => {
        try {
          onMessage(JSON.parse(String(e.data)) as Record<string, unknown>)
        } catch {
          // not ours
        }
      })
      s.addEventListener('close', (e: CloseEvent) => {
        if (ws.current !== s) return
        ws.current = null
        if (e.code === 4001) setError('Phòng đang mở ở một thẻ khác')
        // 1008: the server already said why (consent, room full, already started) in an error message
        else if (e.code !== 1000 && e.code !== 1008) setLost(true)
      })
    },
    [code, storage, onMessage],
  )

  // ------------------------------------------------------------------ first load
  useEffect(() => {
    if (resumed) return
    let live = true
    getRoom(code).then(
      (room) => {
        if (!live) return
        const joined = read<string>(storage, joinedKey(code))
        const host = read<string>(storage, hostKey(code))
        write(storage, hostKey(code), null)
        if (!room) setScreen({ kind: 'missing' })
        else if (room.state === 'finished' && room.latest) setScreen({ kind: 'history', game: room.latest })
        else if (room.state === 'playing' && joined === null) setScreen({ kind: 'started' })
        else if (room.state === 'playing' && joined !== null) connect(joined)
        else if (host !== null) {
          // just created on this device (AC-QUIZ-26)
          write(storage, joinedKey(code), host)
          setNickname(host)
          connect(host)
        } else setScreen({ kind: 'join' })
      },
      () => live && setError('Không tải được phòng, thử lại sau'),
    )
    return () => {
      live = false
    }
  }, [code, storage, resumed, connect])

  // the join screen starts from the nickname saved at Bàn lẩu (AC-QUIZ-04)
  useEffect(() => {
    if (screen.kind !== 'join' || readConsent(storage)?.choice !== 'granted') return
    let live = true
    void savedNickname(storage).then((saved) => live && saved && setNickname((typed) => typed || saved))
    return () => {
      live = false
    }
  }, [screen.kind, storage])

  // solo: the question closes itself at its deadline
  useEffect(() => {
    if (screen.kind !== 'solo' || !question || !solo || answered) return
    const t = window.setTimeout(() => {
      setAnswered(true)
      void soloAnswer(solo, [], question.deadline - solo.pack.seconds * 1000)
    }, Math.max(0, question.deadline - Date.now()))
    return () => window.clearTimeout(t)
  }, [screen.kind, question, solo, answered, soloAnswer])

  // solo: the saved pack and progress go when the player leaves the result screen
  useEffect(() => {
    if (screen.kind !== 'solo-done') return
    return () => write(storage, soloKey(code), null)
  }, [screen.kind, storage, code])

  const join = () => {
    if (readConsent(storage)?.choice !== 'granted') return setError('Cần bấm "Đồng ý" ở hộp chính sách dữ liệu trước khi vào phòng.')
    const name = nickname.trim()
    write(storage, joinedKey(code), name)
    setError(null)
    connect(name)
  }

  const send = (m: Record<string, unknown>) => ws.current?.send(JSON.stringify(m))

  const toggleSound = () => {
    const on = !soundOn
    writeSoundOn(storage, on)
    setSoundOn(on)
    if (on) sound.unlock()
  }
  const soundButton = soundSupported() ? (
    <button type="button" className="quiz-sound" aria-label={soundOn ? 'Âm thanh và rung: bật 🔊' : 'Âm thanh và rung: tắt 🔇'} aria-pressed={!soundOn} onClick={toggleSound}>
      {soundOn ? '🔊' : '🔇'}
    </button>
  ) : null

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setError('Không chép được')
    }
  }

  const toggle = (optionId: string) => {
    const next = picks.includes(optionId) ? picks.filter((p) => p !== optionId) : picks.length < 2 ? [...picks, optionId] : picks
    picksRef.current = next
    setPicks(next)
  }

  const submit = () => {
    if (!question || picks.length !== 2 || answered) return
    setAnswered(true)
    if (screen.kind === 'solo' && solo) void soloAnswer(solo, picks, question.deadline - solo.pack.seconds * 1000)
    else send({ type: 'answer', q: question.q, picks })
  }

  /** AC-QUIZ-26: the system share sheet with the room link. */
  const shareLink = async () => {
    try {
      await navigator.share({ url: roomLink(code) })
    } catch {
      // the player closed the share sheet
    }
  }

  /** AC-QUIZ-28: rank, points, right answers and the link; never the questions or answers. */
  const shareResult = async (rows: FinalRow[]) => {
    const me = rows.find((r) => r.seat === lobby?.you)
    if (!me) return
    const text = `mQuiz Lẩu Meme: hạng ${me.rank}/${rows.length} ${me.rank <= 3 ? MEDALS[me.rank - 1] : ''} · ${me.score} điểm · ${me.correct}/${total ?? rows.length} câu đúng\n${roomLink(code)}`
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text })
      } catch {
        // the player closed the share sheet
      }
    } else await copy(text)
  }

  // ------------------------------------------------------------------ render
  const stateOf = (o: Item): string | undefined => {
    if (!reveal) return undefined
    if (reveal.correct.includes(o.id)) return 'correct'
    if (reveal.mine.includes(o.id)) return 'wrong'
    return undefined
  }
  const nameOf = (seat: number) => lobby?.players.find((p) => p.seat === seat)?.nickname ?? `Người chơi ${seat}`
  /** AC-QUIZ-33: ▲/▼ against the previous reveal, nothing on the first one or when the rank holds. */
  const boardRow = (r: { seat: number; rank: number; score: number }, nickname: string) => {
    const before = reveal?.before.get(r.seat)
    const moved = before ? before.rank - r.rank : 0
    return (
      <li key={r.seat} aria-current={r.seat === reveal?.me.seat ? 'true' : undefined} data-move={moved > 0 ? 'up' : moved < 0 ? 'down' : undefined}>
        {`${r.rank}. ${nickname} - `}
        <CountUp key={`${before?.score}-${r.score}`} from={before?.score ?? r.score} to={r.score} />
        {' điểm'}
        {moved !== 0 && <span className="quiz-move">{moved > 0 ? ` ▲ ${moved}` : ` ▼ ${-moved}`}</span>}
      </li>
    )
  }
  const feedbackText = (f: Feedback) => (f.kind === 'right' ? `Chuẩn! +${f.points}` : f.kind === 'wrong' ? 'Trượt rồi' : 'Hết giờ')
  const lastQuestion = question !== null && question.q === question.total

  return (
    <section className="quiz-room" aria-label={`Phòng mQuiz ${code}`}>
      <h2>Phòng {code}</h2>
      {error && (
        <p role="alert" className="quiz-error">
          {error}
        </p>
      )}
      {lost && (
        <p className="quiz-note">
          Mất kết nối.{' '}
          <button
            type="button"
            onClick={() => {
              setLost(false)
              connect(nickname.trim())
            }}
          >
            Vào lại
          </button>
        </p>
      )}

      {screen.kind === 'loading' && <p className="quiz-note">Đang mở phòng…</p>}

      {screen.kind === 'missing' && (
        <>
          <p>Không tìm thấy phòng</p>
          <button type="button" onClick={onLeave}>
            Tạo phòng mới
          </button>
        </>
      )}

      {screen.kind === 'started' && <p>Phòng đã bắt đầu</p>}

      {screen.kind === 'join' && (
        <form
          className="quiz-create"
          onSubmit={(e) => {
            e.preventDefault()
            join()
          }}
        >
          <label htmlFor={`${id}-nick`}>Nickname</label>
          <input id={`${id}-nick`} type="text" maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} />
          <button type="submit">Vào phòng</button>
        </form>
      )}

      {screen.kind === 'lobby' && lobby && (
        <div className="quiz-lobby">
          <p className="quiz-code" aria-label={`Mã phòng ${code}`}>
            {code}
          </p>
          <p>
            {lobby.questions} câu · {lobby.seconds} giây mỗi câu
          </p>
          <p className="quiz-count">{`${lobby.players.length} người đã vào`}</p>
          <ul aria-label="Người chơi" className="quiz-players">
            {lobby.players.map((p) => (
              <li key={p.seat} aria-current={p.seat === lobby.you ? 'true' : undefined} data-entering={lobby.entering.includes(p.seat) ? 'true' : undefined}>
                <span className="quiz-avatar" aria-hidden="true">
                  {avatarOf(p.nickname)}
                </span>
                <span>
                  {p.nickname}
                  {p.seat === lobby.host ? ' (chủ phòng)' : ''}
                  {p.connected ? '' : ' (vắng)'}
                </span>
              </li>
            ))}
          </ul>
          <QrCode text={roomLink(code)} label={`Mã QR vào phòng ${code}`} />
          <p className="quiz-link">
            Link mời: <span>{roomLink(code)}</span>
          </p>
          <div className="quiz-actions">
            <button type="button" onClick={() => void copy(roomLink(code))}>
              Sao chép link
            </button>
            {typeof navigator.share === 'function' && (
              <button type="button" onClick={() => void shareLink()}>
                Chia sẻ
              </button>
            )}
            {copied && <span className="quiz-note">Đã chép</span>}
            {soundButton}
            {lobby.you === lobby.host ? (
              <button type="button" onClick={() => send({ type: 'start' })}>
                Bắt đầu
              </button>
            ) : (
              <span className="quiz-note">Chờ chủ phòng bắt đầu…</span>
            )}
          </div>
        </div>
      )}

      {(screen.kind === 'question' || screen.kind === 'solo') && question && (
        <div className="quiz-question">
          <div className="quiz-head">
            <p className="quiz-progress" data-emphasis={emphasis ? 'true' : undefined}>{`Câu ${question.q} / ${question.total}`}</p>
            {soundButton}
          </div>
          {' '}
          {!reveal && (
            <TimerBar
              key={question.q}
              deadline={question.deadline}
              seconds={screen.kind === 'solo' ? (solo?.pack.seconds ?? 20) : (lobby?.seconds ?? 20)}
              onUrgent={onUrgent}
              onTick={onTick}
            />
          )}
          {reveal && <PauseBar key={question.q} until={reveal.until} total={PAUSE_MS} label={lastQuestion ? 'Kết quả chung cuộc' : 'Câu kế tiếp'} />}
          <p className="quiz-target">
            <ElementIcon emoji={question.target.emoji} imageKey={question.target.image_key} />
            <strong>{question.target.name}</strong>
          </p>
          <p className="quiz-note">Chọn 2 món ghép ra meme này</p>
          <div className="quiz-options">
            {question.options.map((o, i) => (
              <button
                key={o.id}
                type="button"
                className={`quiz-option quiz-option-${i + 1}`}
                aria-pressed={picks.includes(o.id)}
                data-state={stateOf(o)}
                disabled={answered || reveal !== null}
                onClick={() => toggle(o.id)}
              >
                <span className="quiz-shape">
                  {SHAPES[i]}
                </span>
                <ElementIcon emoji={o.emoji} imageKey={o.image_key} /> {o.name}
                {picks.includes(o.id) && <span className="quiz-check"> ✓</span>}
              </button>
            ))}
          </div>
          <button type="button" className="quiz-submit" disabled={answered || reveal !== null || picks.length !== 2} onClick={submit}>
            Chốt
          </button>
          {screen.kind === 'question' && !reveal && (confirmed || progress) && (
            <p className="quiz-note">
              {confirmed ? 'Đã chốt, chờ mọi người' : ''}
              {confirmed && progress ? ' · ' : ''}
              {progress ? `${progress.answered}/${progress.total} người đã chốt` : ''}
            </p>
          )}
          {reveal && feedback && (
            <p role="status" className="quiz-feedback" data-kind={feedback.kind}>
              {feedbackText(feedback)}
              {feedback.streak >= 2 && <span className="quiz-streak">{` 🔥 ${feedback.streak} câu liên tiếp`}</span>}
            </p>
          )}
          {reveal && screen.kind === 'question' && (
            <ol aria-label="Bảng điểm" className="quiz-board">
              {reveal.top.map((r) => boardRow(r, r.nickname))}
              {!reveal.top.some((r) => r.seat === reveal.me.seat) && boardRow(reveal.me, nameOf(reveal.me.seat))}
            </ol>
          )}
          {reveal && screen.kind === 'solo' && <p className="quiz-note">{solo?.score ?? 0} điểm</p>}
        </div>
      )}

      {screen.kind === 'final' && (
        <div className="quiz-final">
          <h3>Bảng xếp hạng chung cuộc</h3>
          {confetti && <Confetti />}
          <Podium rows={screen.rows.map((r) => ({ key: String(r.seat), nickname: r.nickname, score: r.score, rank: r.rank }))} />
          <ol aria-label="Bảng xếp hạng" className="quiz-board">
            {screen.rows.map((r) => (
              <li key={r.seat} aria-current={r.seat === lobby?.you ? 'true' : undefined}>
                {`${medal(r.rank)}${r.nickname} - ${r.score} điểm (${r.correct} câu đúng)`}
              </li>
            ))}
          </ol>
          <div className="quiz-actions">
            <button type="button" onClick={() => void shareResult(screen.rows)}>
              Chia sẻ kết quả
            </button>
            {lobby && lobby.you === lobby.host && (
              <button type="button" onClick={() => send({ type: 'replay' })}>
                Chơi lại
              </button>
            )}
          </div>
        </div>
      )}

      {screen.kind === 'history' && (
        <div className="quiz-final">
          <h3>Bảng xếp hạng ván {screen.game.game_no}</h3>
          <ol aria-label="Bảng xếp hạng" className="quiz-board">
            {screen.game.standings.map((r) => (
              <li key={`${r.rank}-${r.nickname}`}>{`${medal(r.rank)}${r.nickname} - ${r.score} điểm (${r.correct} câu đúng)`}</li>
            ))}
          </ol>
          <button type="button" onClick={onLeave}>
            Tạo phòng mới
          </button>
        </div>
      )}

      {screen.kind === 'solo-done' && (
        <div className="quiz-final">
          <h3>Kết quả</h3>
          <p>
            {screen.score} điểm · {screen.correct}/{screen.total} câu đúng
          </p>
          <button type="button" onClick={onLeave}>
            Xong
          </button>
        </div>
      )}
    </section>
  )
}
