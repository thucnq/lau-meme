import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ElementIcon } from '../art/ElementIcon'
import { readConsent } from '../privacy/consent'
import { getPlayerId } from '../privacy/player'
import { localStore, storageKey } from '../storage'
import { getRoom, hostKey, joinedKey, roomLink, savedNickname, socketUrl, type GameSummary, type Item } from './api'
import { checkSoloAnswer, soloCorrectPair } from './solo'

/** One mQuiz room (AC-QUIZ-03..17, 26): lobby, questions, reveal, final board, and the offline solo game. */
type Target = Omit<Item, 'id'>
type Player = { seat: number; nickname: string; connected: boolean }
type BoardRow = { seat: number; nickname: string; score: number; rank: number }
type FinalRow = { seat: number; nickname: string; score: number; correct: number; rank: number }
type Question = { q: number; total: number; target: Target; options: Item[]; deadline: number }
type Reveal = { correct: string[]; mine: string[]; top: BoardRow[]; me: { seat: number; score: number; rank: number } }
type Lobby = { players: Player[]; host: number; you: number; questions: number; seconds: number }
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
const MEDALS = ['🥇', '🥈', '🥉']
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

/** Seconds left, from a deadline already moved onto this device's clock; remount it for each question. */
function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [])
  return (
    <span role="timer" className="quiz-timer" aria-label="Thời gian còn lại">
      {Math.max(0, Math.ceil((deadline - now) / 1000))}
    </span>
  )
}

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
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [copied, setCopied] = useState(false)
  const [lost, setLost] = useState(false)
  const ws = useRef<WebSocket | null>(null)
  const picksRef = useRef<string[]>([])
  const timers = useRef<number[]>([])

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

  // ------------------------------------------------------------------ solo (AC-QUIZ-17): everything on this device
  const openSolo = useCallback(
    (save: SoloSave) => {
      write(storage, soloKey(code), save)
      setSolo(save)
      setReveal(null)
      setPicks([])
      picksRef.current = []
      setAnswered(false)
      setQuestion(soloQuestion(save))
      setScreen({ kind: 'solo' })
    },
    [storage, code],
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
      setReveal({ correct: right ?? [], mine: chosen, top: [], me: { seat: 1, score: next.score, rank: 1 } })
      later(() => {
        if (next.q > save.pack.total) setScreen({ kind: 'solo-done', score: next.score, correct: next.correct, total: save.pack.total })
        else openSolo(next)
      }, PAUSE_MS)
    },
    [storage, code, openSolo, later],
  )

  // ------------------------------------------------------------------ server messages
  const onMessage = useCallback(
    (m: Record<string, unknown>) => {
      switch (m.type) {
        case 'lobby':
          setLobby({ players: m.players as Player[], host: m.host_seat as number, you: m.you as number, questions: m.questions as number, seconds: m.seconds as number })
          setError(null)
          setScreen({ kind: 'lobby' })
          return
        case 'started':
          setTotal(m.total as number)
          return
        case 'question': {
          const skew = (m.server_now as number) - Date.now()
          setQuestion({ q: m.q as number, total: m.total as number, target: m.target as Target, options: m.options as Item[], deadline: (m.deadline as number) - skew })
          setTotal(m.total as number)
          setPicks([])
          picksRef.current = []
          setAnswered(false)
          setReveal(null)
          setScreen({ kind: 'question' })
          return
        }
        case 'answered':
          setAnswered(true)
          return
        case 'reveal': {
          const board = m.board as { top: BoardRow[]; me: Reveal['me'] }
          setReveal({ correct: m.correct as string[], mine: picksRef.current, top: board.top, me: board.me })
          return
        }
        case 'final':
          setScreen({ kind: 'final', rows: m.standings as FinalRow[] })
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
    [openSolo],
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
          <p>
            {lobby.questions} câu · {lobby.seconds} giây mỗi câu
          </p>
          <ul aria-label="Người chơi">
            {lobby.players.map((p) => (
              <li key={p.seat} aria-current={p.seat === lobby.you ? 'true' : undefined}>
                {p.nickname}
                {p.seat === lobby.host ? ' (chủ phòng)' : ''}
                {p.connected ? '' : ' (vắng)'}
              </li>
            ))}
          </ul>
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
          <p className="quiz-progress">
            {question.q} / {question.total}
          </p>
          {!reveal && <Countdown key={question.q} deadline={question.deadline} />}
          <p className="quiz-target">
            <ElementIcon emoji={question.target.emoji} imageKey={question.target.image_key} />
            <strong>{question.target.name}</strong>
          </p>
          <p className="quiz-note">Chọn 2 món ghép ra meme này</p>
          <div className="quiz-options">
            {question.options.map((o) => (
              <button
                key={o.id}
                type="button"
                aria-pressed={picks.includes(o.id)}
                data-state={stateOf(o)}
                disabled={answered || reveal !== null}
                onClick={() => toggle(o.id)}
              >
                <ElementIcon emoji={o.emoji} imageKey={o.image_key} /> {o.name}
              </button>
            ))}
          </div>
          <button type="button" className="quiz-submit" disabled={answered || reveal !== null || picks.length !== 2} onClick={submit}>
            Chốt
          </button>
          {reveal && screen.kind === 'question' && (
            <ol aria-label="Bảng điểm" className="quiz-board">
              {reveal.top.map((r) => (
                <li key={r.seat} aria-current={r.seat === reveal.me.seat ? 'true' : undefined}>
                  {`${r.rank}. ${r.nickname} - ${r.score} điểm`}
                </li>
              ))}
              {!reveal.top.some((r) => r.seat === reveal.me.seat) && (
                <li aria-current="true">{`${reveal.me.rank}. ${nameOf(reveal.me.seat)} - ${reveal.me.score} điểm`}</li>
              )}
            </ol>
          )}
          {reveal && screen.kind === 'solo' && <p className="quiz-note">{solo?.score ?? 0} điểm</p>}
        </div>
      )}

      {screen.kind === 'final' && (
        <div className="quiz-final">
          <h3>Bảng xếp hạng chung cuộc</h3>
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
