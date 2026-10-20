import { useState } from 'react'
import { withBase } from '../base'
import { grantConsent } from './client'
import { readConsent, saveConsent } from './consent'

type Props = { policyVersion: number; storage: Storage | null; onChange?: (granted: boolean) => void }

/**
 * Consent box (AC-PRIV-02/09): shown until the player chooses for the current policy version. Nothing is pre-chosen;
 * "Chỉ chơi" sends nothing and keeps the game playable.
 */
export function ConsentBanner({ policyVersion, storage, onChange }: Props) {
  const [chosen, setChosen] = useState(() => readConsent(storage)?.version === policyVersion)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  if (chosen) return null

  const agree = () => {
    setBusy(true)
    setError(false)
    grantConsent({ storage, policyVersion }).then(
      () => {
        setChosen(true)
        onChange?.(true)
      },
      () => {
        setBusy(false)
        setError(true)
      },
    )
  }
  const decline = () => {
    saveConsent(storage, policyVersion, 'declined')
    setChosen(true)
    onChange?.(false)
  }

  return (
    <section className="consent" role="dialog" aria-modal="false" aria-labelledby="consent-title">
      <h2 id="consent-title">Dữ liệu khi chơi</h2>
      <p>
        Để lưu khám phá, kết quả Món đặc biệt và bảng xếp hạng, trò chơi gửi một mã ngẫu nhiên của trình duyệt (không
        phải tên hay tài khoản của bạn) kèm dữ liệu chơi. Xem <a href={withBase('chinh-sach')}>chính sách</a>.
      </p>
      <p>Bấm “Đồng ý” nghĩa là: Tôi từ 16 tuổi trở lên và đồng ý với chính sách này.</p>
      {error && <p role="alert">Không gửi được, thử lại sau.</p>}
      <div className="consent-actions">
        <button type="button" onClick={agree} disabled={busy}>
          Đồng ý
        </button>
        <button type="button" onClick={decline} disabled={busy}>
          Chỉ chơi, không gửi gì
        </button>
      </div>
    </section>
  )
}
