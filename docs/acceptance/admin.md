# Tiêu chí nghiệm thu - Trang quản trị tối giản (ADMIN)

> Giai đoạn 1. Component: worker (`/api/admin/*`), web (trang `/admin`). Xác thực bằng 1 token lưu trong Cloudflare secret, gửi qua `Authorization: Bearer`.
> "Ẩn" = tạm, gỡ được; "Chặn" = vĩnh viễn, pipeline không được tạo lại tên đó (AC-MOD-10).

### AC-ADMIN-01: Thiếu hoặc sai token
- **Cho** yêu cầu tới bất kỳ `/api/admin/*` nào không có token, token sai, hoặc sai sơ đồ (`Basic`)
- **Khi** gửi yêu cầu
- **Thì** trả 401 problem+json, không lộ nội dung; so sánh token bằng phép so hằng thời gian; không ghi token vào log
- Ưu tiên: Bắt buộc

### AC-ADMIN-02: Chống dò token
- **Cho** cùng IP băm gửi 5 yêu cầu sai token trong 1 phút
- **Khi** gửi yêu cầu thứ 6 (kể cả token đúng) trong 15 phút sau
- **Thì** trả 429 problem+json có `Retry-After`
- Ưu tiên: Bắt buộc

### AC-ADMIN-03: Ẩn / hiện phần tử có hiệu lực ngay
- **Cho** token đúng; phần tử P đang hoạt động
- **Khi** gửi lệnh ẩn P kèm lý do; rồi gửi lệnh hiện P
- **Thì** lệnh ẩn trả 200, P vào danh sách chặn ngay (AC-REPORT-06, hiệu lực trên client ≤ 60 s, không cần deploy); lệnh hiện trả 200, P ra khỏi danh sách chặn và bộ đếm báo cáo của P được đánh dấu "đã xử lý" để P không tự ẩn lại bởi các báo cáo cũ; phần tử không tồn tại trả 404
- Ưu tiên: Bắt buộc

### AC-ADMIN-04: Ẩn / hiện công thức và ảnh
- **Cho** token đúng; công thức A + B = C; phần tử P có ảnh
- **Khi** ẩn công thức A + B; ẩn ảnh của P; rồi hiện lại từng thứ
- **Thì** công thức/ảnh vào hoặc ra khỏi danh sách chặn tương ứng; phần tử C và P không bị ẩn theo
- Ưu tiên: Bắt buộc

### AC-ADMIN-05: Chặn vĩnh viễn
- **Cho** token đúng; phần tử P
- **Khi** gửi lệnh chặn P
- **Thì** P vào danh sách chặn và tên `fold` của P vào danh sách chặn bí danh (áp cho pipeline - AC-MOD-10 - và nickname - AC-DISC-03); lệnh hiện không áp dụng cho phần tử đã chặn (trả 409) - muốn gỡ phải gỡ chặn tường minh
- Ưu tiên: Bắt buộc

### AC-ADMIN-06: Xem báo cáo
- **Cho** token đúng; có báo cáo ở trạng thái mới và đã xử lý
- **Khi** gọi danh sách báo cáo với bộ lọc trạng thái, phân trang 50/trang
- **Thì** mỗi dòng gồm: đích (phần tử/ảnh, tên, emoji), số UUID khác nhau đã báo cáo, các lý do và số lượng, thời điểm báo cáo gần nhất, đang bị ẩn không; xếp theo số UUID giảm dần; không có UUID của người báo cáo trong phản hồi
- Ưu tiên: Bắt buộc

### AC-ADMIN-07: Bỏ qua báo cáo
- **Cho** báo cáo về P mà quản trị thấy không vi phạm
- **Khi** gửi lệnh "bỏ qua" cho P
- **Thì** các báo cáo hiện có của P chuyển "đã xử lý - bỏ qua"; nếu P đang tự ẩn thì hiện lại; báo cáo mới sau đó đếm lại từ 0
- Ưu tiên: Bắt buộc

### AC-ADMIN-08: Nhật ký các đợt
- **Cho** token đúng; có 20 đợt đã chạy
- **Khi** gọi danh sách đợt
- **Thì** trả các đợt mới nhất trước, mỗi đợt: version, `batch_at`, chế độ, trạng thái (thành công/lỗi/rollback), số thêm/chặn/hàng chờ, lỗi nguồn, link GitHub Issue báo cáo
- Ưu tiên: Bắt buộc

### AC-ADMIN-09: Audit mọi thao tác quản trị
- **Cho** token đúng
- **Khi** thực hiện bất kỳ lệnh ghi nào (ẩn, hiện, chặn, gỡ chặn, bỏ qua); rồi gọi danh sách audit
- **Thì** mỗi lệnh ghi đúng 1 dòng audit append-only: thao tác, loại + định danh đích, trạng thái trước, trạng thái sau, lý do, thời điểm, dấu vân token (8 ký tự đầu của băm token, không phải token); lệnh thất bại (4xx) không ghi audit; danh sách audit phân trang, mới nhất trước; audit giữ 12 tháng
- Ưu tiên: Bắt buộc

### AC-ADMIN-10: Trang quản trị
- **Cho** mở `https://laumeme-admin.dinoduct.fun/` (staging `https://laumeme-admin-staging.dinoduct.fun/`) - origin riêng, không chung với game (ADR 0008)
- **Khi** nhập token đúng; tải lại tab; đóng tab rồi mở lại; và gọi `/lau-meme/api/admin/*` trên host game
- **Thì** trang hiện các mục Báo cáo / Nội dung / Đợt + Audit / Đề xuất meme (AC-CONTRIB, thêm 2026-10-23); token chỉ lưu trong `sessionStorage` của origin quản trị (mất khi đóng tab), không lưu `localStorage`/cookie; token sai hiện thông báo `role="alert"`; trang có `noindex` (thẻ meta + header `X-Robots-Tag`) và CSP `frame-ancestors 'none'`; API quản trị chỉ có trên host quản trị - `/lau-meme/api/admin/*` trên host game trả 404
- Ưu tiên: Bắt buộc

### AC-ADMIN-11: Thống kê kết quả crawl (thêm 2026-10-23)
- **Cho** token đúng; 3 đợt `full` đã chạy, đợt gần nhất thu Reddit 0 (lỗi RobotsDenied), Know Your Meme 40, Tuổi Trẻ 20, thêm 6, vào hàng chờ 50, bị chặn 4 (theo danh mục), vẽ 20 ảnh; và 1 đợt `core`
- **Khi** mở mục "Đợt" (hoặc gọi API danh sách đợt, AC-ADMIN-08)
- **Thì** mỗi đợt hiện thêm số khái niệm thu theo từng nguồn (nguồn lỗi hiện loại lỗi thay vì số), số thêm, hàng chờ, bị chặn theo danh mục, quota Gemini, số ảnh vẽ / về emoji / chờ vẽ; đầu mục có ô tổng: tổng khái niệm đã crawl, tổng phần tử đã thêm từ crawl, số meme đang trong hàng chờ, số phần tử còn chưa có ảnh (lấy từ đợt gần nhất); đợt `core` hiện "không crawl"; số liệu do pipeline gửi kèm nhật ký đợt, không có tên phần tử bị chặn (chỉ số đếm theo danh mục); chưa có đợt nào thì hiện "Chưa có đợt nào"
- Ưu tiên: Bắt buộc

### AC-ADMIN-12: Gán tier cho phần tử (thêm 2026-10-23)
- **Cho** token đúng; phần tử P đang tier 1 (xám)
- **Khi** đặt tier của P = 4; đặt tier = 0 hoặc 6 hoặc chuỗi; đặt tier cho phần tử không tồn tại
- **Thì** tier hợp lệ 1-5 (AC-TIER-01): trả 200 và ghi 1 dòng audit (trước 1, sau 4) theo AC-ADMIN-09; giá trị ngoài 1-5 trả 400 problem+json, không ghi audit; phần tử không tồn tại trả 404; tier mới có trong graph từ mẻ kế tiếp (mặc định - câu hỏi mở 53); mục "Nội dung" hiện tier hiện tại của từng phần tử và lọc được theo tier
- Ưu tiên: Bắt buộc
