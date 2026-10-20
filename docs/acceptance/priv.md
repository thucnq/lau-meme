# Tiêu chí nghiệm thu — Chính sách quyền riêng tư (PRIV)

> Giai đoạn 1. Dữ liệu cá nhân **cơ bản** (UUID, nickname, IP băm, sự kiện chơi) theo Luật BVDLCN 2025 + NĐ 356/2025. Không có dữ liệu nhạy cảm.
> Component: web (trang chính sách, hộp đồng ý, quyền chủ thể), worker (lưu đồng ý, xuất/xóa, băm IP, dọn dữ liệu).

### AC-PRIV-01: Trang chính sách
- **Cho** bất kỳ ai
- **Khi** mở `/chinh-sach` (link có ở chân trang chủ, hộp đồng ý và trang admin)
- **Thì** trang tiếng Việt nêu: dữ liệu thu (UUID, nickname, IP dạng băm, sự kiện chơi), mục đích từng loại, thời hạn lưu (IP băm 7 ngày, sự kiện 90 ngày, nickname/khám phá/kết quả Daily đến khi xóa), không gửi dữ liệu người chơi cho AI hay bên thứ ba, không cookie theo dõi, quyền xem/xuất/xóa/rút đồng ý và cách thực hiện, kênh liên hệ, version + ngày hiệu lực
- Ưu tiên: Bắt buộc

### AC-PRIV-02: Đồng ý trước khi gửi dữ liệu
- **Cho** trình duyệt chưa có bản ghi đồng ý cho version chính sách hiện hành
- **Khi** mở trang
- **Thì** hiện hộp thông báo ngắn kèm link chính sách, nút "Đồng ý" và "Chỉ chơi, không gửi gì" (không có lựa chọn nào được chọn sẵn); trước khi đồng ý client không gửi bất kỳ yêu cầu nào kèm UUID (khám phá, Daily, báo cáo, phiếu, sự kiện); chọn "Chỉ chơi" thì vẫn chơi ghép được, các nút cần gửi dữ liệu hiện lời mời đồng ý
- Ưu tiên: Bắt buộc

### AC-PRIV-03: Lưu bằng chứng đồng ý
- **Cho** thực khách bấm "Đồng ý" (mục đích: chơi + bảng xếp hạng + đo chỉ số); và khi lưu nickname lần đầu (mục đích: hiển thị nickname công khai, ô tích không tích sẵn)
- **Khi** client gửi `POST` đồng ý
- **Thì** trả 201; bảng đồng ý append-only có dòng: UUID, mục đích, version chính sách, thời điểm, IP băm, kênh "web"; `PUT` nickname khi chưa có đồng ý mục đích nickname trả 403 problem+json
- Ưu tiên: Bắt buộc

### AC-PRIV-04: Rút lại đồng ý
- **Cho** thực khách đã đồng ý
- **Khi** bấm "Rút lại đồng ý" trong mục "Dữ liệu của tôi"
- **Thì** client gửi bản ghi rút đồng ý (append-only) rồi ngừng gửi mọi yêu cầu kèm UUID; người chơi được hỏi có muốn xóa dữ liệu luôn không (AC-PRIV-05)
- Ưu tiên: Bắt buộc

### AC-PRIV-05: Xóa dữ liệu của mình
- **Cho** UUID U có nickname, 2 khám phá đầu tiên, kết quả Daily, streak, báo cáo, phiếu và sự kiện
- **Khi** gửi `DELETE` dữ liệu của mình kèm U (sau khi xác nhận trên UI)
- **Thì** trả 204; nickname, kết quả Daily, streak, phiếu, sự kiện của U bị xóa; 2 khám phá giữ nhưng bỏ liên kết với U và hiện "Thực khách ẩn danh"; báo cáo giữ nhưng bỏ UUID (vẫn tính vào số lượng đã đếm); bản ghi đồng ý giữ theo thời hạn ở BRD 5.2; client xóa UUID cục bộ và sinh UUID mới. Gọi lại với U đã xóa trả 204 (idempotent)
- Ưu tiên: Bắt buộc

### AC-PRIV-06: IP chỉ lưu dạng băm, xóa sau 7 ngày
- **Cho** mọi yêu cầu ghi có IP người gửi
- **Khi** server cần IP để giới hạn tần suất hoặc ghi đồng ý
- **Thì** chỉ lưu HMAC-SHA256(IP, khóa trong Cloudflare secret) — không có cột hay log nào chứa IP thô; tác vụ dọn hằng ngày xóa/ẩn danh hóa IP băm cũ hơn 7 ngày ở mọi bảng
- Ưu tiên: Bắt buộc

### AC-PRIV-07: Log không chứa dữ liệu cá nhân thô
- **Cho** Worker xử lý yêu cầu có UUID, nickname, IP, token admin
- **Khi** ghi log (thành công hoặc lỗi)
- **Thì** log không chứa IP, nickname, token; UUID chỉ xuất hiện dạng mask (8 ký tự đầu + `…`)
- Ưu tiên: Bắt buộc

### AC-PRIV-08: Xem và xuất dữ liệu của mình
- **Cho** UUID U có dữ liệu
- **Khi** gửi `GET` dữ liệu của mình kèm U
- **Thì** trả 200 JSON gồm nickname, các khám phá, kết quả Daily, streak, báo cáo (lý do, thời điểm), phiếu, các bản ghi đồng ý và số sự kiện theo loại; UI có nút "Tải về" lưu file JSON; UUID khác trả về dữ liệu rỗng của UUID đó (không bao giờ dữ liệu của người khác)
- Ưu tiên: Bắt buộc

### AC-PRIV-09: Chính sách đổi version
- **Cho** thực khách đã đồng ý version 1; chính sách lên version 2
- **Khi** mở trang
- **Thì** hộp đồng ý hiện lại cho version 2; tới khi đồng ý version 2, client xử lý như chưa đồng ý (AC-PRIV-02)
- Ưu tiên: Bắt buộc
