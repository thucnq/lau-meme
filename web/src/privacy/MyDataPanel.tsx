import { useEffect, useState } from 'react'
import { deleteMyData, getMyData, grantConsent, withdrawConsent, type MyData } from './client'
import { canSend } from './consent'

type Props = { policyVersion: number; storage: Storage | null }
type Step = 'idle' | 'ask-erase' | 'confirm-erase' | 'erased'

/** "Dữ liệu của tôi" (AC-PRIV-04/05/08): view, download, withdraw consent, erase. */
export function MyDataPanel({ policyVersion, storage }: Props) {
  const [data, setData] = useState<MyData | null>(null)
  const [granted, setGranted] = useState(() => canSend(storage, policyVersion))
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)
  const opts = { storage, policyVersion }

  useEffect(() => {
    let live = true
    getMyData(storage).then(
      (d) => live && setData(d),
      () => live && setError(true),
    )
    return () => {
      live = false
    }
  }, [storage, reload])

  const run = (action: Promise<void>, next: () => void) => {
    setError(false)
    action.then(next, () => setError(true))
  }

  const download = () => {
    if (!data) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'lau-meme-du-lieu.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="my-data" aria-labelledby="my-data-title">
      <h2 id="my-data-title">Dữ liệu của tôi</h2>
      {error && <p role="alert">Không kết nối được máy chủ, thử lại sau.</p>}
      {step === 'erased' ? (
        <p role="status">Đã xóa dữ liệu. Trình duyệt đã dùng mã mới.</p>
      ) : data ? (
        <ul>
          <li>Nickname: {data.nickname ?? 'chưa đặt'}</li>
          <li>Khám phá đầu tiên: {data.discoveries.length}</li>
          <li>Kết quả Món đặc biệt: {data.daily_results.length}</li>
          <li>
            Streak: {data.streak.current} (dài nhất {data.streak.longest})
          </li>
          <li>Báo cáo: {data.reports.length}</li>
          <li>Phiếu Ngon/Nhạt: {data.votes.length}</li>
          <li>Bản ghi đồng ý: {data.consents.length}</li>
          <li>Sự kiện: {Object.values(data.event_counts).reduce((a, b) => a + b, 0)}</li>
        </ul>
      ) : (
        !error && <p>Đang tải…</p>
      )}

      {step === 'idle' && (
        <div className="my-data-actions">
          <button type="button" onClick={download} disabled={!data}>
            Tải về
          </button>
          {granted ? (
            <button
              type="button"
              onClick={() =>
                run(withdrawConsent(opts), () => {
                  setGranted(false)
                  setStep('ask-erase')
                })
              }
            >
              Rút lại đồng ý
            </button>
          ) : (
            <button type="button" onClick={() => run(grantConsent(opts), () => setGranted(true))}>
              Đồng ý gửi dữ liệu
            </button>
          )}
          <button type="button" onClick={() => setStep('confirm-erase')}>
            Xóa dữ liệu của tôi
          </button>
        </div>
      )}

      {step === 'ask-erase' && (
        <div role="group" aria-label="Xóa dữ liệu luôn?">
          <p>Đã rút lại đồng ý. Xóa dữ liệu luôn?</p>
          <button type="button" onClick={() => setStep('confirm-erase')}>
            Xóa dữ liệu
          </button>
          <button type="button" onClick={() => setStep('idle')}>
            Giữ lại
          </button>
        </div>
      )}

      {step === 'confirm-erase' && (
        <div role="group" aria-label="Xác nhận xóa">
          <p>Xóa nickname, kết quả, streak, phiếu và sự kiện của bạn? Không hoàn tác được.</p>
          <button
            type="button"
            onClick={() =>
              run(deleteMyData(storage), () => {
                setData(null)
                setStep('erased')
                setReload((n) => n + 1)
              })
            }
          >
            Xóa vĩnh viễn
          </button>
          <button type="button" onClick={() => setStep('idle')}>
            Thôi
          </button>
        </div>
      )}
    </section>
  )
}
