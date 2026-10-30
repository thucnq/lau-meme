# 0022 - Lưu nội dung bị chặn và cho admin sửa tay phần tử: bảng D1 riêng, pipeline áp bản sửa ở mọi mẻ

- Trạng thái: Đề xuất
- Ngày: 2026-10-30
- Nguồn: AC-MOD-11, AC-PIPE-12, AC-PIPE-21, AC-ADMIN-13..17; câu hỏi mở 94-98, 100

## Bối cảnh
- Trước đây khái niệm bị chặn ở kiểm duyệt bị bỏ đi, chỉ còn số đếm theo danh mục trong `stats`. Chủ dự án thấy phí: muốn lưu lại, xem, sửa tay, bỏ chặn hoặc duyệt luôn (góp ý 2026-10-30).
- Chủ dự án cũng muốn sửa mọi thuộc tính của meme trong mục "Nội dung". Mô tả, gợi ý Daily, gợi ý ảnh hiện chỉ nằm trong `pipeline_store` (ADR 0009) - Worker không đọc nội dung kho; bảng `element` chỉ có tên, emoji, nguồn gốc, ảnh.
- Id phần tử là băm của `fold(tên)` (ADR 0002). Đổi tên mà đổi id thì mất mọi Đĩa, lịch sử Daily, báo cáo, công thức trỏ tới phần tử.
- `admin_change.action` có `CHECK` liệt kê thao tác; SQLite không sửa `CHECK` được nếu không dựng lại bảng.
- Khái niệm bị chặn có thể nêu tên người thật và cáo buộc (lý do "bôi nhọ", "chính trị"): nội dung công khai crawl về, không phải dữ liệu người chơi, nhưng không nên để lâu hay lộ ra ngoài admin.

## Quyết định
- **Bị chặn:** bảng `rejected_concept` (migration `0012`), khóa `name_fold UNIQUE`. Pipeline gửi `rejected` kèm mẻ thành công; Worker upsert trong cùng `DB.batch` đăng mẻ (mẻ lỗi không ghi gì, AC-PIPE-11). Gặp lại cùng `fold`: `seen_count + 1`, cập nhật lần gặp cuối, gộp lý do (Worker đọc dòng cũ trước khi dựng batch). Trạng thái `blocked → unblocked → added`, hoặc `blocked|unblocked → approved`. Chỉ API quản trị đọc; dọn hằng ngày dòng có `last_seen_at` cũ hơn 90 ngày cùng cron dọn dữ liệu (AC-ADMIN-17), kể cả dòng `added` - audit vẫn giữ 12 tháng.
- **Bỏ chặn:** `/pipeline/state.unblocked` liệt kê dòng `unblocked`. Mẻ `full` đưa vào đầu hàng chờ, dùng trường admin đã sửa, trường null vẫn qua bước mô tả của Gemini, bỏ qua lớp 1 và lớp 2 (công thức mới quanh nó vẫn kiểm duyệt theo AC-MOD-04). Nối được thì gửi lại trong `rejected_added`, Worker chuyển dòng sang `added` cùng `DB.batch`. Không nối được hoặc hết quota thì dòng vẫn `unblocked`, mẻ sau đọc lại. Tên đang bị quản trị chặn (nguồn `admin`) không bỏ chặn được (409) - phải gỡ chặn tên trước.
- **Duyệt luôn:** như duyệt đề xuất meme (ADR 0013) nhưng nguồn là dòng bị chặn: `element_id` = ElementId của `fold(name)`, cặp `a_id <= b_id` (unique khi `approved`), tier tùy chọn ghi `element_tier`. Pipeline đọc `/pipeline/state.manual_approvals` và xử lý như `contributions`: không Gemini, không kiểm duyệt. Không gộp vào bảng `contribution` vì bảng đó gắn tài khoản, tên tối đa 40 ký tự và là dữ liệu cá nhân.
- **Sửa phần tử:** bảng `element_edit`, mỗi cột null = không sửa. Pipeline đọc `/pipeline/state.element_edits`, áp vào kho ở mọi mẻ và không ghi đè (như ảnh admin, ADR 0016). `rev` tăng mỗi lần lưu; mẻ đăng gửi lại `rev` đã áp (`element_edits_applied`), Worker đặt `applied_rev`. `applied_rev < rev` = "Chờ mẻ kế tiếp" - bản sửa lưu trong lúc mẻ chạy không bị đánh dấu nhầm là đã áp (cùng ý với `daily_pin_id`, ADR 0019).
- **Đổi tên giữ id:** đổi tên không đổi `element.id`; `fold` cũ vào `element_alias`, pipeline khử trùng khái niệm crawl có tên cũ vào phần tử đó (câu hỏi mở 94). Từ đây id của phần tử đã đổi tên không còn bằng băm của tên hiện tại - mọi nơi tra phần tử theo tên phải đi qua `name_fold` và `element_alias`, không tính lại băm. ADR 0002 vẫn đúng cho phần tử mới.
- **Hiện giá trị hiện hành:** `content.elements` gửi thêm `description`, `daily_hint`, `image_hint` (đã áp bản sửa); Worker ghi vào ba cột mới của `element`, để mục "Nội dung" hiện mà không phải đọc `pipeline_store`.
- **Audit:** bảng `content_change` (`edit_rejected`, `unblock_rejected`, `approve_rejected`, `edit_element`), append-only, giữ 12 tháng, `/admin/audit` đọc gộp. `edit_element` chỉ ghi các trường đã đổi.
- **Không dữ liệu người chơi:** `rejected_concept`, `element_edit` chỉ có nội dung meme công khai và trường admin nhập; không gửi gì của người chơi cho LLM (AC-PIPE-13).

## Hệ quả
- Contract 0.11.0: `GET/PATCH /admin/elements/{id}`, `GET /admin/rejected`, `GET/PATCH /admin/rejected/{id}`, `POST /admin/rejected/{id}/unblock`, `POST /admin/rejected/{id}/approve`; `PipelineState` thêm `element_edits`, `element_aliases`, `unblocked`, `manual_approvals`; `PublishBatchRequest` thêm `rejected`, `rejected_added`, `element_edits_applied`; `BatchStats` thêm `quota_exhausted`, `llm_splits`, `unblocked_added`; 4 thao tác audit mới.
- Thân `POST /pipeline/batches` lớn thêm tối đa 2 000 dòng bị chặn (≈ 2 MB nếu đủ ngữ cảnh 500 ký tự) - vẫn dưới trần 5 MB; nếu một đợt vượt, pipeline cắt `context` trước.
- Admin có thể đưa nội dung LLM đã chặn vào graph (bỏ chặn, duyệt luôn) mà không qua kiểm duyệt lại: admin được tin như khi tải tranh tay (câu 70) và chịu trách nhiệm; mọi thao tác có audit.
- Rollback (AC-GRAPH-05) không hoàn tác bản sửa, bỏ chặn hay duyệt luôn - các bảng này sống ngoài version, như `element_tier`.
- Chặn tên vĩnh viễn (AC-ADMIN-05) vẫn thắng: phần tử bị chặn không hiện dù có bản sửa.
- Pipeline phải đọc `element_aliases` khi khử trùng; quên bước này thì crawl lại tên cũ thành meme trùng (AC-ADMIN-16 bắt lỗi này).

## Phương án đã loại
- **Admin ghi thẳng vào `pipeline_store`:** kho là của pipeline (ADR 0009), mẻ sau ghi đè; phá ranh giới như đã loại ở ADR 0019.
- **Một bảng `admin_change` mới thay bảng cũ:** dựng lại bảng có dữ liệu audit là thay đổi phá hủy, trái expand-only.
- **Đổi tên = phần tử mới (id mới):** mất Đĩa, lịch sử Daily, báo cáo và công thức của người chơi; trái câu hỏi mở 94.
- **Gộp dòng bị chặn vào `contribution`:** khác chủ thể (không có tài khoản), khác giới hạn tên, khác vòng đời dữ liệu cá nhân.
- **Pipeline bỏ qua kiểm duyệt cho mọi `fold` đã từng bị chặn:** không gộp được lý do mới khi gặp lại (AC-MOD-11).
