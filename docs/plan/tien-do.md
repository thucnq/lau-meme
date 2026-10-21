# Tiến độ — ƯỚC LƯỢNG - LẨU MEME

> Sinh bởi `/dk:plan` (gen-plan.py) từ `docs/estimate/items.json`. **Người sửa trực tiếp file này**: dấu `[x]` (hạng mục hoặc AC), `tiến độ: N%`, `người`, `bắt đầu`, `xong` (YYYY-MM-DD), `ghi chú` — giữ nguyên dấu ` · ` giữa các trường. Chạy lại `/dk:plan` để tính dự báo và vẽ lại `gantt.html`. `KH` là kế hoạch gốc, chỉ đổi bằng `/dk:plan rebaseline`.
> Bắt đầu dự án: 2026-10-20 · Kỹ sư: 1 (Thuc) · Giờ/tuần: 20 · Nghiệm thu KH: 2027-11-23 · Dự báo: 2027-05-21 · Cập nhật: 2026-10-21


## Nền tảng
- [x] **NEN** Khởi tạo dự án & hạ tầng · 3đ · rủi ro: LOW · KH: 2026-10-20 → 2026-10-28 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-19 · xong: 2026-10-19 · ghi chú: 
  - [ ] AC-HEALTH-01 API sức khỏe
  - [ ] AC-HEALTH-02 Trang chủ hiện trạng thái máy chủ
  - [ ] AC-HEALTH-03 Khóa so khớp văn bản

## Nội dung
- [x] **SEED** Nạp lõi nội dung classic · 3đ · rủi ro: LOW · KH: 2026-10-29 → 2026-11-06 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-19 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-SEED-01 Nạp lõi hợp lệ
  - [ ] AC-SEED-02 Phần tử không tới được
  - [ ] AC-SEED-03 Trùng cặp
  - [ ] AC-SEED-04 Trùng tên sau chuẩn hóa hoặc trùng emoji
  - [ ] AC-SEED-05 Tham chiếu không tồn tại và tự tham chiếu
  - [ ] AC-SEED-06 Depth tính lại bằng BFS
  - [ ] AC-SEED-07 Ràng buộc tên
  - [ ] AC-SEED-08 Nạp lại idempotent
- [x] **GRAPH** Graph mã hóa + manifest + rollback · 6đ · rủi ro: MEDIUM · KH: 2026-11-09 → 2026-11-26 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-19 · xong: 2026-10-19 · ghi chú: 
  - [ ] AC-GRAPH-01 Khóa tra cứu là băm của cặp tên đã chuẩn hóa
  - [ ] AC-GRAPH-02 Kết quả mã hóa bằng khóa dẫn xuất từ 2 tên đầu vào
  - [ ] AC-GRAPH-03 Graph công khai không lộ tên kết quả
  - [ ] AC-GRAPH-04 Manifest có version và giờ mẻ thật
  - [ ] AC-GRAPH-05 Giữ 14 bản gần nhất
  - [ ] AC-GRAPH-06 Rollback về đợt trước bằng một lệnh
  - [ ] AC-GRAPH-07 Rollback khi không có bản trước
  - [ ] AC-GRAPH-08 Manifest chưa có

## Trò chơi
- [x] **GAME** Chơi ghép (Nhúng lẩu) · 13.5đ · rủi ro: MEDIUM · KH: 2026-11-27 → 2027-01-05 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-GAME-01 Bàn chơi lần đầu
  - [ ] AC-GAME-02 Nhúng lẩu qua nồi - ghép thành công
  - [ ] AC-GAME-03 Thả chồng trên mặt bàn
  - [ ] AC-GAME-04 Ghép ra phần tử đã có
  - [ ] AC-GAME-05 Nồi trào - câu cố định theo cặp
  - [ ] AC-GAME-06 Gợi ý khi trượt
  - [ ] AC-GAME-07 Tìm trong Đĩa nhúng không dấu
  - [ ] AC-GAME-08 Sắp xếp Đĩa nhúng
  - [ ] AC-GAME-09 Nhãn "MỚI"
  - [ ] AC-GAME-10 Lưu và khôi phục tiến độ cục bộ
  - [ ] AC-GAME-11 Dọn bàn và Chơi lại từ đầu
  - [ ] AC-GAME-12 Hướng dẫn lần đầu
  - [ ] AC-GAME-13 Chế độ tối
  - [ ] AC-GAME-14 Ghép tra trong bộ nhớ dưới 50 ms
  - [ ] AC-GAME-15 Phần tử bị chặn nóng
  - [ ] AC-GAME-16 Lỗi tải graph
  - [ ] AC-GAME-17 Đổi version graph giữ tiến độ
  - [ ] AC-GAME-18 Nồi lẩu nằm trong màn hình đầu tiên (thêm 2026-10-21)

## Nội dung
- [x] **PIPE** Pipeline Mẻ nhúng - chế độ lõi (giai đoạn 1) · 5đ · rủi ro: MEDIUM · KH: 2027-01-06 → 2027-01-20 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-21 · ghi chú: 
  - [ ] AC-PIPE-01 Chế độ lõi (giai đoạn 1)
  - [ ] AC-PIPE-02 Lịch chạy và chạy tay
  - [ ] AC-PIPE-11 Lỗi giữa chừng không đăng gì
  - [ ] AC-PIPE-13 Không gửi dữ liệu người chơi cho LLM
  - [ ] AC-PIPE-14 Báo cáo đợt qua GitHub Issue

## Vận hành
- [x] **PRIV** Chính sách quyền riêng tư · 6đ · rủi ro: HIGH · KH: 2027-01-21 → 2027-02-16 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-PRIV-01 Trang chính sách
  - [ ] AC-PRIV-02 Đồng ý trước khi gửi dữ liệu
  - [ ] AC-PRIV-03 Lưu bằng chứng đồng ý
  - [ ] AC-PRIV-04 Rút lại đồng ý
  - [ ] AC-PRIV-05 Xóa dữ liệu của mình
  - [ ] AC-PRIV-06 IP chỉ lưu dạng băm, xóa sau 7 ngày
  - [ ] AC-PRIV-07 Log không chứa dữ liệu cá nhân thô
  - [ ] AC-PRIV-08 Xem và xuất dữ liệu của mình
  - [ ] AC-PRIV-09 Chính sách đổi version

## Cộng đồng
- [x] **DISC** Công thức gia truyền · 6.5đ · rủi ro: HIGH · KH: 2027-02-17 → 2027-03-09 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-DISC-01 Sinh UUID cục bộ
  - [ ] AC-DISC-02 Đặt nickname hợp lệ
  - [ ] AC-DISC-03 Nickname bị từ chối
  - [ ] AC-DISC-04 Nickname trùng
  - [ ] AC-DISC-05 Ghi nhận người khám phá đầu tiên
  - [ ] AC-DISC-06 Đã có người khám phá
  - [ ] AC-DISC-07 Công thức không có thật
  - [ ] AC-DISC-08 Gửi đồng thời
  - [ ] AC-DISC-09 Hiện Công thức gia truyền
  - [ ] AC-DISC-10 Phần tử khởi đầu không có Công thức gia truyền
  - [ ] AC-DISC-11 Giới hạn tần suất theo UUID và IP băm
  - [ ] AC-DISC-12 Đầu vào sai định dạng

## Trò chơi
- [x] **DAILY** Món đặc biệt hôm nay · 9đ · rủi ro: MEDIUM · KH: 2027-03-10 → 2027-04-06 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-21 · ghi chú: 
  - [ ] AC-DAILY-01 Chọn Món đặc biệt
  - [ ] AC-DAILY-02 Không có ứng viên nào
  - [ ] AC-DAILY-03 Công bố món không lộ tên
  - [ ] AC-DAILY-04 Ghép ra Món đặc biệt trên bàn lẩu
  - [ ] AC-DAILY-05 Trạng thái đã giải giữ qua tải lại
  - [ ] AC-DAILY-06 Nộp kết quả hợp lệ
  - [ ] AC-DAILY-07 Nộp kết quả không hợp lệ
  - [ ] AC-DAILY-08 Nộp trùng, nộp cho mẻ đã qua, chưa đăng nhập
  - [ ] AC-DAILY-09 Bảng xếp hạng mẻ
  - [ ] AC-DAILY-10 Streak
  - [ ] AC-DAILY-11 Bảng xếp hạng streak
  - [ ] AC-DAILY-12 Đồng hồ đếm ngược theo manifest thật
  - [ ] AC-DAILY-13 Giới hạn tần suất nộp
  - [ ] AC-DAILY-14 Bảng xếp hạng tuần và tháng (thêm 2026-10-21)
  - [ ] AC-DAILY-15 Bảng xếp hạng trên giao diện, chưa đăng nhập và bảng rỗng (thêm 2026-10-21)

## Cộng đồng
- [ ] **AUTH** Đăng nhập bằng Google · 8.5đ · rủi ro: HIGH · KH: 2027-04-12 → 2027-05-07 · tiến độ: 0% (theo AC) · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-AUTH-01 Đăng nhập bằng Google
  - [ ] AC-AUTH-02 Phiên đăng nhập
  - [ ] AC-AUTH-03 ID token không hợp lệ
  - [ ] AC-AUTH-04 Cùng tài khoản trên nhiều máy
  - [ ] AC-AUTH-05 Đăng xuất
  - [ ] AC-AUTH-06 Xóa tài khoản và dữ liệu
  - [ ] AC-AUTH-07 Giới hạn tần suất đăng nhập

## Trò chơi
- [ ] **DAILY2** Món đặc biệt - làm lại theo thời gian và tài khoản · 8.5đ · rủi ro: MEDIUM · KH: 2027-05-10 → 2027-06-03 · tiến độ: 0% (theo AC) · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-DAILY-04 Ghép ra Món đặc biệt trên bàn lẩu
  - [ ] AC-DAILY-05 Trạng thái đã giải giữ qua tải lại
  - [ ] AC-DAILY-06 Nộp kết quả hợp lệ
  - [ ] AC-DAILY-07 Nộp kết quả không hợp lệ
  - [ ] AC-DAILY-08 Nộp trùng, nộp cho mẻ đã qua, chưa đăng nhập
  - [ ] AC-DAILY-09 Bảng xếp hạng mẻ
  - [ ] AC-DAILY-10 Streak
  - [ ] AC-DAILY-11 Bảng xếp hạng streak
  - [ ] AC-DAILY-14 Bảng xếp hạng tuần và tháng (thêm 2026-10-21)
  - [ ] AC-DAILY-15 Bảng xếp hạng trên giao diện, chưa đăng nhập và bảng rỗng (thêm 2026-10-21)

## Cộng đồng
- [ ] **SHARE** Thẻ chia sẻ · 4đ · rủi ro: MEDIUM · KH: 2027-04-07 → 2027-04-19 · tiến độ: 0% · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-SHARE-01 Thẻ Daily dạng chữ
  - [ ] AC-SHARE-02 Thời gian giải trên thẻ (cập nhật 2026-10-21, thay chuỗi emoji các bước)
  - [ ] AC-SHARE-03 Thẻ Daily dạng ảnh PNG
  - [ ] AC-SHARE-04 Thẻ Công thức gia truyền
  - [ ] AC-SHARE-05 Sao chép và chia sẻ hệ thống
  - [ ] AC-SHARE-06 Ghi sự kiện chia sẻ

## An toàn
- [x] **REPORT** Báo cáo + chặn nóng · 5.5đ · rủi ro: MEDIUM · KH: 2027-04-20 → 2027-05-07 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-REPORT-01 Báo cáo phần tử
  - [ ] AC-REPORT-02 Báo cáo không hợp lệ
  - [ ] AC-REPORT-03 Một UUID chỉ tính một lần
  - [ ] AC-REPORT-04 Đủ 3 UUID khác nhau ⇒ tự ẩn ngay
  - [ ] AC-REPORT-05 Báo cáo ảnh ⇒ về emoji ngay
  - [ ] AC-REPORT-06 Danh sách chặn nóng
  - [ ] AC-REPORT-07 Client áp danh sách chặn khi khởi động
  - [ ] AC-REPORT-08 Giới hạn tần suất báo cáo
  - [ ] AC-REPORT-09 Phần tử bị ẩn và các công thức liên quan
- [x] **ADMIN** Trang quản trị tối giản · 6đ · rủi ro: MEDIUM · KH: 2027-05-10 → 2027-05-27 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-ADMIN-01 Thiếu hoặc sai token
  - [ ] AC-ADMIN-02 Chống dò token
  - [ ] AC-ADMIN-03 Ẩn / hiện phần tử có hiệu lực ngay
  - [ ] AC-ADMIN-04 Ẩn / hiện công thức và ảnh
  - [ ] AC-ADMIN-05 Chặn vĩnh viễn
  - [ ] AC-ADMIN-06 Xem báo cáo
  - [ ] AC-ADMIN-07 Bỏ qua báo cáo
  - [ ] AC-ADMIN-08 Nhật ký các đợt
  - [ ] AC-ADMIN-09 Audit mọi thao tác quản trị
  - [ ] AC-ADMIN-10 Trang quản trị

## Vận hành
- [ ] **METRIC** Đo chỉ số thành công · 4.5đ · rủi ro: MEDIUM · KH: 2027-05-28 → 2027-06-10 · tiến độ: 0% · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-METRIC-01 Cloudflare Web Analytics không cookie
  - [ ] AC-METRIC-02 Nhận sự kiện theo danh sách cho phép
  - [ ] AC-METRIC-03 Sự kiện không hợp lệ
  - [ ] AC-METRIC-04 Client gom sự kiện ghép
  - [ ] AC-METRIC-05 Tổng hợp chỉ số
  - [ ] AC-METRIC-06 Đưa số liệu vào báo cáo đợt
  - [ ] AC-METRIC-07 Dọn sự kiện quá hạn

## Kiểm thử
- [x] **INV** Bất biến nội dung và trò chơi · 6đ · rủi ro: HIGH · KH: 2027-06-11 → 2027-06-30 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-INV-01 Ghép đối xứng
  - [ ] AC-INV-02 Mỗi cặp tối đa một kết quả
  - [ ] AC-INV-03 Mọi phần tử hoạt động đều tới được, depth = BFS
  - [ ] AC-INV-04 Graph không lộ, không giải mã được khi thiếu đầu vào
  - [ ] AC-INV-05 Pipeline idempotent
  - [ ] AC-INV-06 Đợt lỗi không đổi bản đang chạy
  - [ ] AC-INV-07 Không nội dung hoạt động nào vi phạm danh mục cấm
  - [ ] AC-INV-08 First Discovery chỉ cho công thức có thật
  - [ ] AC-INV-09 Đủ 3 báo cáo từ 3 UUID khác nhau ⇒ không còn hiện
  - [ ] AC-INV-10 Món đặc biệt luôn hợp lệ
  - [ ] AC-INV-11 Bảng xếp hạng chỉ có kết quả hợp lệ (cập nhật 2026-10-21)
  - [ ] AC-INV-12 Tỉ lệ ghép trượt khi chơi ngẫu nhiên

## Nền tảng
- [x] **SUBPATH** Chạy dưới đường dẫn con dinoduct.fun/lau-meme · 4đ · rủi ro: MEDIUM · KH: 2027-07-01 → 2027-07-13 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-SUBPATH-01 Một nguồn tiền tố, route đúng
  - [ ] AC-SUBPATH-02 API dưới tiền tố
  - [ ] AC-SUBPATH-03 Thiếu dấu gạch chéo cuối
  - [ ] AC-SUBPATH-04 Ngoài tiền tố là 404
  - [ ] AC-SUBPATH-05 Vào game và F5 ở mọi màn hình
  - [ ] AC-SUBPATH-06 Giữ chỗ đường dẫn ảnh
  - [ ] AC-SUBPATH-07 Web không gọi ra ngoài tiền tố
  - [ ] AC-SUBPATH-08 Mọi khóa localStorage có tiền tố `laumeme:`
  - [ ] AC-SUBPATH-09 Chuyển khóa cũ một lần
  - [ ] AC-SUBPATH-10 Link chia sẻ tuyệt đối
  - [ ] AC-SUBPATH-11 Thẻ xem trước link và favicon
  - [ ] AC-SUBPATH-12 Pipeline gọi API dưới tiền tố

## Kiểm thử
- [ ] **UAT** Kiểm thử nghiệm thu & sửa lỗi (giai đoạn 1) · 14đ · rủi ro: MEDIUM · KH: 2027-07-01 → 2027-08-04 · tiến độ: 0% · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-GAME-01 Bàn chơi lần đầu
  - [ ] AC-GAME-02 Nhúng lẩu qua nồi - ghép thành công
  - [ ] AC-GAME-03 Thả chồng trên mặt bàn
  - [ ] AC-GAME-04 Ghép ra phần tử đã có
  - [ ] AC-GAME-05 Nồi trào - câu cố định theo cặp
  - [ ] AC-GAME-06 Gợi ý khi trượt
  - [ ] AC-GAME-07 Tìm trong Đĩa nhúng không dấu
  - [ ] AC-GAME-08 Sắp xếp Đĩa nhúng
  - [ ] AC-GAME-09 Nhãn "MỚI"
  - [ ] AC-GAME-10 Lưu và khôi phục tiến độ cục bộ
  - [ ] AC-GAME-11 Dọn bàn và Chơi lại từ đầu
  - [ ] AC-GAME-12 Hướng dẫn lần đầu
  - [ ] AC-GAME-13 Chế độ tối
  - [ ] AC-GAME-14 Ghép tra trong bộ nhớ dưới 50 ms
  - [ ] AC-GAME-15 Phần tử bị chặn nóng
  - [ ] AC-GAME-16 Lỗi tải graph
  - [ ] AC-GAME-17 Đổi version graph giữ tiến độ
  - [ ] AC-GAME-18 Nồi lẩu nằm trong màn hình đầu tiên (thêm 2026-10-21)

## Nội dung
- [x] **MOD** Kiểm duyệt nội dung tự động (giai đoạn 2) · 9đ · rủi ro: HIGH · KH: 2027-08-05 → 2027-09-01 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [ ] AC-MOD-01 Lớp 1 - danh sách từ cấm
  - [ ] AC-MOD-02 Lớp 2 - LLM phân loại theo danh mục
  - [ ] AC-MOD-03 Không chắc thì loại
  - [ ] AC-MOD-04 Kiểm cả tên kết quả công thức và văn bản phụ
  - [ ] AC-MOD-05 Luật người thật dựa trên ngữ cảnh nguồn
  - [ ] AC-MOD-06 Danh sách chặn bí danh áp cho mọi đầu vào sau
  - [ ] AC-MOD-07 Tiếng lóng chung và hiện tượng chung được phép
  - [ ] AC-MOD-08 Hoãn nội dung nóng vì một người
  - [ ] AC-MOD-09 Không bao giờ - cáo buộc và quấy rối
  - [ ] AC-MOD-10 Tên bị quản trị chặn không quay lại
- [ ] **PIPE2** Pipeline Mẻ nhúng - crawl và tự động đăng (giai đoạn 2) · 14đ · rủi ro: HIGH · KH: 2027-09-03 → 2027-10-15 · tiến độ: 0% (theo AC) · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-PIPE-03 Một nguồn lỗi không làm hỏng cả đợt
  - [ ] AC-PIPE-04 Adapter chỉ thu khái niệm, tôn trọng robots.txt
  - [ ] AC-PIPE-05 Khử trùng
  - [ ] AC-PIPE-06 Liên kết ngược hợp lệ
  - [ ] AC-PIPE-07 Hàng chờ meme chưa nối được
  - [ ] AC-PIPE-08 Công thức bổ sung (cập nhật 2026-10-20)
  - [ ] AC-PIPE-09 Giám khảo hài
  - [ ] AC-PIPE-10 Idempotent
  - [ ] AC-PIPE-12 Gom lô Gemini, backoff, hết quota dừng êm
- [ ] **ART** Ảnh minh họa tự tạo (giai đoạn 2) · 7đ · rủi ro: HIGH · KH: 2027-10-18 → 2027-11-08 · tiến độ: 0% · người: Thuc · bắt đầu: 2026-10-21 · xong:  · ghi chú: logic thuần + Worker /img + web xong (8/8 AC ở mức đơn vị); CHƯA nối vào mẻ full: adapter vẽ (Workers AI, câu hỏi mở 13), kiểm ảnh Gemini, tải R2 qua S3, trạng thái chờ vẽ trong kho (đổi contract) - cần /dk:design; chưa ship tới khi nối xong 
  - [ ] AC-ART-01 Prompt vẽ khái niệm, không người thật
  - [ ] AC-ART-02 Kiểm duyệt ảnh, vẽ lại một lần rồi về emoji
  - [ ] AC-ART-03 Hết hạn mức thì vẽ bù đợt sau
  - [ ] AC-ART-04 Lưu ảnh theo băm nội dung
  - [ ] AC-ART-05 Phục vụ ảnh qua Worker với cache bất biến
  - [ ] AC-ART-06 Client hiện emoji trước, ảnh sau
  - [ ] AC-ART-07 Ảnh bị chặn không được tải
  - [ ] AC-ART-08 Phóng lớn bất ngờ khi ghép ra món lần đầu (thêm 2026-10-20)

## Kiểm thử
- [ ] **UAT2** Kiểm thử nghiệm thu & sửa lỗi (giai đoạn 2) · 4.5đ · rủi ro: MEDIUM · KH: 2027-11-09 → 2027-11-22 · tiến độ: 0% · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
