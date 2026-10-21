# 0009 - Kho pipeline giai đoạn 2 lưu trong D1, đăng cùng mẻ

- Trạng thái: Đề xuất (chờ người duyệt - thêm endpoint, trường và migration)
- Ngày: 2026-10-20
- Nguồn: PIPE giai đoạn 2 (AC-PIPE-03..10, 12), MOD (AC-MOD-08/10), INV (AC-INV-03/05/06)

## Bối cảnh
Giai đoạn 1 không cần nhớ gì giữa các mẻ: mỗi mẻ nạp lại lõi `noi-dung-loi.json` và chỉ đổi Món đặc biệt (ADR 0003). Giai đoạn 2 cần nhớ những thứ sau qua nhiều mẻ:
- **Kho nội dung trend:** phần tử và công thức đã thêm, điểm giám khảo, nguồn, cờ hoãn `held_until` (AC-MOD-08), cờ gợi ý đạt `hint_ok` / `image_hint_ok` (AC-MOD-04).
- **Hàng chờ meme chưa nối được:** kèm số lần thử (AC-PIPE-07), và khái niệm dừng vì hết quota (AC-PIPE-12, AC-MOD-03).
- **Phản hồi LLM của mẻ:** để chạy lại đúng mẻ đó cho kết quả giống hệt từng byte, không gọi LLM lại (AC-PIPE-10, AC-INV-05).
- **Tên quản trị đã chặn:** tách riêng khỏi bí danh do MOD sinh, để báo cáo đếm "đã bị chặn" (AC-MOD-10).

GitHub Actions không giữ file giữa các lần chạy. Repo có thể công khai nên không commit kho này vào git, vì kho chứa công thức đọc được, đúng thứ ADR 0002 mã hóa trong graph.

## Quyết định
- **Bảng mới** `pipeline_store` (migration `0005_pipeline_store.sql`, expand-only):
  - Cột: `version INTEGER PRIMARY KEY` (version mẻ ghi), `store_json TEXT NOT NULL CHECK (json_valid(store_json))`, `created_at INTEGER NOT NULL`.
  - Giữ 14 bản như `batch_content` (AC-GRAPH-05), để rollback nội dung cũng có kho tương ứng.
- **Ghi nguyên tử cùng mẻ:** `POST /api/pipeline/batches` (status `success`) nhận thêm trường tùy chọn `store`, ghi trong **cùng** `DB.batch` với `batch_content`. Lỗi giữa chừng thì không có gì đổi (AC-PIPE-11, AC-INV-06). Mẻ chế độ `core` không gửi `store`.
- **Đọc:** `GET /api/pipeline/store` (token pipeline) trả `store_json` của version hiện hành. Chưa có thì trả `{}`. Sau rollback thì trả kho của version đã quay về.
- **`GET /api/pipeline/state`** thêm `admin_blocked` (`fold` các tên do quản trị chặn, nguồn `admin`). `banned_aliases` vẫn gồm `mod` và `admin` như trước, để không phá client cũ.
- **Nội dung `store_json`** (schema `PipelineStore` trong contract; pipeline là nơi duy nhất hiểu chi tiết):
  - `elements` (trend): id, tên, emoji, mô tả, gợi ý Daily/ảnh, `hint_ok`, `image_hint_ok`, `held_until`, nguồn, `added_version`.
  - `recipes` (trend và bổ sung): id, a, b, kết quả, `score`.
  - `queue`: khái niệm, `attempts`, `reason` (`unlinked` / `quota`).
  - `llm_cache`: chỉ của mẻ ghi, khóa = `sha256(bước + payload)`. Không giữ cache của mẻ cũ, để kho không phình.
- **Kích thước:** D1 giới hạn 2 MB mỗi dòng. Báo cáo đợt ghi kích thước kho; tới ~1 MB thì viết ADR chuyển kho sang R2, cùng lúc với graph (ADR 0003).
- **Phản hồi LLM gửi đi** vẫn chỉ gồm trường công khai của meme. Danh sách trường cho phép (AC-PIPE-13, `ALLOWED_LLM_FIELDS`) mở rộng thêm `key`, `kind`, `emoji`, `description`, `daily_hint` mà kiểm duyệt cần (AC-MOD-04). Test AC-PIPE-13 đang so khớp đúng tập cũ, nên phải sửa test theo, và việc đó cần người duyệt.

## Hệ quả
- Một migration, một endpoint đọc, một trường ghi và một trường mới trong `PipelineState`. Worker không cần hiểu nội dung kho, chỉ lưu và trả lại.
- Chạy lại đúng mẻ (cùng `batch_at`) đọc lại kho trước mẻ đó qua `GET /api/pipeline/store?version=<trước>`, nếu version đó còn trong 14 bản, cùng `llm_cache` đã lưu. Muốn vậy endpoint phải nhận tham số `version`.
- Token pipeline đọc được kho chứa tên công thức. Kho không chứa dữ liệu người chơi (AC-PIPE-13).

## Phương án đã loại
- **Commit kho vào nhánh git riêng:** repo có thể công khai, nên lộ công thức đọc được.
- **Cache/artifact của GitHub Actions:** hết hạn (artifact 90 ngày, cache bị dọn khi không dùng), không nguyên tử với mẻ đăng.
- **Bảng D1 chuẩn hóa** (hàng chờ, cache LLM, cờ phần tử thành nhiều bảng): Worker phải hiểu từng trường mà không dùng tới, và mỗi đổi kho lại thêm migration. Có thể làm sau, khi admin cần xem hàng chờ.
- **Lưu ở R2:** không nguyên tử với D1: kho và `batch_content` phải ghi cùng một `DB.batch` (AC-PIPE-11, AC-INV-06), ghi R2 rồi ghi D1 thì lỗi giữa chừng để lại kho lệch mẻ. (Cập nhật 2026-10-21: lý do "chưa chốt thẻ thanh toán" không còn, câu hỏi mở 13 đã trả lời là bật R2 không bị đòi thẻ. R2 vẫn dùng cho ảnh ART.)
