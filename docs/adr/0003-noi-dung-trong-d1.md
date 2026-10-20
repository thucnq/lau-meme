# 0003 - Nội dung, graph và manifest lưu trong D1, pipeline đăng qua API của Worker

- Trạng thái: Đề xuất
- Ngày: 2026-10-20

## Bối cảnh
Mỗi ngày 2 mẻ đổi Món đặc biệt + manifest (AC-PIPE-01), giữ 14 bản (AC-GRAPH-05), rollback ≤ 5 phút (AC-GRAPH-06), lỗi giữa chừng không đổi bản đang chạy (AC-PIPE-11). Worker cần nội dung của version hiện hành để kiểm khám phá và Daily (AC-DISC-07, AC-DAILY-06), quản trị cần danh mục phần tử có tên để xem báo cáo (AC-ADMIN-06). Production deploy là việc của người (CLAUDE.md), chi phí phải $0.

## Quyết định
- "Deploy" của mẻ nhúng là **đăng dữ liệu**, không deploy code: pipeline gọi `POST /api/pipeline/batches` (token `PIPELINE_TOKEN`). Một `DB.batch` duy nhất ghi: danh mục `element`/`recipe` (upsert), `batch_content` (manifest, graph, `server_json`), `app_meta.current_version`, dòng `batch_run`, và xóa version ngoài 14 bản mới nhất. Lỗi ở bất kỳ câu nào ⇒ D1 hoàn tác cả batch ⇒ bản cũ giữ nguyên.
- Upsert hàng loạt bằng **một** câu lệnh mỗi bảng qua `json_each(?)` với tham số JSON (không ghép chuỗi SQL), vì D1 gói free giới hạn 50 câu truy vấn mỗi lần gọi Worker.
- Rollback = `POST /api/pipeline/rollback` đổi `current_version` sang bản còn lưu; workflow chạy tay gọi endpoint này.
- Phục vụ: `GET /api/manifest` (`max-age=60`, Worker thêm `policy_version`), `GET /api/graph/{version}` (`immutable`, đặt vào Cache API nên D1 chỉ bị đọc ở lần đầu mỗi vùng), `GET /api/blocklist` (`max-age=60`, `?fresh=1` bỏ cache).
- `server_json` (id phần tử khởi đầu, phần tử + depth, công thức `[id, a, b, result]`, id món Daily) không bao giờ được phục vụ ra ngoài; Worker parse một lần và giữ trong bộ nhớ isolate theo version. Bảng `block` được áp chồng lên khi kiểm.
- Nội dung là dữ liệu tái tạo được từ kho pipeline (`noi-dung-loi.json` + lịch sử Daily lấy từ `GET /api/pipeline/state`); D1 Time Travel là lưới an toàn cuối.

## Hệ quả
- D1 giới hạn 2 MB mỗi dòng ⇒ graph một version tối đa ~2 MB ≈ 10 000 công thức (ADR 0002: ~200 byte/mục). Lõi 363 công thức ≈ 75 KB; giai đoạn 2 phải theo dõi kích thước trong báo cáo đợt - chạm ~1 MB thì viết ADR chuyển graph sang R2/static assets.
- 14 bản × (graph + server_json) ≈ vài MB - nhỏ so với 5 GB của D1 free.
- Mẻ nhúng không cần quyền deploy Worker; token pipeline chỉ mở được `/api/pipeline/*` và `/api/metrics/summary`, không đọc được bảng người chơi (AC-PIPE-13).
- Đổi code Worker vẫn qua `/dk:ship` do người duyệt; đổi nội dung không cần.

## Phương án đã loại
- Static assets của Worker cho mỗi mẻ: phải `wrangler deploy` production từ cron 2 lần/ngày (deploy máy, không phải người), rollback chậm hơn và mỗi deploy mang theo code.
- R2: chưa rõ có đòi thẻ thanh toán (câu hỏi mở 13), thêm binding và quyền cho pipeline; xem lại ở giai đoạn 2 cùng ảnh.
- Workers KV: nhất quán sau tối đa ~60 s ⇒ rollback và chuyển version không nguyên tử với dữ liệu kiểm DISC/DAILY trong D1.
- Pipeline ghi thẳng D1 bằng `wrangler d1 execute --remote`: SQL sinh từ Python (trái quy tắc `prepare().bind()`), khó nguyên tử, token Cloudflare rộng hơn cần thiết.
