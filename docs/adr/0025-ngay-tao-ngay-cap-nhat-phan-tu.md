# 0025 - Ngày tạo, ngày cập nhật của phần tử: thêm `created_at`, `updated_at` chỉ đổi khi giá trị thật sự khác

- Trạng thái: Đã chấp nhận (2026-10-31, cổng contract duyệt tại 4778433)
- Ngày: 2026-10-31
- Nguồn: AC-ADMIN-19, AC-ADMIN-20; câu hỏi mở 105

## Bối cảnh
- Mục "Nội dung" cần sắp xếp theo ngày tạo và ngày cập nhật (AC-ADMIN-19). Bảng `element` (migration `0002`) không có cột ngày tạo, chỉ có `first_version`.
- `element.updated_at` hiện đặt lại cho **mọi** phần tử ở mỗi mẻ: lệnh upsert của `POST /pipeline/batches` gửi cả danh mục và luôn ghi `updated_at = now`. Sắp xếp theo cột này thì mọi phần tử cùng một giá trị.
- Lệnh ghi của admin không đụng `element`: tier ở `element_tier`, bản sửa ở `element_edit`, ẩn/hiện/chặn ở `block`, ảnh tay ở `admin_image_change` + `element.image_key`.
- Chủ dự án chốt (câu hỏi mở 105): ngày cập nhật đổi theo mọi lệnh ghi của admin lên phần tử hoặc ảnh của nó, mẻ chỉ đổi khi giá trị thật sự khác; phần tử cũ lấy ngày tạo theo mẻ đầu tiên có nó.

## Quyết định
- **Ngày tạo:** cột mới `element.created_at` (migration `0013`, nullable vì expand-only). Upsert chỉ đặt khi chèn dòng mới (`now` của lần đăng mẻ), nhánh `ON CONFLICT DO UPDATE` không đụng. Phần tử có sẵn được điền một lần trong migration bằng `batch_run.created_at` của `first_version`, thiếu dòng đó thì lấy `updated_at`. API đọc `COALESCE(created_at, updated_at)` nên `created_at` trả về không bao giờ null, đúng contract.
- **Ngày cập nhật:** giữ cột `updated_at`, đổi nghĩa thay vì thêm cột thứ ba - không còn chỗ nào đọc nghĩa cũ (nghĩa "mẻ gần nhất ghi lại" đã có ở `last_version`).
  - Mẻ: `updated_at = CASE WHEN <một cột khác giá trị> THEN now ELSE element.updated_at END`, so bằng `IS NOT` (đúng cả với null) trên mọi cột mẻ ghi: `name`, `name_fold`, `emoji`, `depth`, `origin`, `image_key` và `image_source` hiệu lực, `trend_peak`, `auto_tier`, `description`, `daily_hint`, `image_hint` (giá trị sau `COALESCE`). SQLite tính mọi biểu thức `SET` trên dòng cũ nên so được trong cùng một lệnh. `last_version` vẫn đổi mỗi mẻ và không tính là thay đổi.
  - Admin: mọi lệnh ghi thành công lên phần tử hoặc ảnh của nó (`PATCH /admin/elements/{id}`, gán / trả tier, tải ảnh tay, ẩn / hiện / chặn / gỡ chặn phần tử hoặc ảnh) thêm `UPDATE element SET updated_at = ?` vào cùng `DB.batch` với audit. Lệnh 4xx không ghi gì, như audit.
  - "Bỏ qua báo cáo" (`dismiss_reports`) chỉ đổi ngày cập nhật khi nó gỡ được một lần tự ẩn (trạng thái đổi); chỉ đóng báo cáo thì phần tử và ảnh không đổi nên ngày cập nhật giữ nguyên.
  - Tự ẩn do 3 báo cáo của thực khách (AC-REPORT-03) không phải lệnh của admin nên không đổi ngày cập nhật.
- **Sắp xếp và lọc:** `GET /admin/elements` thêm `sort` (`name|created|updated|depth|tier`), `order` (`asc|desc`), `image` (`none|active|hidden`); mặc định `name asc` như cũ. Khóa phụ luôn `name_fold, id` tăng dần. Tier là tier hiệu lực `COALESCE(element_tier.tier, auto_tier, 1)` - tính khi truy vấn, không có index; danh mục vài nghìn dòng nên chấp nhận được. `ORDER BY` là một `CASE` cố định trong câu SQL, khóa và chiều sắp xếp đi vào bằng `bind` (giá trị lạ đã bị 400 trước đó); không ghép chuỗi vào SQL, kể cả hằng trong code (lint `no-restricted-syntax`). Vì vậy SQLite không dùng index cho sắp xếp. Migration `0013` đã tạo `element_created`, `element_updated`, `element_depth` trước khi biết điều này; hiện chưa truy vấn nào dùng chúng, nhưng migration đã commit thì không sửa và expand-only thì không xóa, nên giữ lại (chi phí ghi nhỏ với vài nghìn dòng).
- **Ảnh:** "Đang ẩn" là mọi dòng `block` loại `image` (ẩn hoặc chặn), đúng `image_state` đang trả về; ảnh ẩn không tính là "Chưa có ảnh".

## Hệ quả
- Contract 0.12.0: `GET /admin/elements` thêm 3 tham số; mỗi dòng thêm `created_at`, `updated_at` (ISO 8601).
- Sau migration, mọi phần tử cũ có cùng `updated_at` (mẻ gần nhất) cho tới khi mẻ hoặc admin đổi chúng - đúng với định nghĩa mới, chỉ là chưa phân biệt được lịch sử trước đó.
- Thêm một lệnh `UPDATE` vào mỗi `DB.batch` ghi của admin; quên ở lệnh ghi mới nào thì AC-ADMIN-19 bắt (test liệt kê đủ các loại lệnh ghi).
- Rollback (AC-GRAPH-05) không trả `updated_at` về giá trị cũ; mẻ đăng sau rollback đổi giá trị thì `updated_at` đổi.

## Phương án đã loại
- **Thêm cột `changed_at` riêng, giữ nghĩa cũ của `updated_at`:** thừa một cột vì không ai đọc nghĩa cũ; hai cột tên gần nhau dễ dùng nhầm.
- **Tính ngày cập nhật lúc truy vấn (MAX của `element_tier.updated_at`, `element_edit.updated_at`, `block.created_at`, audit):** `block` bị xóa khi "hiện" nên mất mốc; truy vấn sắp xếp phải gộp 5 bảng, không index được; không biết khi nào mẻ đổi giá trị.
- **Pipeline tự so sánh và gửi cờ "đã đổi":** pipeline không giữ bản `element` của D1; Worker đã có dòng cũ ngay trong lệnh upsert.
