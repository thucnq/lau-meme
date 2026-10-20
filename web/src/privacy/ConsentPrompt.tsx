import { withBase } from '../base'

/** Shown instead of an action that sends data while the player has not agreed (AC-PRIV-02). */
export function ConsentPrompt() {
  return (
    <p className="consent-prompt">
      Cần đồng ý chính sách dữ liệu để gửi. <a href={withBase('chinh-sach')}>Xem chính sách</a>
    </p>
  )
}
