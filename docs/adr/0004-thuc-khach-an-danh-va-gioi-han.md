# 0004 — Thực khách ẩn danh, đồng ý kiểm cả ở server, IP băm và giới hạn tần suất bằng D1

- Trạng thái: Đề xuất
- Ngày: 2026-10-20

## Bối cảnh
Không có đăng nhập (BRD mục 2); thực khách là một UUID v4 sinh trên trình duyệt. Mọi endpoint ghi phải giới hạn tần suất theo UUID và IP băm, có cửa sổ 1 phút (DISC, DAILY, sự kiện), 1 giờ (báo cáo) và khóa 15 phút sau 5 lần sai token admin (AC-ADMIN-02). Dữ liệu cá nhân cơ bản phải có đồng ý, IP chỉ lưu dạng băm 7 ngày, sự kiện 90 ngày (BRD 5.2, AC-PRIV).

## Quyết định
- **Định danh**: header `X-Player-Id` (UUID v4, kiểm định dạng ⇒ 400). Không phải xác thực: ai biết UUID là chủ dữ liệu đó (xem/xuất/xóa) — UUID không bao giờ xuất hiện trong phản hồi công khai. `sendBeacon` không đặt được header ⇒ `POST /api/events` nhận thêm `player_id` trong thân `text/plain`.
- **Đồng ý kiểm ở server**: mọi endpoint ghi của thực khách (khám phá, Daily, báo cáo, phiếu, sự kiện) trả 403 nếu bản ghi `consent` mới nhất mục đích `play` của UUID không phải `grant` cho `POLICY_VERSION` hiện hành; `PUT /me/nickname` cần thêm mục đích `nickname` (AC-PRIV-03). Ngoại lệ: `POST /consents`, `GET /me`, `DELETE /me`. Đây là lớp thứ hai sau AC-PRIV-02 (client không gửi trước khi đồng ý) và tự áp AC-PRIV-09 khi đổi version chính sách.
- **IP**: lấy từ `CF-Connecting-IP`, chỉ dùng `HMAC-SHA256(IP_HASH_KEY, ip)`; IP thô không vào D1 hay log. `consent.ip_hash` bị đặt NULL sau 7 ngày.
- **Giới hạn tần suất**: bảng `rate_counter` cửa sổ cố định, một câu `INSERT … ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count` cho mỗi khóa (UUID, IP băm); vượt ngưỡng ⇒ 429 + `Retry-After` = giây tới hết cửa sổ, và yêu cầu không ghi gì khác. Ngưỡng là hằng số trong code theo `docs/open-questions.md` #10.
- **Dọn dữ liệu**: Cron Trigger của Worker chạy hằng ngày 03:00 GMT+7 (`triggers.crons` trong `wrangler.jsonc`): xóa `event` > 90 ngày, NULL `ip_hash` > 7 ngày, xóa `rate_counter` hết hạn, xóa `admin_audit` > 12 tháng, xóa `consent` của UUID có dòng `erase` > 1 năm; ghi số dòng đã xóa vào log (AC-METRIC-07, AC-PRIV-06).
- **Log**: chỉ UUID dạng mask (`8 ký tự đầu + …`), không IP, nickname, token, thân yêu cầu (AC-PRIV-07).

## Hệ quả
- Mỗi yêu cầu ghi tốn thêm 1–2 lượt ghi D1 cho bộ đếm — không đáng kể ở ≤ 50 người đồng thời và trong 100 000 lượt ghi/ngày của D1 free.
- Vẫn gian lận được bằng cách sinh nhiều UUID; giới hạn theo IP băm hãm bớt — chấp nhận theo BRD mục 8.
- Người dùng chung IP (4G, quán net) có thể chạm ngưỡng IP trước ngưỡng UUID; ngưỡng IP vì vậy cao gấp 2–3 lần ngưỡng UUID.

## Phương án đã loại
- Workers Rate Limiting binding: chỉ có chu kỳ 10 s hoặc 60 s, đếm theo từng vị trí Cloudflare (xấp xỉ) ⇒ không làm được cửa sổ 1 giờ của báo cáo và khóa 15 phút của admin.
- Durable Objects cho bộ đếm: chính xác hơn nhưng thêm thành phần và không cần ở tải này.
- Chỉ kiểm đồng ý ở client: không chặn được yêu cầu gửi thẳng và không tự áp khi chính sách đổi version.
