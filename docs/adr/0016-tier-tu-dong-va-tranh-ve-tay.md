# 0016 - Tier tự động tính ở pipeline, tranh vẽ tay chuẩn hóa ở trình duyệt quản trị

- Trạng thái: Đề xuất
- Ngày: 2026-10-24
- Nguồn: AC-TIER-01/02/04/05, AC-ADMIN-12, AC-ART-12/13; câu hỏi mở 67, 69, 70

## Bối cảnh
- Tier đổi từ "admin gán, mặc định Xám" (ADR 0013) sang "mặc định theo độ sâu, admin sửa được" (AC-TIER-04/05).
- Độ sâu tính bằng BFS trong pipeline mỗi mẻ (AC-PIPE-07). Luật "Vàng/Đỏ phải có ảnh" cần biết ảnh nào đang dùng được: có `image_key`, không bị chặn, và gồm cả ảnh admin tải.
- Trang quản trị phải hiện tier hiện tại, nguồn tier và tier tự động. Gán 4/5 cho món chưa có ảnh trả 409.
- Tranh vẽ tay (AC-ART-13, Tùy chọn) phải thành WebP 256×256 như ảnh Workers AI (AC-ART-04). Worker không có thư viện đổi định dạng ảnh. Cloudflare Images tính phí theo lượt.

## Quyết định
- **Luật tier tự động chỉ nằm ở pipeline** (hàm thuần trong `pipeline`, test theo AC-TIER-04):
  - Độ sâu 0-2 → 1; 3 → 2; 4 → 3; 5-6 → 4; ≥ 7 → 5 (câu hỏi mở 67).
  - Tính ra 4 hoặc 5 mà không có ảnh dùng được → 3 (câu hỏi mở 69).
  - Tier admin gán (`PipelineState.tiers`) thắng tier tự động. Graph mang tier hiệu lực.
- **Pipeline gửi `content.elements[].auto_tier`** khi đăng mẻ. Worker lưu vào `element.auto_tier` để trang quản trị hiện "tier tự động" và nguồn tier mà không chép lại luật sang TypeScript.
- **"Tự động" = xóa dòng `element_tier`:** `PUT /admin/elements/{id}/tier` nhận `"auto"`. Audit vẫn là `set_tier`, trước/sau dạng `{tier, source}`.
- **409 ở Worker:** gán 4/5 khi `element.image_key` rỗng hoặc ảnh của phần tử đang ẩn/chặn. Chỉ kiểm điều kiện ảnh, không cần luật độ sâu.
- **Thứ tự vẽ (AC-ART-12)** nằm ở pipeline. Báo cáo đợt liệt kê món admin gán Vàng/Đỏ mà mất ảnh.
- **Tranh vẽ tay:**
  - Trang quản trị nhận PNG/WebP ≤ 1 MB, dùng canvas của trình duyệt cắt giữa và thu về 256×256, xuất `image/webp`, rồi gửi `PUT /admin/elements/{id}/image`.
  - Worker chỉ kiểm: ≤ 1 MB, chữ ký WebP, kích thước 256×256 trong header VP8/VP8L/VP8X. Sai thì 400.
  - Ghi R2 theo băm nội dung (ADR 0012). Đặt `element.image_key`, `image_source = 'admin'`, ghi `admin_image_change` trong một `DB.batch`.
- **Ảnh admin không bị vẽ đè:** `PipelineState.admin_images` cho pipeline dùng nguyên khóa và bỏ qua bước vẽ. Khi đăng mẻ, Worker giữ `image_key` của phần tử `image_source = 'admin'` dù pipeline gửi gì.
- **Audit ảnh ở bảng mới `admin_image_change`:** CHECK của `admin_change` không có hành động ảnh, và SQLite không nới được CHECK (như ADR 0013). `GET /admin/audit` gộp ba bảng, hành động `set_image`.

## Hệ quả
- Migration `0008`: 2 cột nullable trên `element`, 1 bảng audit. `PipelineState` thêm `admin_images`, `BatchContent.elements` thêm `auto_tier`.
- `auto_tier` trên trang quản trị là giá trị của mẻ gần nhất. Độ sâu hoặc ảnh đổi thì tier tự động mới hiện sau mẻ kế tiếp, giống mọi thay đổi tier khác (câu hỏi mở 53).
- Ảnh admin tải không qua kiểm duyệt LLM (câu hỏi mở 70): người tải là admin, chịu trách nhiệm nội dung. Báo cáo/chặn ảnh (AC-REPORT) vẫn áp dụng như ảnh Workers AI.
- Gọi trực tiếp API bằng file PNG sẽ bị 400. Chỉ trang quản trị (đã chuẩn hóa) tải được.
- (Thêm 2026-10-25 khi build) Host quản trị phục vụ `/lau-meme/img/*` (GET/HEAD, cùng handler với host game). CSP của trang quản trị là `default-src 'self'`, nên trang chỉ hiện được ảnh lấy từ chính host quản trị. Đây là ngoại lệ duy nhất thêm vào danh sách đường dẫn của ADR 0008.

## Phương án đã loại
- **Tính tier tự động trong Worker (SQL hoặc TypeScript):** chép luật sang ngôn ngữ thứ hai, hai nơi có thể lệch nhau. Worker cũng không có độ sâu BFS của mẻ đang dựng.
- **Lưu tier tự động vào `element_tier`:** mất phân biệt "admin gán" và "tự động", không làm được AC-TIER-05.
- **Đổi định dạng ảnh trong Worker bằng WASM (vd. Squoosh/libwebp):** bundle lớn, tốn CPU vượt giới hạn gói free cho một tác vụ hiếm.
- **Cloudflare Images:** dịch vụ trả phí, không đáng cho vài ảnh tay.
