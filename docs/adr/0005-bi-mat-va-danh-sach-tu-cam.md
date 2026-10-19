# 0005 — Bí mật và danh sách từ cấm không nằm trong repo public

- Trạng thái: Đề xuất
- Ngày: 2026-10-20

## Bối cảnh
Repo có thể công khai (CLAUDE.md). Worker cần lọc nickname theo từ cấm + bí danh bị chặn (AC-DISC-03, AC-MOD-06); pipeline cần cùng danh sách cho lớp kiểm duyệt 1 (AC-MOD-01). Danh sách từ cấm tiếng Việt công khai sẽ bị dùng để lách (câu hỏi mở 16).

## Quyết định
- Cloudflare secrets (production và `--env staging` riêng): `ADMIN_TOKEN`, `PIPELINE_TOKEN`, `IP_HASH_KEY`. Biến thường (không bí mật): `APP_ENV`, `POLICY_VERSION`.
- GitHub Secrets của workflow mẻ nhúng: `PIPELINE_TOKEN`, `API_BASE_URL`, `BANNED_WORDS` (danh sách từ cấm, mỗi dòng một từ); giai đoạn 2 thêm `GEMINI_API_KEY`, `REDDIT_*`, `YOUTUBE_API_KEY`.
- Mỗi mẻ, pipeline `PUT /api/pipeline/banned-terms/wordlist` với danh sách đã `fold` từ `BANNED_WORDS`, và `…/mod` với bí danh do MOD sinh (giai đoạn 2). Bí danh do quản trị chặn được Worker ghi thẳng (nguồn `admin`, AC-ADMIN-05) và trả cho pipeline qua `GET /api/pipeline/state`.
- Worker đọc `banned_term` (D1, không công khai) khi kiểm nickname: so `fold` của nickname đã bỏ dấu câu/khoảng trắng với từng từ (chứa chuỗi con). Thông báo lỗi luôn chung chung (AC-DISC-03).
- Token so bằng phép so hằng thời gian trên SHA-256 của hai chuỗi; dấu vân token trong audit là 8 ký tự hex đầu của SHA-256(token).

## Hệ quả
- Đổi danh sách từ cấm = sửa GitHub Secret; có hiệu lực ở mẻ kế tiếp (≤ 12 giờ) hoặc khi chạy tay workflow.
- Môi trường mới chưa chạy mẻ nào thì `banned_term` rỗng ⇒ nickname chỉ bị lọc bởi bí danh admin; chạy mẻ đầu trước khi mở cho người chơi.

## Phương án đã loại
- Danh sách từ cấm trong repo: lộ công khai.
- Cloudflare secret chứa cả danh sách: giới hạn kích thước một secret nhỏ, và pipeline cũng cần bản sao riêng.
