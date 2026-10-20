import { withBase } from '../base'

/** Policy text (AC-PRIV-01). A change of content needs a new POLICY_VERSION (wrangler.jsonc) so players re-consent. */
export const POLICY = { version: 1, effective: '20/10/2026' }
const CONTACT = 'thucnguyenquy@gmail.com' // open question #20 (chốt 2026-10-20)

export function PolicyPage() {
  return (
    <main className="policy">
      <p>
        <a href={withBase('')}>← Về bàn lẩu</a>
      </p>
      <h1>Chính sách quyền riêng tư</h1>
      <p>
        Phiên bản {POLICY.version}, hiệu lực từ {POLICY.effective}. Lẩu Meme không cần đăng ký tài khoản và không thu
        tên thật, email, số điện thoại hay tuổi. Trò chơi dành cho người từ 16 tuổi trở lên.
      </p>

      <h2>Dữ liệu thu và mục đích</h2>
      <ul>
        <li>
          <strong>UUID</strong> — mã ngẫu nhiên do trình duyệt của bạn tạo, chỉ gửi khi bạn bấm “Đồng ý”: để ghi khám
          phá, kết quả Món đặc biệt, streak, báo cáo, phiếu Ngon/Nhạt và đo chỉ số. Không bao giờ hiện công khai. Mã này
          là chìa khóa dữ liệu của bạn: ai có nó thì xem và xóa được dữ liệu gắn với nó, nên đừng chia sẻ.
        </li>
        <li>
          <strong>Nickname</strong> (nếu bạn đặt và đồng ý riêng): hiện trên bảng xếp hạng và Công thức gia truyền.
        </li>
        <li>
          <strong>IP dạng băm</strong> — địa chỉ IP được băm một chiều bằng khóa bí mật, không lưu IP gốc: để giới hạn
          tần suất và chống gian lận.
        </li>
        <li>
          <strong>Sự kiện chơi</strong> (mở game, ghép, chia sẻ…, gắn UUID, không IP, không thông tin thiết bị): để đo
          số người chơi và cải thiện trò chơi.
        </li>
      </ul>

      <h2>Thời hạn lưu</h2>
      <ul>
        <li>IP dạng băm: 7 ngày.</li>
        <li>Sự kiện chơi: 90 ngày.</li>
        <li>Nickname, khám phá, kết quả Món đặc biệt, streak, phiếu: đến khi bạn xóa.</li>
        <li>Bằng chứng đồng ý: đến 1 năm sau khi bạn xóa dữ liệu.</li>
      </ul>

      <h2>Không chia sẻ</h2>
      <p>
        Dữ liệu của bạn không được gửi cho AI hay bất kỳ bên thứ ba nào. Trò chơi không dùng cookie theo dõi; số lượt
        xem trang đo bằng Cloudflare Web Analytics, không dùng cookie.
      </p>

      <h2>Quyền của bạn</h2>
      <p>Mở mục “Dữ liệu của tôi” ở chân trang chủ để:</p>
      <ul>
        <li>xem và tải về (xuất) toàn bộ dữ liệu gắn với UUID của bạn;</li>
        <li>rút lại đồng ý — trò chơi ngừng gửi dữ liệu ngay;</li>
        <li>
          xóa dữ liệu — nickname, kết quả, streak, phiếu, sự kiện bị xóa; khám phá và báo cáo giữ lại nhưng không còn
          gắn với bạn.
        </li>
      </ul>
      <p>Bạn vẫn chơi ghép được mà không cần đồng ý.</p>

      <h2>Liên hệ</h2>
      <p>
        Email: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. Ghi kèm 8 ký tự đầu của mã trong mục “Dữ liệu của tôi” nếu
        yêu cầu liên quan tới dữ liệu của bạn — đừng gửi cả mã.
      </p>
    </main>
  )
}
