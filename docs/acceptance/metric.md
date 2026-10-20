# Tiêu chí nghiệm thu - Đo chỉ số thành công (METRIC)

> Giai đoạn 1. Component: web (beacon + gom sự kiện), worker (nhận sự kiện, tổng hợp, dọn dữ liệu), pipeline (đưa số liệu vào báo cáo đợt).
> Cần bảng sự kiện D1 (trả lời câu hỏi phạm vi 3). Chỉ gửi sự kiện khi thực khách đã đồng ý (AC-PRIV-02).

### AC-METRIC-01: Cloudflare Web Analytics không cookie
- **Cho** trang chủ được build
- **Khi** tải trang
- **Thì** HTML có beacon Cloudflare Web Analytics (token qua biến build, không cứng trong repo nếu là bí mật); trang không đặt cookie nào và không nạp script theo dõi bên thứ ba khác
- Ưu tiên: Bắt buộc

### AC-METRIC-02: Nhận sự kiện theo danh sách cho phép
- **Cho** thực khách đã đồng ý
- **Khi** client gửi `POST` lô sự kiện (tối đa 50 sự kiện/lô) với loại thuộc danh sách: `session_start`, `combine_summary` (số lượt ghép được/trượt trong phiên), `daily_start`, `daily_complete`, `share` (`card`, `method`), `report`, `feedback`
- **Thì** trả 202; mỗi sự kiện lưu: loại, UUID, thời điểm server nhận, thuộc tính đã validate; không lưu IP, user agent, URL giới thiệu đầy đủ
- Ưu tiên: Bắt buộc

### AC-METRIC-03: Sự kiện không hợp lệ
- **Cho** lô có loại sự kiện lạ, thuộc tính ngoài schema, lô hơn 50 sự kiện, hoặc thiếu UUID
- **Khi** gửi lô
- **Thì** loại/thuộc tính sai hoặc lô quá lớn trả 422, thiếu UUID trả 400 - problem+json; cả lô không được ghi; vượt 20 lô/phút/UUID trả 429
- Ưu tiên: Bắt buộc

### AC-METRIC-04: Client gom sự kiện ghép
- **Cho** thực khách ghép 40 lượt trong một phiên
- **Khi** phiên diễn ra
- **Thì** client không gửi một yêu cầu cho mỗi lượt ghép; số lượt ghép được/trượt được cộng dồn và gửi trong `combine_summary` khi trang bị ẩn (`visibilitychange`) hoặc mỗi 5 phút, qua `navigator.sendBeacon` nếu có
- Ưu tiên: Bắt buộc

### AC-METRIC-05: Tổng hợp chỉ số
- **Cho** bộ sự kiện mẫu cố định (fixture) trải 10 ngày
- **Khi** chạy hàm tổng hợp cho một ngày D (GMT+7)
- **Thì** trả đúng giá trị tính tay của: số người chơi Daily (UUID khác nhau có `daily_start`), số hoàn thành Daily, D1 retention (tỉ lệ UUID có `session_start` lần đầu ngày D−1 quay lại ngày D) và D7 retention (lần đầu D−7, quay lại D), số lượt chia sẻ theo `card`, tỉ lệ ghép trượt (tổng trượt / tổng ghép), tỉ lệ "Nhạt", số báo cáo
- Ưu tiên: Bắt buộc

### AC-METRIC-06: Đưa số liệu vào báo cáo đợt
- **Cho** pipeline có token pipeline
- **Khi** bước báo cáo đợt chạy
- **Thì** pipeline gọi endpoint tổng hợp (chỉ token pipeline hoặc admin gọi được, thiếu token trả 401) và nhận số liệu đã tổng hợp - không có UUID hay sự kiện thô; số liệu được ghi vào GitHub Issue (AC-PIPE-14)
- Ưu tiên: Bắt buộc

### AC-METRIC-07: Dọn sự kiện quá hạn
- **Cho** sự kiện cũ hơn 90 ngày
- **Khi** tác vụ dọn định kỳ (Cron Trigger của Worker, hằng ngày) chạy
- **Thì** các sự kiện đó bị xóa; sự kiện trong 90 ngày giữ nguyên; tác vụ ghi số dòng đã xóa vào log
- Ưu tiên: Bắt buộc
