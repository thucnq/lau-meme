import { useEffect, useId, useState } from 'react'
import { readConsent } from '../privacy/consent'
import { localStore } from '../storage'
import { createRoom, getHistory, rememberHost, savedNickname, type HistoryItem } from './api'

type Props = {
  onOpenRoom?: (code: string) => void
  /** Policy version of the manifest; without it a stored "Đồng ý" of any version is enough (the server checks). */
  policyVersion?: number
}

const consented = (storage: Storage | null, policyVersion?: number): boolean => {
  const c = readConsent(storage)
  return c?.choice === 'granted' && (policyVersion === undefined || c.version === policyVersion)
}

const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })

/** The mQuiz tab (AC-QUIZ-26): create a room, and my past games (AC-QUIZ-19). */
export function QuizPanel({ onOpenRoom, policyVersion }: Props) {
  const [storage] = useState(localStore)
  const id = useId()
  const [nickname, setNickname] = useState('')
  const [questions, setQuestions] = useState(10)
  const [seconds, setSeconds] = useState(20)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [askConsent, setAskConsent] = useState(false)
  const [history, setHistory] = useState<HistoryItem[] | null>(null)
  const allowed = consented(storage, policyVersion)

  // the nickname saved at Bàn lẩu, unless the player already typed one (AC-QUIZ-26)
  useEffect(() => {
    if (!allowed) return
    let live = true
    void savedNickname(storage).then((saved) => live && saved && setNickname((typed) => typed || saved))
    return () => {
      live = false
    }
  }, [storage, allowed])

  useEffect(() => {
    if (!allowed) return
    let live = true
    getHistory(storage).then(
      (r) => live && setHistory(r.items),
      () => live && setHistory([]),
    )
    return () => {
      live = false
    }
  }, [storage, allowed])

  const create = async () => {
    setError(null)
    if (!allowed) return setAskConsent(true)
    setBusy(true)
    try {
      const name = nickname.trim()
      const room = await createRoom(storage, { nickname: name, questions, seconds })
      // the host goes straight into the lobby with this nickname, not through the guests' join screen
      rememberHost(storage, room.code, name)
      onOpenRoom?.(room.code)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tạo được phòng')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="quiz-panel" aria-label="mQuiz">
      <h2>mQuiz - đố meme cùng bạn bè</h2>
      <p className="quiz-lead">Tạo phòng, gửi link cho bạn bè, chọn 2 trong 4 món ghép ra meme. Đúng càng nhanh càng nhiều điểm.</p>
      <form
        className="quiz-create"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label htmlFor={`${id}-nick`}>Nickname</label>
        <input id={`${id}-nick`} type="text" maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} />
        <label htmlFor={`${id}-q`}>Số câu</label>
        <select id={`${id}-q`} value={questions} onChange={(e) => setQuestions(Number(e.target.value))}>
          {[5, 10, 15].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-s`}>Số giây</label>
        <select id={`${id}-s`} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
          {[10, 20, 30].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          Tạo phòng
        </button>
      </form>
      {askConsent && !allowed && (
        <p className="quiz-note">Cần bấm "Đồng ý" ở hộp chính sách dữ liệu trước khi tạo hoặc vào phòng mQuiz.</p>
      )}
      {error && (
        <p role="alert" className="quiz-error">
          {error}
        </p>
      )}

      <h3>Lịch sử mQuiz</h3>
      {!allowed ? (
        <p className="quiz-note">Lịch sử chỉ hiện khi bạn cho phép gửi dữ liệu.</p>
      ) : history === null ? (
        <p className="quiz-note">Đang tải…</p>
      ) : history.length === 0 ? (
        <p className="quiz-note">Bạn chưa chơi ván mQuiz nào</p>
      ) : (
        <ul className="quiz-history">
          {history.map((h) => (
            <li key={`${h.code}-${h.game_no}`}>
              <button type="button" onClick={() => onOpenRoom?.(h.code)}>
                {`${when(h.finished_at)} · ${h.nickname} · ${h.score} điểm · hạng ${h.rank}/${h.player_count} · ${h.correct}/${h.questions} câu đúng`}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
