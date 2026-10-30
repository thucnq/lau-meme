# 0024 - Job tìm ảnh trên web cho meme chưa có ảnh, gắn qua API quản trị

- Trạng thái: Đề xuất
- Ngày: 2026-10-30
- Nguồn: AC-ART-15; AC-ART-13, AC-ART-14; câu hỏi mở 104

## Bối cảnh
- Nhiều meme đang hoạt động vẫn chỉ có emoji: Workers AI vẽ tối đa 20 ảnh mỗi mẻ `full` (AC-ART-09), ảnh bị Gemini loại thì về emoji (AC-ART-02), và tranh vẽ khái niệm không giống meme gốc.
- Chủ dự án yêu cầu (2026-10-30): một job thêm ảnh cho meme đang có, lấy ảnh trên web, **không cần quan tâm bản quyền hay mặt người thật**; chỉ meme chưa có ảnh; workflow chạy tay.
- API quản trị đã có đủ: `GET /admin/elements` (có `image_key`, `image_source`, `image_state`) và `PUT /admin/elements/{id}/image` (WebP 256×256, ghi R2, `image_source = 'admin'`, audit `set_image`, mẻ sau không vẽ đè - ADR 0016).
- Pipeline đã có `to_webp_256` và adapter tải link an toàn (`links.py`, ADR 0018).

## Quyết định
- **Workflow riêng `art-search.yml`** (`workflow_dispatch`: `target` staging/production, `limit` mặc định 50, `dry_run`), chạy `python -m lau_meme_pipeline.art_search` trong `pipeline/`. Không chạy theo cron, không gộp vào mẻ nhúng.
- **Gắn ảnh qua API quản trị** bằng `ADMIN_TOKEN` (Secret của environment) gửi tới host quản trị (ADR 0008), không qua token pipeline: ảnh tìm được có cùng vị thế với tranh admin tải tay, có audit, Worker không cần đổi. Contract không đổi.
- **Chọn phần tử:** đang hoạt động, `image_key` rỗng; xếp độ sâu giảm dần rồi tên `fold` (món sâu sắp lên Vàng/Đỏ cần ảnh trước - AC-TIER-04); phần tử có ảnh bị ẩn/chặn không xét (admin đã chặn ảnh đó).
- **Tìm ảnh:** adapter mạng riêng cho API tìm ảnh (mock trong test), truy vấn = tên phần tử; nhà cung cấp và cách lọc theo câu hỏi mở 104. Thử tối đa 3 kết quả đầu, mỗi kết quả tải qua `fetch_link` (cùng giới hạn AC-ART-14), rồi `to_webp_256`.
- **Không kiểm duyệt ảnh:** không gửi Gemini, không lọc mặt người thật, logo hay nhân vật có bản quyền (chủ dự án chốt). Luật vẽ của Workers AI (AC-ART-01/02) giữ nguyên.
- Logic chọn phần tử và xếp thứ tự là hàm thuần; mạng (API quản trị, API tìm ảnh, tải ảnh) nằm trong adapter.

## Hệ quả
- Rủi ro pháp lý do chủ dự án chấp nhận: ảnh có thể có bản quyền; ảnh khuôn mặt người nhận diện được là dữ liệu cá nhân theo Luật Bảo vệ dữ liệu cá nhân 2025. Giảm thiểu bằng cơ chế sẵn có: thực khách báo cáo ảnh ⇒ ảnh vào danh sách chặn, client về emoji (AC-REPORT); admin chặn ảnh (AC-ART-07) hoặc tải tranh thay (AC-ART-13).
- Ảnh tìm được thành ảnh `admin`: Workers AI không vẽ đè, kể cả khi ảnh kém. Muốn vẽ lại thì admin phải thay ảnh bằng tay.
- Thêm một secret cho khóa API tìm ảnh ở environment staging và production; `ADMIN_TOKEN` cũng phải có trong GitHub Secret của hai environment này.
- Tên phần tử (nội dung game, gồm tên meme đề xuất đã duyệt) được gửi cho nhà cung cấp tìm ảnh; không có dữ liệu người chơi.
- Ảnh có trong graph từ mẻ kế tiếp (staging 2 tiếng, production 12 tiếng).

## Phương án đã cân nhắc
- **Workers AI bỏ luật người thật:** vẫn chỉ là tranh vẽ, không ra ảnh meme gốc.
- **Gộp vào mẻ `full`:** chia hạn mức thời gian 15 phút của mẻ, và lỗi API tìm ảnh lẫn vào báo cáo đợt; chủ dự án chọn chạy tay riêng.
