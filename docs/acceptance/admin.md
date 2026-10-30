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
- **Thì** trang hiện các mục Báo cáo / Nội dung / Đợt + Audit / Đề xuất meme (AC-CONTRIB, thêm 2026-10-23) / Món đặc biệt (AC-DAILY-19, thêm 2026-10-26) / Bị chặn (AC-ADMIN-13, thêm 2026-10-30); token chỉ lưu trong `sessionStorage` của origin quản trị (mất khi đóng tab), không lưu `localStorage`/cookie; token sai hiện thông báo `role="alert"`; trang có `noindex` (thẻ meta + header `X-Robots-Tag`) và CSP `frame-ancestors 'none'`; API quản trị chỉ có trên host quản trị - `/lau-meme/api/admin/*` trên host game trả 404
- Ưu tiên: Bắt buộc

### AC-ADMIN-11: Thống kê kết quả crawl (thêm 2026-10-23)
- **Cho** token đúng; 3 đợt `full` đã chạy, đợt gần nhất thu Reddit 0 (lỗi RobotsDenied), Know Your Meme 40, Tuổi Trẻ 20, thêm 6, vào hàng chờ 50, bị chặn 4 (theo danh mục), vẽ 20 ảnh; và 1 đợt `core`
- **Khi** mở mục "Đợt" (hoặc gọi API danh sách đợt, AC-ADMIN-08)
- **Thì** mỗi đợt hiện thêm số khái niệm thu theo từng nguồn (nguồn lỗi hiện loại lỗi thay vì số), số thêm, hàng chờ, bị chặn theo danh mục, quota Gemini, số ảnh vẽ / về emoji / chờ vẽ; đầu mục có ô tổng: tổng khái niệm đã crawl, tổng phần tử đã thêm từ crawl, số meme đang trong hàng chờ, số phần tử còn chưa có ảnh (lấy từ đợt gần nhất); đợt `core` hiện "không crawl"; số liệu do pipeline gửi kèm nhật ký đợt, không có tên phần tử bị chặn (chỉ số đếm theo danh mục; tên xem ở mục "Bị chặn", AC-ADMIN-13, cập nhật 2026-10-30); chưa có đợt nào thì hiện "Chưa có đợt nào"
- Ưu tiên: Bắt buộc

### AC-ADMIN-12: Gán tier cho phần tử (thêm 2026-10-23)
- **Cho** token đúng; phần tử P đang tier 1 (xám)
- **Khi** đặt tier của P = 4; đặt tier = 0 hoặc 6 hoặc chuỗi; đặt tier cho phần tử không tồn tại
- **Thì** tier hợp lệ 1-5 (AC-TIER-01): trả 200 và ghi 1 dòng audit (trước 1, sau 4) theo AC-ADMIN-09; (cập nhật 2026-10-24) có thêm lựa chọn "Tự động (theo độ sâu)" để bỏ giá trị admin gán (AC-TIER-05); gán tier 4 hoặc 5 cho phần tử chưa có ảnh (không có ảnh hoặc ảnh bị chặn) trả 409 problem+json "Món Vàng/Đỏ cần có ảnh trước", không ghi audit (AC-TIER-04, câu hỏi mở 69); giá trị ngoài 1-5 trả 400 problem+json, không ghi audit; phần tử không tồn tại trả 404; tier mới có trong graph từ mẻ kế tiếp (mặc định - câu hỏi mở 53); mục "Nội dung" hiện tier hiện tại của từng phần tử và lọc được theo tier
- Ưu tiên: Bắt buộc

### AC-ADMIN-13: Danh sách "Bị chặn" (thêm 2026-10-30)
- **Cho** token đúng; 30 khái niệm bị chặn từ 3 đợt với lý do khác nhau (AC-MOD-11), trong đó 2 dòng "Đã bỏ chặn", 1 dòng "Đã thêm", 1 dòng "Đã duyệt tay"
- **Khi** mở mục "Bị chặn"; lọc theo lý do, bước, trạng thái; tìm theo tên (so khớp dạng `fold`); mở chi tiết 1 dòng; gọi API danh sách không có token
- **Thì** danh sách xếp theo lần gặp cuối mới nhất trước, 50 dòng/trang; mỗi dòng có tên, nhãn lý do, bước, nguồn, số lần gặp, lần gặp cuối, trạng thái (Bị chặn / Đã bỏ chặn - chờ mẻ / Đã thêm / Đã duyệt tay); chi tiết hiện đủ trường của AC-MOD-11 kèm link nguồn mở tab mới; không có dòng nào thì hiện "Chưa có nội dung bị chặn"; API chỉ có trên host quản trị và cần token (AC-ADMIN-01, AC-ADMIN-10)
- Ưu tiên: Bắt buộc

### AC-ADMIN-14: Sửa tay và "Bỏ chặn" (thêm 2026-10-30)
- **Cho** token đúng; khái niệm K trạng thái "Bị chặn" lý do "chính trị"; khái niệm J lý do "đã bị quản trị chặn" (AC-MOD-10)
- **Khi** sửa tên, emoji, mô tả, gợi ý Daily, gợi ý ảnh của K rồi lưu; bấm "Bỏ chặn" K; bấm "Bỏ chặn" K lần hai; bấm "Bỏ chặn" J; lưu với tên rỗng hoặc dài hơn 100 ký tự, emoji dài hơn 16, mô tả dài hơn 200; sửa tên K trùng `fold` một phần tử đang có trong graph; thao tác với id không tồn tại
- **Thì** lưu trả 200 và ghi 1 dòng audit `edit_rejected` (trước/sau, AC-ADMIN-09); "Bỏ chặn" K trả 200, trạng thái thành "Đã bỏ chặn - chờ mẻ", ghi audit `unblock_rejected`, mẻ sau xử lý theo AC-PIPE-21; lần hai trả 409; J trả 409 problem+json "Tên đang bị chặn vĩnh viễn, gỡ chặn tên trước" (AC-ADMIN-05); giá trị sai trả 400; trùng `fold` trả 409; id không tồn tại trả 404; lệnh thất bại không ghi audit; dòng "Đã thêm" và "Đã duyệt tay" chỉ xem, không sửa
- Ưu tiên: Bắt buộc

### AC-ADMIN-15: "Duyệt luôn" không cần Gemini (thêm 2026-10-30)
- **Cho** token đúng; khái niệm K "Bị chặn"; phần tử A, B đang hoạt động, A + B chưa có công thức
- **Khi** admin chọn A, B, điền tên, emoji, mô tả (gợi ý Daily, gợi ý ảnh tùy chọn) rồi bấm "Duyệt luôn"; làm lại với cặp A + B đã có công thức; thiếu A, B, tên hoặc emoji
- **Thì** xử lý như duyệt một đề xuất meme (luồng CONTRIB): công thức A + B = K vào graph từ mẻ kế tiếp, không gọi Gemini, không qua kiểm duyệt; dòng K thành "Đã duyệt tay"; ghi audit `approve_rejected`; cặp đã có công thức trả 409; thiếu trường trả 400; không ghi audit khi thất bại (câu hỏi mở 98)
- Ưu tiên: Bắt buộc

### AC-ADMIN-16: Sửa mọi thuộc tính của meme trong "Nội dung" (thêm 2026-10-30)
- **Cho** token đúng; phần tử P đang trong graph
- **Khi** mở P trong mục "Nội dung" và sửa tên, emoji, mô tả, gợi ý Daily, gợi ý ảnh, nguồn gốc (VN / quốc tế), tier (AC-ADMIN-12), ảnh (AC-ART-13), ẩn/hiện (AC-ADMIN-03) rồi lưu; sửa tên P trùng `fold` một phần tử khác; lưu giá trị sai (tên 1-100, emoji 1-16, mô tả và gợi ý Daily tối đa 200, gợi ý ảnh tối đa 300 ký tự, nguồn gốc ngoài VN / quốc tế); sửa phần tử không tồn tại; mẻ kế tiếp chạy rồi một mẻ sau đó crawl lại khái niệm có tên cũ của P
- **Thì** mỗi lần lưu trả 200 và ghi 1 dòng audit `edit_element` chỉ chứa các trường đã đổi (trước/sau); giá trị mới có trong graph từ mẻ kế tiếp (như tier, câu hỏi mở 95), trong lúc chờ mục "Nội dung" hiện nhãn "Chờ mẻ kế tiếp"; pipeline không ghi đè các trường admin đã sửa ở mọi mẻ sau (như ảnh, AC-ART-13); đổi tên giữ nguyên id của P và tên cũ được giữ làm bí danh của P, nên crawl lại tên cũ được khử trùng vào P thay vì thêm meme mới (câu hỏi mở 94); trùng `fold` trả 409; giá trị sai trả 400; không tồn tại trả 404; lệnh thất bại không ghi audit
- Ưu tiên: Bắt buộc

### AC-ADMIN-17: Dọn danh sách "Bị chặn" sau 90 ngày (thêm 2026-10-30)
- **Cho** 3 dòng "Bị chặn" có lần gặp cuối cách lần dọn 89, 90 và 91 ngày; 1 dòng "Đã thêm" có lần gặp cuối cách 91 ngày
- **Khi** tác vụ dọn hằng ngày chạy (cùng cron AC-PRIV-06); rồi một đợt sau đó crawl lại tên của dòng đã xóa
- **Thì** dòng 91 ngày (cả dòng "Đã thêm") bị xóa, dòng 89 và 90 ngày còn; tên crawl lại sau khi đã xóa được coi là khái niệm mới (qua kiểm duyệt lại, nếu bị chặn thì tạo dòng mới với số lần gặp 1); audit của các dòng đã xóa vẫn giữ theo AC-ADMIN-09
- Ưu tiên: Bắt buộc
