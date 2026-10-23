# 0013 - Đóng góp meme và tier lưu ở D1, pipeline đọc khi lên mẻ, Worker chụp tên người tạo

- Trạng thái: Đề xuất
- Ngày: 2026-10-23
- Nguồn: CONTRIB (AC-CONTRIB-01..12), TIER (AC-TIER-01..03), AC-ADMIN-11/12, AC-PIPE-16, AC-DAILY-01/12/18; câu hỏi mở 42, 45, 46, 53, 55, 56

## Bối cảnh
- Graph do pipeline dựng và mã hóa (ADR 0002), đăng qua `POST /api/pipeline/batches` (ADR 0003). Worker không sửa graph đang phục vụ.
- Đề xuất meme và tier lại sinh ra ở phía Worker: thực khách gửi đề xuất, admin duyệt và gán tier. Cả hai phải vào graph từ mẻ kế tiếp (AC-CONTRIB-08, câu hỏi mở 53).
- Phần tử đóng góp phải hiện "Meme của <nickname>" theo nickname hiện tại, đổi từ mẻ kế tiếp, và graph không chứa mã tài khoản (AC-CONTRIB-10).
- Token pipeline không được đọc dữ liệu người chơi (ADR 0003, AC-PIPE-13). Nội dung đề xuất chưa duyệt không được gửi cho LLM (câu hỏi mở 46). Sau khi duyệt, tên và gợi ý ảnh là nội dung game (câu hỏi mở 55).
- Chọn Món đặc biệt cần "mặn" (`trend_peak`) và "mới" (mẻ đầu có mặt) cho **mọi** phần tử, kể cả ở mẻ `core` (AC-DAILY-01/18). Mẻ `core` không có kho pipeline (ADR 0009).
- `admin_audit` có CHECK chỉ nhận các trạng thái kiểm duyệt. SQLite không sửa được CHECK, và migration phải expand-only.

## Quyết định
- **Đề xuất ở D1:** bảng `contribution` (migration `0007_contrib_tier.sql`).
  - Duyệt chỉ đổi trạng thái và ghi `element_id` = ElementId của `fold(tên)`. Không ghi `element`/`recipe`: danh mục vẫn chỉ do mẻ đăng cập nhật.
  - Index unique một phần chặn trùng: một đề xuất chờ duyệt mỗi tài khoản mỗi cặp; một đề xuất đã duyệt mỗi cặp; một đề xuất đã duyệt mỗi tên.
- **Tier ở D1:** bảng `element_tier`. Không có dòng nghĩa là tier 1.
- **Pipeline đọc qua `GET /api/pipeline/state`**, thêm 3 trường:
  - `catalog`: mỗi phần tử có `first_version` và `trend_peak`.
  - `tiers`: tier admin đã gán.
  - `contributions`: đề xuất đã duyệt, chỉ gồm `element_id`, tên, emoji, cặp, gợi ý ảnh của admin, thời điểm duyệt. Không có mô tả, link ảnh gốc, tài khoản hay nickname.
  - Pipeline đưa tier vào bản rõ của mỗi mục graph (`GraphResult.tier`). Đề xuất đi vào kho như phần tử mới: tính depth bằng BFS, qua INV, cha bị ẩn thì chưa vào graph.
- **Bản chụp người tạo do Worker dựng:** khi đăng mẻ, trong cùng `DB.batch`, Worker ghi `batch_content.creators_json` = `{element_id: nickname | null}` cho các phần tử đóng góp có trong version.
  - Phục vụ ở `GET /api/creators/{version}` (`max-age=300`).
  - Pipeline không bao giờ thấy nickname. Đổi nickname thì hiện tên mới từ mẻ kế tiếp.
- **Xóa tài khoản** (AC-CONTRIB-12), cùng `DB.batch` với phần xóa của AC-AUTH-06:
  - Xóa đề xuất chờ duyệt. Đề xuất còn lại bỏ gắn tài khoản qua `ON DELETE SET NULL`.
  - Đặt mục của tài khoản thành `null` trong `creators_json` của mọi version còn lưu.
  - Như vậy nickname đã xóa không nằm lại trong 14 bản. Endpoint creators không bất biến vì lý do này. Kết quả chặt hơn mặc định "từ mẻ kế tiếp" của câu hỏi mở 56, và không trái nó.
- **Mức mặn ở danh mục:** cột `element.trend_peak` (nullable), cập nhật từ `content.elements[].trend_peak` khi đăng mẻ.
  - Mẻ `core` đọc `catalog` rồi gửi lại nguyên giá trị.
  - "Mới" lấy từ `element.first_version` đã có.
  - Không để trong `pipeline_store`, vì mẻ `core` không có kho.
- **Audit mở rộng:** bảng `admin_change` cho `set_tier` và sửa/duyệt/từ chối đề xuất, trước/sau dạng JSON. `GET /api/admin/audit` gộp hai bảng theo thời điểm. Giữ 12 tháng như `admin_audit`.
- **Thống kê crawl (AC-ADMIN-11)** nằm trong `batch_run.stats_json` sẵn có, schema `BatchStats` thêm trường. Ô tổng do Worker cộng từ các đợt `full` thành công. Không thêm bảng.
- **Lịch mẻ (AC-DAILY-12):** manifest thêm `schedule_hours_utc`, lấy từ `BATCH_HOURS_UTC` của môi trường. Manifest cũ không có trường này thì client coi như [5, 17].

## Hệ quả
- Một migration: 3 bảng, 2 cột nullable. Thêm 9 endpoint: 5 cho thực khách/công khai, 4 cho quản trị cộng gán tier. Thêm 3 trường trong `PipelineState`.
- Duyệt là thao tác D1 thuần, nên admin không cần chờ pipeline. Người gửi thấy "Đã duyệt" ngay, còn meme lên game ở mẻ kế tiếp (staging 2 tiếng, production 12 tiếng).
- Worker phải tính ElementId (`lm1|e|` + `fold`) giống hệt pipeline và web. Test chéo dùng cùng bộ ví dụ với `pipeline/tests/test_graph.py`.
- `GET /api/creators/{version}` cho biết phần tử nào (theo id băm) là meme đóng góp, kèm nickname, nhưng không lộ tên phần tử. Nickname vốn đã công khai trên bảng xếp hạng.
- Hai bảng audit thay vì một. Trang quản trị và API đọc gộp, nên người xem không thấy khác biệt.

## Phương án đã loại
- **Pipeline đọc nickname và đưa vào graph:** token pipeline sẽ đọc được dữ liệu người chơi (trái ADR 0003, AC-PIPE-13), và nickname nằm trong graph bất biến, không xóa được khi tài khoản bị xóa.
- **Creators sống (truy vấn D1 mỗi lần):** đổi nickname sẽ hiện ngay, trái AC-CONTRIB-10 ("từ mẻ kế tiếp"), và mỗi lần mở game thêm một truy vấn.
- **Duyệt ghi thẳng `element`/`recipe`:** danh mục sẽ có phần tử chưa từng đăng, làm lệch `first_version`/`last_version` và kiểm DISC/DAILY theo version.
- **Tier trong `pipeline_store`:** mẻ `core` không có kho, và Worker không đọc kho (ADR 0009), nên admin không gán được.
- **Bảng `admin_audit` mới thay bảng cũ (copy rồi đổi tên):** không phải expand-only, mất tính append-only của dữ liệu audit cũ.
