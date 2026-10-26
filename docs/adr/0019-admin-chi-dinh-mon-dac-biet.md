# 0019 - Admin chỉ định Món đặc biệt cho mẻ kế tiếp: một dòng D1, mẻ gửi lại id để xóa

- Trạng thái: Đề xuất
- Ngày: 2026-10-26
- Nguồn: AC-DAILY-19, AC-DAILY-01/03/18, AC-ADMIN-09; câu hỏi mở 83

## Bối cảnh
- Món đặc biệt do pipeline tự chọn (AC-DAILY-01): mặn trước, rồi mới, không lặp 30 mẻ, tất định theo version. Không có lối chọn tay.
- Chủ dự án chốt (2026-10-26): admin chỉ định được một món bất kỳ đang hoạt động, chưa bị chặn, kèm gợi ý tự nhập; chỉ áp cho một mẻ kế tiếp; cả staging và production.
- Mẻ chạy trên GitHub Actions, đọc trạng thái qua `/pipeline/state` rồi đăng qua `POST /pipeline/batches`. Giữa hai lần gọi có thể vài phút (mẻ `full`), admin có thể đặt lại chỉ định trong lúc đó.
- `admin_change.action` có `CHECK` liệt kê thao tác; SQLite không sửa `CHECK` được nếu không dựng lại bảng (không expand-only).

## Quyết định
- **Lưu:** bảng `daily_pin` (migration `0010`), tối đa một dòng (`slot = 1 UNIQUE`). Mỗi lần đặt thay dòng cũ bằng `id` UUIDv7 mới.
- **Admin API:** `GET/PUT/DELETE /admin/daily-pin`.
  - PUT kiểm: phần tử có trong `element` (không có → 404), không bị chặn (→ 400), `hint` 1-200 ký tự sau khi bỏ khoảng trắng, không chứa tên món theo `fold` nguyên từ như `build_daily_block` của pipeline (→ 400). Không xét depth, gợi ý lõi, độ mặn hay luật 30 mẻ.
  - Thành công ghi trong cùng `DB.batch` 1 dòng `daily_pin_change` (`set_daily_pin` / `clear_daily_pin`, trước/sau dạng JSON). Bảng audit riêng như `admin_image_change` vì `admin_change` không thêm thao tác được. `/admin/audit` đọc gộp cả bảng này. Giữ 12 tháng.
- **Pipeline:** `PipelineState.daily_pin = {id, element_id, hint} | null`. Ở cả `core` và `full`, nếu phần tử còn trong kho, đang hoạt động và không bị chặn thì mẻ dùng nó với gợi ý admin (vẫn qua `build_daily_block`), bỏ qua `pick_daily`; không thì bỏ chỉ định và tự chọn như thường. `stats.daily_pin = used | dropped`, báo cáo đợt ghi "Chỉ định Món đặc biệt bị bỏ" khi `dropped`. Lịch sử Món đặc biệt vẫn ghi món đã dùng, nên các mẻ sau tính luật 30 mẻ như thường.
- **Xóa sau mẻ:** mẻ thành công gửi `daily_pin_id` (id đã đọc). Worker xóa `daily_pin WHERE id = ?` trong cùng `DB.batch` đăng mẻ. Chỉ định đặt lại trong lúc mẻ chạy có id khác nên được giữ cho mẻ sau. Mẻ lỗi không gửi id, chỉ định còn nguyên. Khi `stats.daily_pin = used` mà dòng còn, Worker kiểm `content.daily_element_id` bằng `element_id` của chỉ định, không thì 422, để token pipeline không xóa được chỉ định mà không dùng nó.

## Hệ quả
- Contract 0.7.0: `/admin/daily-pin`, `DailyPin`, `PipelineState.daily_pin`, `PublishBatchRequest.daily_pin_id`, `BatchStats.daily_pin`, hai thao tác audit mới.
- Pipeline vẫn thuần: chỉ định đi vào như một phần của `state`, cùng state + version thì cùng kết quả.
- Món chỉ định có thể depth thấp (giải rất nhanh) hoặc vừa là Món đặc biệt gần đây; đó là chủ ý của chủ dự án (câu 83).
- Rollback (AC-GRAPH-05) trả về manifest cũ, không khôi phục chỉ định đã dùng.

## Phương án đã loại
- **Input của workflow (`gh workflow run -f daily=...`):** không có audit trong D1, gợi ý không được Worker kiểm, cron không đọc được, chỉ người có quyền repo dùng được.
- **Ghi chỉ định vào `pipeline_store`:** kho là của pipeline (ADR 0009), Worker không đọc nội dung; admin ghi vào đó sẽ phá ranh giới.
- **Xóa chỉ định ngay khi pipeline đọc state:** mẻ lỗi sau đó làm mất chỉ định, trái AC-DAILY-19.
- **Xóa theo `element_id` thay vì `id`:** admin đặt lại cùng món với gợi ý khác trong lúc mẻ chạy thì gợi ý mới bị xóa oan.
