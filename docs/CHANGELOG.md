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
