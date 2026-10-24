# Tiêu chí nghiệm thu - Đăng nhập bằng Google (AUTH)

> Thêm 2026-10-21. Component: worker (kiểm ID token, phiên, tài khoản), web (nút đăng nhập Google Identity Services, trạng thái đăng nhập).
> Đăng nhập là **tùy chọn để chơi** nhưng **bắt buộc để nộp kết quả Món đặc biệt và có tên trên bảng xếp hạng** (DAILY). Chỉ lưu băm HMAC của mã tài khoản Google (`sub`); **không lưu email, tên, ảnh đại diện** của Google. Dữ liệu cá nhân cơ bản (định danh trực tuyến) theo Luật BVDLCN 2025 + NĐ 356/2025.

### AC-AUTH-01: Đăng nhập bằng Google
- **Cho** thực khách đã đồng ý gửi dữ liệu (AC-PRIV-02), chưa đăng nhập
- **Khi** bấm "Đăng nhập bằng Google", chọn tài khoản Google; client gửi ID token Google cho Worker
- **Thì** Worker kiểm chữ ký ID token theo khóa công khai của Google (JWKS, có cache), `iss` là Google, `aud` đúng client ID của game, chưa hết hạn; hợp lệ thì tạo tài khoản lần đầu (khóa = HMAC-SHA256(`sub`) bằng secret, không lưu `sub` thô) hoặc dùng lại tài khoản có sẵn, gắn UUID của trình duyệt này vào tài khoản, mở phiên và trả 200; giao diện hiện "Đã đăng nhập" kèm nickname của tài khoản (chưa có thì "Thực khách ẩn danh"). Chưa đồng ý thì bấm đăng nhập hiện lời mời đồng ý trước
- Ưu tiên: Bắt buộc

### AC-AUTH-02: Phiên đăng nhập
- **Cho** thực khách đã đăng nhập
- **Khi** tải lại trang; gọi API cần phiên (nộp Daily, streak của mình, đặt nickname); và sau 90 ngày không dùng
- **Thì** phiên còn hiệu lực qua tải lại; mã phiên ngẫu nhiên ≥ 128 bit, chỉ lưu dạng băm trong D1, gửi bằng cookie `HttpOnly; Secure; SameSite=Lax; Path=/lau-meme` (JavaScript không đọc được); mỗi lần dùng thì gia hạn; hết 90 ngày không dùng thì phiên hết hạn và API cần phiên trả 401 (câu hỏi mở 32)
- Ưu tiên: Bắt buộc

### AC-AUTH-03: ID token không hợp lệ
- **Cho** ID token sai chữ ký, sai `aud`, sai `iss`, hết hạn, sai định dạng, hoặc thiếu
- **Khi** gửi yêu cầu đăng nhập
- **Thì** trả 401 problem+json; không tạo tài khoản, không mở phiên; log không chứa token hay `sub` (AC-PRIV-07)
- Ưu tiên: Bắt buộc

### AC-AUTH-04: Cùng tài khoản trên nhiều máy
- **Cho** tài khoản T đã đăng nhập ở máy 1, có nickname "Lẩu Thủ", streak 3 và kết quả Daily của mẻ V
- **Khi** đăng nhập T ở máy 2 (UUID khác)
- **Thì** máy 2 thấy nickname "Lẩu Thủ", streak 3, trạng thái đã nộp V (nộp lại trả 409 như AC-DAILY-08); Đĩa nhúng của T được gộp từ mọi máy theo AC-SYNC-02 (cập nhật 2026-10-24, trước đây Đĩa chỉ lưu trên từng máy); vị trí món trên bàn vẫn riêng từng máy; UUID máy 2 cũng được gắn vào T
- Ưu tiên: Bắt buộc

### AC-AUTH-05: Đăng xuất
- **Cho** thực khách đã đăng nhập
- **Khi** bấm "Đăng xuất"
- **Thì** phiên bị thu hồi phía server (dùng lại cookie cũ trả 401), cookie bị xóa; vẫn chơi ghép bình thường; nút nộp và streak của mình trở về lời mời đăng nhập
- Ưu tiên: Bắt buộc

### AC-AUTH-06: Xóa tài khoản và dữ liệu
- **Cho** tài khoản T có nickname, kết quả Daily, streak, 2 UUID đã gắn
- **Khi** gửi `DELETE` dữ liệu của mình khi đang đăng nhập (sau khi xác nhận trên UI)
- **Thì** trả 204; tài khoản (băm `sub`), mọi phiên, nickname, kết quả Daily, streak và Đĩa nhúng của tài khoản (AC-SYNC-10, thêm 2026-10-24) của T bị xóa; các UUID đã gắn xử lý như AC-PRIV-05; đăng nhập lại bằng cùng Google tạo tài khoản mới trống; trang chính sách (AC-PRIV-01) nêu thêm dữ liệu "mã tài khoản Google dạng băm", mục đích "định danh trên bảng xếp hạng", thời hạn "đến khi xóa"; xem/xuất dữ liệu (AC-PRIV-08) có thêm thời điểm tạo tài khoản và số phiên đang mở (không có băm `sub`)
- Ưu tiên: Bắt buộc

### AC-AUTH-07: Giới hạn tần suất đăng nhập
- **Cho** cùng IP băm gửi quá 10 yêu cầu đăng nhập/phút (mặc định)
- **Khi** gửi yêu cầu thứ 11 trong phút
- **Thì** trả 429 problem+json có `Retry-After`
- Ưu tiên: Bắt buộc
