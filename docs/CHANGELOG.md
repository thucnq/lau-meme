# Nhật ký thay đổi

## [Unreleased]
- Khởi tạo dự án từ golden path py-ts-cloudflare: Worker (API + web tĩnh) + D1, pipeline Python, CI.
- Trang quản trị chuyển sang origin riêng `laumeme-admin.dinoduct.fun` (staging: `laumeme-admin-staging.dinoduct.fun`), cùng Worker, định tuyến theo host (ADR 0008). Host game trả 404 cho `/lau-meme/admin*` và `/lau-meme/api/admin/*`.
- Quản trị: token so hằng thời gian; sai quá 5 lần/phút từ một IP thì khóa 15 phút (429 kèm `Retry-After`). Ẩn/hiện phần tử, công thức, ảnh có hiệu lực ngay trên danh sách chặn.
- Quản trị: thêm fold vào bí danh bị chặn vĩnh viễn; phần tử đã chặn trả 409; gỡ chặn phải làm tường minh.
- Quản trị: danh sách báo cáo gom theo đích, không lộ UUID người báo cáo; báo cáo chỉ gỡ ẩn tự động bị bỏ qua và đếm lại từ 0.
- Quản trị: mỗi lệnh ghi thành công ghi 1 dòng audit, kèm dấu vân 8 ký tự của token.
- Giao diện game: chuyển sang một bảng màu xanh lá (màu rau) cho cả chế độ sáng và tối; nút và chip bo tròn hơn, có hiệu ứng khi di chuột và nhấn (tắt khi người dùng bật giảm chuyển động). Thanh địa chỉ trình duyệt đổi màu theo chế độ sáng/tối.
- Chữ hiển thị trên giao diện, tài liệu và mã nguồn: dấu gạch dài thay bằng dấu gạch ngang "-". Không đổi hành vi.
- Đăng nhập Google (tùy chọn, ADR 0010): `POST /auth/google` mở phiên bằng cookie `laumeme_sid`; phiên hết hạn sau 90 ngày không dùng; `DELETE /auth/session` đăng xuất. Tài khoản chỉ lưu băm của định danh Google, không lưu email, tên hay ảnh. Không đăng nhập vẫn chơi như trước.
- Món đặc biệt (Daily) theo tài khoản: kết quả, streak và nickname trên bảng xếp hạng thuộc tài khoản đã đăng nhập. Nộp cặp (a, b) cần phiên (`POST /daily/{version}/results`).
- Thời gian giải Daily do server tính, từ lúc mẻ của version được đăng đến lúc server nhận bài nộp; client không gửi thời gian.
- Bảng xếp hạng Daily theo tuần và theo tháng (`GET /daily/leaderboard?period=...`, top 20). Xem bảng xếp hạng chỉ đọc phiên, không gia hạn phiên.
- Streak của tài khoản: `GET /me/streak`; bảng xếp hạng streak (`GET /streaks/leaderboard`) xếp theo streak hiện tại.
- Kết quả Daily ghi theo UUID trước đây không còn được ghi thêm; dữ liệu cũ chỉ có trên staging và không chuyển sang tài khoản.
- Bàn chơi vừa màn hình: chiều cao bàn theo khung nhìn, nồi lẩu nằm trọn trong màn hình đầu tiên (AC-GAME-18); vật phẩm rơi vào vùng bàn phía trên nồi. Trên điện thoại, thanh công cụ gom một hàng (nhãn "Chơi lại từ đầu" rút ngắn), tiêu đề một dòng, bỏ gradient tiêu đề và hiệu ứng phát sáng quanh nồi; hộp xác nhận hiện ở đầu màn hình.
- Đăng nhập Google trên staging: web chọn Client ID theo tên miền, `staging.dinoduct.fun` dùng client staging. Sửa lỗi `origin_mismatch` và sai `audience` trên staging. Production không đổi.
