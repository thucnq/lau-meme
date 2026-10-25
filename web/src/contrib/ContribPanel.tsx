import { useEffect, useState, type FormEvent } from 'react'
import { useSession } from '../auth/session'
import { ConsentRequiredError } from '../privacy/client'
import { ConsentPrompt } from '../privacy/ConsentPrompt'
import {
  ContributionError,
  listMyContributions,
  STATUS_LABEL,
  submitContribution,
  type Contribution,
  type ContributionRequest,
} from './api'

type Props = { policyVersion: number; storage: Storage | null }
type Sent = { kind: 'ok' } | { kind: 'error'; text: string } | { kind: 'consent' }

const FIELDS = [
  ['a', 'Phần tử 1'],
  ['b', 'Phần tử 2'],
  ['name', 'Tên meme'],
  ['emoji', 'Biểu tượng'],
  ['description', 'Mô tả'],
  ['image_url', 'Link ảnh'],
] as const
type Field = (typeof FIELDS)[number][0]
const EMPTY: Record<Field, string> = { a: '', b: '', name: '', emoji: '', description: '', image_url: '' }
const OPTIONAL: Field[] = ['emoji', 'description', 'image_url']

/**
 * "Đóng góp meme" (AC-CONTRIB-01..06): a signed-in player proposes a new element from two existing ones and sees
 * their own proposals with their status. Signed out it only invites to sign in. The server checks everything again.
 */
export function ContribPanel({ policyVersion, storage }: Props) {
  const signedIn = useSession() !== null
  const [form, setForm] = useState(EMPTY)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<Sent | null>(null)
  const [mine, setMine] = useState<Contribution[] | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!signedIn) return
    let live = true
    listMyContributions().then(
      (items) => live && setMine(items),
      () => live && setMine([]),
    )
    return () => {
      live = false
    }
  }, [signedIn, reload])

  if (!signedIn) return <p className="contrib-invite">Đăng nhập bằng Google để đóng góp meme</p>

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const body: ContributionRequest = { a: form.a, b: form.b, name: form.name }
    for (const k of OPTIONAL) if (form[k].trim() !== '') body[k] = form[k].trim()
    setSending(true)
    setSent(null)
    try {
      await submitContribution(body, { storage, policyVersion })
      setSent({ kind: 'ok' })
      setForm(EMPTY)
      setReload((n) => n + 1)
    } catch (err) {
      if (err instanceof ConsentRequiredError) setSent({ kind: 'consent' })
      else setSent({ kind: 'error', text: err instanceof ContributionError ? err.detail : 'Không gửi được, thử lại sau.' })
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="contrib" role="region" aria-label="Đóng góp meme">
      <form onSubmit={submit} className="contrib-form">
        {FIELDS.map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input
              value={form[key]}
              required={!OPTIONAL.includes(key)}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            />
          </label>
        ))}
        <button type="submit" disabled={sending}>
          Gửi đề xuất
        </button>
      </form>
      {sent?.kind === 'ok' && <p role="status">Đã gửi, chờ duyệt</p>}
      {sent?.kind === 'error' && <p role="alert">{sent.text}</p>}
      {sent?.kind === 'consent' && <ConsentPrompt />}

      <h2>Đề xuất của tôi</h2>
      {mine !== null && mine.length === 0 && <p>Bạn chưa đóng góp meme nào</p>}
      {mine !== null && mine.length > 0 && (
        <ul className="contrib-list">
          {mine.map((c) => (
            <li key={c.id} data-status={c.status}>
              <strong>
                {c.emoji ? `${c.emoji} ` : ''}
                {c.name}
              </strong>
              <span>
                {c.a.name} + {c.b.name}
              </span>
              <span className="contrib-status">{STATUS_LABEL[c.status]}</span>
              {c.status === 'rejected' && c.reject_reason && <span>Lý do: {c.reject_reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
