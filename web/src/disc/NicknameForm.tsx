import { useState } from 'react'
import type { FormEvent } from 'react'
import { grantConsent } from '../privacy/client'
import { canSend } from '../privacy/consent'
import { ConsentPrompt } from '../privacy/ConsentPrompt'
import { NicknameError, putNickname } from './api'

type Props = { policyVersion: number; storage: Storage | null }
type Status = 'idle' | 'no-display-consent' | 'no-consent' | 'saved' | 'invalid' | 'taken' | 'error'

const MESSAGES: Record<Exclude<Status, 'idle' | 'no-consent'>, string> = {
  'no-display-consent': 'Cần đồng ý hiện nickname công khai',
  saved: 'Đã lưu nickname',
  invalid: 'Nickname không hợp lệ',
  taken: 'Nickname đã có người dùng',
  error: 'Không lưu được, thử lại sau.',
}

/** Nickname with its own display consent, never pre-checked (AC-DISC-02..04, AC-PRIV-03). */
export function NicknameForm({ policyVersion, storage }: Props) {
  const [nickname, setNickname] = useState('')
  const [display, setDisplay] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>('idle')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!display) return setStatus('no-display-consent')
    if (!canSend(storage, policyVersion)) return setStatus('no-consent')
    const opts = { storage, policyVersion }
    setBusy(true)
    grantConsent(opts, 'nickname')
      .then(() => putNickname(nickname, opts))
      .then(
        (saved) => {
          setNickname(saved)
          setStatus('saved')
        },
        (err: unknown) => setStatus(err instanceof NicknameError && err.reason !== 'consent' ? err.reason : 'error'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <form className="nickname-form" onSubmit={submit}>
      <label>
        Nickname{' '}
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} autoComplete="off" />
      </label>
      <label>
        <input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} /> Cho phép hiện
        nickname công khai
      </label>
      <button type="submit" disabled={busy}>
        Lưu nickname
      </button>
      {status === 'no-consent' ? <ConsentPrompt /> : status !== 'idle' && <p role="status">{MESSAGES[status]}</p>}
    </form>
  )
}
