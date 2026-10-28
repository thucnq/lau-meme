# 0020 - Tên Món đặc biệt nằm trong manifest để nút "Xem đáp án" lộ tên không cần API mới

- Trạng thái: Đề xuất
- Ngày: 2026-10-27
- Nguồn: AC-DAILY-20, AC-DAILY-03 (cập nhật 2026-10-27); câu hỏi mở 86. Thay dòng "Món đặc biệt" trong bảng của ADR 0002.

## Bối cảnh
- ADR 0002 giữ manifest không có tên Món đặc biệt: client chỉ có `element_id`, tên lộ ra khi ghép ra món và giải mã được mục graph.
- Góp ý từ người chơi: game khó, bắt đầu từ gợi ý càng khó. Chủ dự án chốt (2026-10-27): thêm nút "Xem đáp án", chỉ lộ tên, xem rồi ghép ra vẫn tính giải, xếp hạng và streak như thường.
- Vì xem đáp án không bị trừ gì, giữ bí mật tên với người đọc mã nguồn trang không còn bảo vệ được luật nào: ai muốn tên thì bấm nút là có.

## Quyết định
- `manifest.daily.name` (contract 0.9.0): tên món dạng rõ. Pipeline `build_daily_block` ghi trường này cho cả mẻ `core` và `full`, kể cả món admin chỉ định (ADR 0019).
- Worker khi nhận `POST /pipeline/batches` kiểm `manifest.daily.name` bằng đúng `name` của phần tử `content.daily_element_id`, sai → 422. Không có `name` thì vẫn nhận (pipeline cũ), nên phải deploy Worker trước rồi mới chạy mẻ có `name`.
- Web: thẻ hiện "???" cho tới khi giải hoặc thực khách xác nhận xem; trạng thái đã xem lưu cục bộ theo version mẻ (`localStorage`, tiền tố `laumeme:` như AC-DAILY-05), sang mẻ mới thì bỏ. Manifest không có `name` (đăng trước 2026-10-27) thì không hiện nút.
- Không ghi sự kiện "đã xem" lên server: AC-DAILY-20 không cần số liệu này và xem không ảnh hưởng xếp hạng.

## Hệ quả
- Tên món đọc được trong phản hồi `/manifest`, bộ nhớ đệm CDN và công cụ dev của trình duyệt. Chấp nhận vì nút đã lộ tên cho bất kỳ ai.
- Graph vẫn mã hóa như ADR 0002: cây công thức không lộ, biết tên món chưa biết được cặp ghép ra nó.
- Thẻ chia sẻ (SHARE) vẫn không in tên: không đổi.

## Phương án đã loại
- API riêng `GET /daily/{version}/name`: thêm một endpoint, rate limit và test chỉ để trả đúng một chuỗi đã công khai cho mọi người bấm nút; không bảo vệ thêm được gì.
- Mã hóa tên trong manifest bằng khóa client tự có: khóa phải nằm trong bundle nên chỉ là làm rối, vi phạm tinh thần AC-GRAPH-03 mà không chặn được ai.
