# 0018 - Link ảnh của đề xuất làm ảnh món: pipeline tải ở mẻ full, Worker đánh dấu ảnh admin

- Trạng thái: Đề xuất
- Ngày: 2026-10-25
- Nguồn: AC-ART-14, AC-CONTRIB-07/09, AC-ART-13; câu hỏi mở 46 (đổi 2026-10-25)

## Bối cảnh
- Câu 46 cũ: link ảnh của đề xuất chỉ để admin tham khảo. Chủ dự án đổi (2026-10-25): khi duyệt, admin có thể chọn dùng link đó làm ảnh món, chỉ cho link của đề xuất đóng góp.
- Ảnh trong game phải là WebP 256×256 theo băm nội dung (AC-ART-04). Worker không giải mã được ảnh (ADR 0016). Trang quản trị không tải được ảnh ngoài vào canvas: CSP `default-src 'self'` và phần lớn máy chủ ảnh không có CORS.
- Pipeline đã có `to_webp_256` (Pillow, giới hạn kích thước và số điểm ảnh) và đường tải ảnh lên R2 (`PUT /pipeline/images/{key}`).

## Quyết định
- **Lựa chọn lưu lúc duyệt:** `POST /admin/contributions/{id}/approve` nhận `use_image_url` (mặc định `false`). `true` mà đề xuất không có link → 400. Lưu ở cột mới `contribution.use_image_url` (migration `0009`, thêm cột có mặc định, expand-only). Audit `approve_contribution` ghi kèm giá trị này.
- **Pipeline tải ở mẻ `full`:**
  - `PipelineState.image_links` = các đề xuất đã duyệt có `use_image_url = 1` mà phần tử chưa có ảnh admin: `{element_id, url}`.
  - Adapter mạng riêng (mock trong test): chỉ `https://`, tối đa 1 MB, hết giờ 15 giây, tối đa 3 lần chuyển hướng và mỗi lần đều kiểm lại. Phân giải tên miền rồi từ chối địa chỉ loopback, riêng, link-local, dành riêng.
  - Thành công: `to_webp_256`, tải lên R2 như ảnh vẽ, gắn `image_key` vào phần tử trong mẻ đó.
  - Phần tử có trong `image_links` không bao giờ được vẽ bằng Workers AI. Link lỗi thì giữ emoji, mẻ sau thử lại; báo cáo đợt chỉ ghi số đếm "Link ảnh lỗi: N".
  - Link không bao giờ gửi cho Gemini hay ghi vào log/Issue.
- **Worker đánh dấu `image_source = 'admin'`** khi đăng mẻ: phần tử là đề xuất đã duyệt có `use_image_url = 1` và mẻ gửi `image_key` khác null. Từ đó phần tử nằm trong `admin_images`, mẻ sau không vẽ đè (ADR 0016), và rời khỏi `image_links`.
  - Pipeline không tự khai nguồn ảnh: Worker suy ra từ D1, nên token pipeline không biến được ảnh vẽ thành ảnh admin.
- **Trang quản trị:** hộp chọn "Dùng link làm ảnh" trong form duyệt, chỉ bật khi đề xuất có link. Link vẫn hiện dạng chữ, không nhúng.

## Hệ quả
- Contract 0.6.0: `use_image_url` trong yêu cầu duyệt và `AdminContribution`; `PipelineState.image_links`.
- `PipelineState` có link do người chơi gửi (đã qua admin duyệt). Đây là nội dung game sau duyệt như tên và gợi ý ảnh (câu 55), không phải dữ liệu tài khoản; pipeline không gửi nó cho LLM.
- Ảnh từ link không qua kiểm duyệt LLM; admin chịu trách nhiệm nội dung và bản quyền như tranh tải tay (câu 70).
- Ảnh chỉ có từ mẻ `full` kế tiếp (staging 2 tiếng, production 12 tiếng). Mẻ `core` không tải link.
