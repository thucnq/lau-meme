import { useState } from 'react'
import { SendError } from '../disc/api'
import { ConsentRequiredError } from '../privacy/client'
import { ConsentPrompt } from '../privacy/ConsentPrompt'
import { REASONS, submitReport, type ReportReason } from './api'

type Props = {
  item: { id: string; name: string; image_key: string | null }
  policyVersion: number
  storage: Storage | null
  onClose: () => void
}
type Status = 'idle' | 'sending' | 'sent' | 'consent' | 'too-fast' | 'error'

/** "Báo cáo" (AC-REPORT-01/05): a reason is required and none is pre-chosen; a note only with "Khác". */
export function ReportDialog({ item, policyVersion, storage, onClose }: Props) {
  const [reason, setReason] = useState<ReportReason | null>(null)
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const titleId = `report-${item.id}`

  const send = () => {
    if (!reason) return
    // The picture alone goes back to emoji; everything else counts toward hiding the element.
    const target = reason === 'inappropriate_image' && item.image_key !== null ? 'image' : 'element'
    const req = {
      target,
      id: item.id,
      reason,
      ...(reason === 'other' && note.trim() ? { note: note.trim() } : {}),
    } as const
    setStatus('sending')
    submitReport(req, { storage, policyVersion }).then(
      () => setStatus('sent'),
      (err: unknown) => {
        if (err instanceof ConsentRequiredError) setStatus('consent')
        else setStatus(err instanceof SendError && err.status === 429 ? 'too-fast' : 'error')
      },
    )
  }

  return (
    <section className="report" role="dialog" aria-labelledby={titleId}>
      <h2 id={titleId}>Báo cáo {item.name}</h2>
      {status === 'sent' ? (
        <p role="status">Cảm ơn, tụi mình sẽ xem lại</p>
      ) : (
        <>
          <fieldset>
            <legend>Lý do</legend>
            {REASONS.map((r) => (
              <label key={r.value}>
                <input
                  type="radio"
                  name={`reason-${item.id}`}
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                />{' '}
                {r.label}
              </label>
            ))}
          </fieldset>
          {reason === 'other' && (
            <label>
              Ghi chú <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
            </label>
          )}
          <button type="button" onClick={send} disabled={!reason || status === 'sending'}>
            Gửi báo cáo
          </button>
          {status === 'consent' && <ConsentPrompt />}
          {status === 'too-fast' && <p role="status">Gửi quá nhanh, thử lại sau.</p>}
          {status === 'error' && <p role="status">Không gửi được báo cáo, thử lại sau.</p>}
        </>
      )}
      <button type="button" onClick={onClose}>
        Đóng
      </button>
    </section>
  )
}
