# Tiến độ — ƯỚC LƯỢNG - LẨU MEME

> Sinh bởi `/dk:plan` (gen-plan.py) từ `docs/estimate/items.json`. **Người sửa trực tiếp file này**: dấu `[x]` (hạng mục hoặc AC), `tiến độ: N%`, `người`, `bắt đầu`, `xong` (YYYY-MM-DD), `ghi chú` — giữ nguyên dấu ` · ` giữa các trường. Chạy lại `/dk:plan` để tính dự báo và vẽ lại `gantt.html`. `KH` là kế hoạch gốc, chỉ đổi bằng `/dk:plan rebaseline`.
> Bắt đầu dự án: 2026-10-20 · Kỹ sư: 1 (Thuc) · Giờ/tuần: 20 · Nghiệm thu KH: 2028-05-04 · Dự báo: 2027-06-02 · Cập nhật: 2026-10-23


## Nền tảng
- [x] **NEN** Khởi tạo dự án & hạ tầng · 3đ · rủi ro: LOW · KH: 2026-10-20 → 2026-10-28 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-19 · xong: 2026-10-19 · ghi chú: 
  - [x] AC-HEALTH-01 API sức khỏe
  - [x] AC-HEALTH-02 Trang chủ hiện trạng thái máy chủ
  - [x] AC-HEALTH-03 Khóa so khớp văn bản

## Nội dung
- [x] **SEED** Nạp lõi nội dung classic · 3đ · rủi ro: LOW · KH: 2026-10-29 → 2026-11-06 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-19 · xong: 2026-10-20 · ghi chú: 
  - [x] AC-SEED-01 Nạp lõi hợp lệ
  - [x] AC-SEED-02 Phần tử không tới được
  - [x] AC-SEED-03 Trùng cặp
  - [x] AC-SEED-04 Trùng tên sau chuẩn hóa hoặc trùng emoji
  - [x] AC-SEED-05 Tham chiếu không tồn tại và tự tham chiếu
  - [x] AC-SEED-06 Depth tính lại bằng BFS
  - [x] AC-SEED-07 Ràng buộc tên
  - [x] AC-SEED-08 Nạp lại idempotent
- [x] **GRAPH** Graph mã hóa + manifest + rollback · 6đ · rủi ro: MEDIUM · KH: 2026-11-09 → 2026-11-26 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-19 · xong: 2026-10-19 · ghi chú: 
  - [x] AC-GRAPH-01 Khóa tra cứu là băm của cặp tên đã chuẩn hóa
  - [x] AC-GRAPH-02 Kết quả mã hóa bằng khóa dẫn xuất từ 2 tên đầu vào
  - [x] AC-GRAPH-03 Graph công khai không lộ tên kết quả
  - [x] AC-GRAPH-04 Manifest có version và giờ mẻ thật
  - [x] AC-GRAPH-05 Giữ 14 bản gần nhất
  - [x] AC-GRAPH-06 Rollback về đợt trước bằng một lệnh
  - [x] AC-GRAPH-07 Rollback khi không có bản trước
  - [x] AC-GRAPH-08 Manifest chưa có

## Trò chơi
- [x] **GAME** Chơi ghép (Nhúng lẩu) · 13.5đ · rủi ro: MEDIUM · KH: 2026-11-27 → 2027-01-05 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [x] AC-GAME-01 Bàn chơi lần đầu
  - [x] AC-GAME-02 Nhúng lẩu qua nồi - ghép thành công
  - [x] AC-GAME-03 Thả chồng trên mặt bàn
  - [x] AC-GAME-04 Ghép ra phần tử đã có
  - [x] AC-GAME-05 Nồi trào - câu cố định theo cặp
  - [x] AC-GAME-06 Gợi ý khi trượt
  - [x] AC-GAME-07 Tìm trong Đĩa nhúng không dấu
  - [x] AC-GAME-08 Sắp xếp Đĩa nhúng
  - [x] AC-GAME-09 Nhãn "MỚI"
  - [x] AC-GAME-10 Lưu và khôi phục tiến độ cục bộ
  - [x] AC-GAME-11 Dọn bàn và Chơi lại từ đầu
  - [x] AC-GAME-12 Hướng dẫn lần đầu
  - [x] AC-GAME-13 Chế độ tối
  - [x] AC-GAME-14 Ghép tra trong bộ nhớ dưới 50 ms
  - [x] AC-GAME-15 Phần tử bị chặn nóng
  - [x] AC-GAME-16 Lỗi tải graph
  - [x] AC-GAME-17 Đổi version graph giữ tiến độ
  - [x] AC-GAME-18 Nồi lẩu nằm trong màn hình đầu tiên (thêm 2026-10-21)

## Nội dung
- [x] **PIPE** Pipeline Mẻ nhúng - chế độ lõi (giai đoạn 1) · 5đ · rủi ro: MEDIUM · KH: 2027-01-06 → 2027-01-20 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-21 · ghi chú: 
  - [x] AC-PIPE-01 Chế độ lõi (giai đoạn 1)
  - [x] AC-PIPE-02 Lịch chạy và chạy tay (cập nhật 2026-10-23)
  - [x] AC-PIPE-11 Lỗi giữa chừng không đăng gì
  - [x] AC-PIPE-13 Không gửi dữ liệu người chơi cho LLM
  - [x] AC-PIPE-14 Báo cáo đợt qua GitHub Issue

## Vận hành
- [x] **PRIV** Chính sách quyền riêng tư · 6đ · rủi ro: HIGH · KH: 2027-01-21 → 2027-02-16 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [x] AC-PRIV-01 Trang chính sách
  - [x] AC-PRIV-02 Đồng ý trước khi gửi dữ liệu
  - [x] AC-PRIV-03 Lưu bằng chứng đồng ý
  - [x] AC-PRIV-04 Rút lại đồng ý
  - [x] AC-PRIV-05 Xóa dữ liệu của mình
  - [x] AC-PRIV-06 IP chỉ lưu dạng băm, xóa sau 7 ngày
  - [x] AC-PRIV-07 Log không chứa dữ liệu cá nhân thô
  - [x] AC-PRIV-08 Xem và xuất dữ liệu của mình
  - [x] AC-PRIV-09 Chính sách đổi version

## Cộng đồng
- [x] **DISC** Công thức gia truyền · 6.5đ · rủi ro: HIGH · KH: 2027-02-17 → 2027-03-09 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [x] AC-DISC-01 Sinh UUID cục bộ
  - [x] AC-DISC-02 Đặt nickname hợp lệ
  - [x] AC-DISC-03 Nickname bị từ chối
  - [x] AC-DISC-04 Nickname trùng
  - [x] AC-DISC-05 Ghi nhận người khám phá đầu tiên
  - [x] AC-DISC-06 Đã có người khám phá
  - [x] AC-DISC-07 Công thức không có thật
  - [x] AC-DISC-08 Gửi đồng thời
  - [x] AC-DISC-09 Hiện Công thức gia truyền
  - [x] AC-DISC-10 Phần tử khởi đầu không có Công thức gia truyền
  - [x] AC-DISC-11 Giới hạn tần suất theo UUID và IP băm
  - [x] AC-DISC-12 Đầu vào sai định dạng

## Trò chơi
- [x] **DAILY** Món đặc biệt hôm nay · 9đ · rủi ro: MEDIUM · KH: 2027-03-10 → 2027-04-06 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-21 · ghi chú: 
  - [x] AC-DAILY-01 Chọn Món đặc biệt (cập nhật 2026-10-23)
  - [x] AC-DAILY-02 Không có ứng viên nào
  - [x] AC-DAILY-03 Công bố món không lộ tên
  - [x] AC-DAILY-04 Ghép ra Món đặc biệt trên bàn lẩu
  - [x] AC-DAILY-05 Trạng thái đã giải giữ qua tải lại
  - [x] AC-DAILY-06 Nộp kết quả hợp lệ
  - [x] AC-DAILY-07 Nộp kết quả không hợp lệ
  - [x] AC-DAILY-08 Nộp trùng, nộp cho mẻ đã qua, chưa đăng nhập
  - [x] AC-DAILY-09 Bảng xếp hạng mẻ
  - [x] AC-DAILY-10 Streak
  - [x] AC-DAILY-11 Bảng xếp hạng streak
  - [x] AC-DAILY-12 Đồng hồ đếm ngược theo manifest thật (cập nhật 2026-10-23)
  - [x] AC-DAILY-13 Giới hạn tần suất nộp
  - [x] AC-DAILY-14 Bảng xếp hạng tuần và tháng (thêm 2026-10-21)
  - [x] AC-DAILY-15 Bảng xếp hạng trên giao diện, chưa đăng nhập và bảng rỗng (thêm 2026-10-21)

## Cộng đồng
- [x] **AUTH** Đăng nhập bằng Google · 8.5đ · rủi ro: HIGH · KH: 2027-04-12 → 2027-05-07 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-21 · xong: 2026-10-21 · ghi chú: PR #28; trên staging
  - [x] AC-AUTH-01 Đăng nhập bằng Google
  - [x] AC-AUTH-02 Phiên đăng nhập
  - [x] AC-AUTH-03 ID token không hợp lệ
  - [x] AC-AUTH-04 Cùng tài khoản trên nhiều máy
  - [x] AC-AUTH-05 Đăng xuất
  - [x] AC-AUTH-06 Xóa tài khoản và dữ liệu
  - [x] AC-AUTH-07 Giới hạn tần suất đăng nhập

## Trò chơi
- [x] **DAILY2** Món đặc biệt - làm lại theo thời gian và tài khoản · 8.5đ · rủi ro: MEDIUM · KH: 2027-05-10 → 2027-06-03 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-21 · xong: 2026-10-21 · ghi chú: PR #29; trên staging
  - [x] AC-DAILY-04 Ghép ra Món đặc biệt trên bàn lẩu
  - [x] AC-DAILY-05 Trạng thái đã giải giữ qua tải lại
  - [x] AC-DAILY-06 Nộp kết quả hợp lệ
  - [x] AC-DAILY-07 Nộp kết quả không hợp lệ
  - [x] AC-DAILY-08 Nộp trùng, nộp cho mẻ đã qua, chưa đăng nhập
  - [x] AC-DAILY-09 Bảng xếp hạng mẻ
  - [x] AC-DAILY-10 Streak
  - [x] AC-DAILY-11 Bảng xếp hạng streak
  - [x] AC-DAILY-14 Bảng xếp hạng tuần và tháng (thêm 2026-10-21)
  - [x] AC-DAILY-15 Bảng xếp hạng trên giao diện, chưa đăng nhập và bảng rỗng (thêm 2026-10-21)
- [x] **UI2** Giao diện - góp ý sau staging · 5.5đ · rủi ro: LOW · KH: 2027-06-04 → 2027-06-22 · tiến độ: 0% (theo AC) · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [x] AC-DAILY-16 Thẻ thử thách nổi bật (thêm 2026-10-22)
  - [x] AC-DAILY-17 Bảng xếp hạng ở tab riêng (thêm 2026-10-22)
  - [x] AC-GAME-19 Nút điều khiển nằm ở khu bàn lẩu, đăng nhập ở đầu trang (thêm 2026-10-22)
  - [x] AC-GAME-20 Nồi lẩu vẽ trọn, quai ngang thân nồi (thêm 2026-10-22)
  - [x] AC-GAME-21 Vuốt cuộn trang trên màn hình cảm ứng (thêm 2026-10-22)

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
  - [x] AC-REPORT-01 Báo cáo phần tử
  - [x] AC-REPORT-02 Báo cáo không hợp lệ
  - [x] AC-REPORT-03 Một UUID chỉ tính một lần
  - [x] AC-REPORT-04 Đủ 3 UUID khác nhau ⇒ tự ẩn ngay
  - [x] AC-REPORT-05 Báo cáo ảnh ⇒ về emoji ngay
  - [x] AC-REPORT-06 Danh sách chặn nóng
  - [x] AC-REPORT-07 Client áp danh sách chặn khi khởi động
  - [x] AC-REPORT-08 Giới hạn tần suất báo cáo
  - [x] AC-REPORT-09 Phần tử bị ẩn và các công thức liên quan
- [x] **ADMIN** Trang quản trị tối giản · 6đ · rủi ro: MEDIUM · KH: 2027-05-10 → 2027-05-27 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [x] AC-ADMIN-01 Thiếu hoặc sai token
  - [x] AC-ADMIN-02 Chống dò token
  - [x] AC-ADMIN-03 Ẩn / hiện phần tử có hiệu lực ngay
  - [x] AC-ADMIN-04 Ẩn / hiện công thức và ảnh
  - [x] AC-ADMIN-05 Chặn vĩnh viễn
  - [x] AC-ADMIN-06 Xem báo cáo
  - [x] AC-ADMIN-07 Bỏ qua báo cáo
  - [x] AC-ADMIN-08 Nhật ký các đợt
  - [x] AC-ADMIN-09 Audit mọi thao tác quản trị
  - [x] AC-ADMIN-10 Trang quản trị
  - [ ] AC-ADMIN-11 Thống kê kết quả crawl (thêm 2026-10-23)
  - [ ] AC-ADMIN-12 Gán tier cho phần tử (thêm 2026-10-23)

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
  - [x] AC-INV-01 Ghép đối xứng
  - [x] AC-INV-02 Mỗi cặp tối đa một kết quả
  - [x] AC-INV-03 Mọi phần tử hoạt động đều tới được, depth = BFS
  - [x] AC-INV-04 Graph không lộ, không giải mã được khi thiếu đầu vào
  - [x] AC-INV-05 Pipeline idempotent
  - [x] AC-INV-06 Đợt lỗi không đổi bản đang chạy
  - [x] AC-INV-07 Không nội dung hoạt động nào vi phạm danh mục cấm
  - [x] AC-INV-08 First Discovery chỉ cho công thức có thật
  - [x] AC-INV-09 Đủ 3 báo cáo từ 3 UUID khác nhau ⇒ không còn hiện
  - [x] AC-INV-10 Món đặc biệt luôn hợp lệ
  - [x] AC-INV-11 Bảng xếp hạng chỉ có kết quả hợp lệ (cập nhật 2026-10-21)
  - [x] AC-INV-12 Tỉ lệ ghép trượt khi chơi ngẫu nhiên

## Nền tảng
- [x] **SUBPATH** Chạy dưới đường dẫn con dinoduct.fun/lau-meme · 4đ · rủi ro: MEDIUM · KH: 2027-07-01 → 2027-07-13 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [x] AC-SUBPATH-01 Một nguồn tiền tố, route đúng
  - [x] AC-SUBPATH-02 API dưới tiền tố
  - [x] AC-SUBPATH-03 Thiếu dấu gạch chéo cuối
  - [x] AC-SUBPATH-04 Ngoài tiền tố là 404
  - [x] AC-SUBPATH-05 Vào game và F5 ở mọi màn hình
  - [x] AC-SUBPATH-06 Giữ chỗ đường dẫn ảnh
  - [x] AC-SUBPATH-07 Web không gọi ra ngoài tiền tố
  - [x] AC-SUBPATH-08 Mọi khóa localStorage có tiền tố `laumeme:`
  - [x] AC-SUBPATH-09 Chuyển khóa cũ một lần
  - [x] AC-SUBPATH-10 Link chia sẻ tuyệt đối
  - [x] AC-SUBPATH-11 Thẻ xem trước link và favicon
  - [x] AC-SUBPATH-12 Pipeline gọi API dưới tiền tố

## Trò chơi
- [ ] **DAILY3** Món đặc biệt - pool mặn/mới, lịch mẻ theo manifest · 4đ · rủi ro: MEDIUM · KH: 2027-09-29 → 2027-10-11 · tiến độ: 0% (theo AC) · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-DAILY-01 Chọn Món đặc biệt (cập nhật 2026-10-23)
  - [ ] AC-DAILY-12 Đồng hồ đếm ngược theo manifest thật (cập nhật 2026-10-23)
  - [ ] AC-DAILY-18 Pool thử thách từ lõi không lặp trong 30 mẻ (thêm 2026-10-23)
  - [ ] AC-PIPE-02 Lịch chạy và chạy tay (cập nhật 2026-10-23)

## Nội dung
- [ ] **TIER** Tier của meme · 4đ · rủi ro: LOW · KH: 2027-10-12 → 2027-10-22 · tiến độ: 0% (theo AC) · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-ADMIN-12 Gán tier cho phần tử (thêm 2026-10-23)
  - [ ] AC-TIER-01 Tier mặc định và giữ qua các mẻ
  - [ ] AC-TIER-02 Hiển thị tier trên phần tử
  - [ ] AC-TIER-03 Graph cũ chưa có tier

## Cộng đồng
- [ ] **CONTRIB** Đóng góp meme · 13đ · rủi ro: HIGH · KH: 2027-10-25 → 2027-12-02 · tiến độ: 0% (theo AC) · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-CONTRIB-01 Gửi đề xuất hợp lệ
  - [ ] AC-CONTRIB-02 Đầu vào không hợp lệ
  - [ ] AC-CONTRIB-03 Trùng cặp, trùng tên, gửi lặp
  - [ ] AC-CONTRIB-04 Từ cấm và bí danh bị chặn
  - [ ] AC-CONTRIB-05 Chưa đăng nhập, chưa đồng ý, giới hạn tần suất
  - [ ] AC-CONTRIB-06 Thực khách xem đề xuất của mình
  - [ ] AC-CONTRIB-07 Admin xem và sửa đề xuất
  - [ ] AC-CONTRIB-08 Admin duyệt hoặc từ chối
  - [ ] AC-CONTRIB-09 Ảnh và biểu tượng của meme đóng góp
  - [ ] AC-CONTRIB-10 Hiện người tạo trên phần tử
  - [ ] AC-CONTRIB-11 Bảng xếp hạng "Top cống hiến"
  - [ ] AC-CONTRIB-12 Xóa tài khoản và xuất dữ liệu

## Kiểm thử
- [x] **UAT** Kiểm thử nghiệm thu & sửa lỗi (giai đoạn 1) · 15đ · rủi ro: MEDIUM · KH: 2027-07-01 → 2027-08-04 · tiến độ: 0% · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [x] AC-GAME-01 Bàn chơi lần đầu
  - [x] AC-GAME-02 Nhúng lẩu qua nồi - ghép thành công
  - [x] AC-GAME-03 Thả chồng trên mặt bàn
  - [x] AC-GAME-04 Ghép ra phần tử đã có
  - [x] AC-GAME-05 Nồi trào - câu cố định theo cặp
  - [x] AC-GAME-06 Gợi ý khi trượt
  - [x] AC-GAME-07 Tìm trong Đĩa nhúng không dấu
  - [x] AC-GAME-08 Sắp xếp Đĩa nhúng
  - [x] AC-GAME-09 Nhãn "MỚI"
  - [x] AC-GAME-10 Lưu và khôi phục tiến độ cục bộ
  - [x] AC-GAME-11 Dọn bàn và Chơi lại từ đầu
  - [x] AC-GAME-12 Hướng dẫn lần đầu
  - [x] AC-GAME-13 Chế độ tối
  - [x] AC-GAME-14 Ghép tra trong bộ nhớ dưới 50 ms
  - [x] AC-GAME-15 Phần tử bị chặn nóng
  - [x] AC-GAME-16 Lỗi tải graph
  - [x] AC-GAME-17 Đổi version graph giữ tiến độ
  - [x] AC-GAME-18 Nồi lẩu nằm trong màn hình đầu tiên (thêm 2026-10-21)
  - [x] AC-GAME-19 Nút điều khiển nằm ở khu bàn lẩu, đăng nhập ở đầu trang (thêm 2026-10-22)
  - [x] AC-GAME-20 Nồi lẩu vẽ trọn, quai ngang thân nồi (thêm 2026-10-22)
  - [x] AC-GAME-21 Vuốt cuộn trang trên màn hình cảm ứng (thêm 2026-10-22)

## Nội dung
- [x] **MOD** Kiểm duyệt nội dung tự động (giai đoạn 2) · 9đ · rủi ro: HIGH · KH: 2027-08-05 → 2027-09-01 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-20 · xong: 2026-10-20 · ghi chú: 
  - [x] AC-MOD-01 Lớp 1 - danh sách từ cấm
  - [x] AC-MOD-02 Lớp 2 - LLM phân loại theo danh mục
  - [x] AC-MOD-03 Không chắc thì loại
  - [x] AC-MOD-04 Kiểm cả tên kết quả công thức và văn bản phụ
  - [x] AC-MOD-05 Luật người thật dựa trên ngữ cảnh nguồn
  - [x] AC-MOD-06 Danh sách chặn bí danh áp cho mọi đầu vào sau
  - [x] AC-MOD-07 Tiếng lóng chung và hiện tượng chung được phép
  - [x] AC-MOD-08 Hoãn nội dung nóng vì một người
  - [x] AC-MOD-09 Không bao giờ - cáo buộc và quấy rối
  - [x] AC-MOD-10 Tên bị quản trị chặn không quay lại
- [x] **PIPE2** Pipeline Mẻ nhúng - crawl và tự động đăng (giai đoạn 2) · 14đ · rủi ro: HIGH · KH: 2027-09-03 → 2027-10-15 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-21 · xong: 2026-10-21 · ghi chú: PR #34 (mẻ full), #40, #43; trên staging
  - [x] AC-PIPE-03 Một nguồn lỗi không làm hỏng cả đợt
  - [x] AC-PIPE-04 Adapter chỉ thu khái niệm, tôn trọng robots.txt
  - [x] AC-PIPE-05 Khử trùng
  - [x] AC-PIPE-06 Liên kết ngược hợp lệ
  - [x] AC-PIPE-07 Hàng chờ meme chưa nối được
  - [x] AC-PIPE-08 Công thức bổ sung (cập nhật 2026-10-20)
  - [x] AC-PIPE-09 Giám khảo hài
  - [x] AC-PIPE-10 Idempotent
  - [x] AC-PIPE-12 Gom lô Gemini, backoff, hết quota dừng êm
- [ ] **PIPE3** Nguồn Tuổi Trẻ, Threads, mức mặn, thống kê crawl (giai đoạn 2) · 7.5đ · rủi ro: HIGH · KH: 2028-04-10 → 2028-05-03 · tiến độ: 0% (theo AC) · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
  - [ ] AC-ADMIN-11 Thống kê kết quả crawl (thêm 2026-10-23)
  - [ ] AC-PIPE-15 Nguồn Tuổi Trẻ chuyên mục meme (thêm 2026-10-23)
  - [ ] AC-PIPE-16 Ghi mức trending (mặn) của phần tử (thêm 2026-10-23)
  - [ ] AC-PIPE-17 Nguồn Threads qua API chính thức (thêm 2026-10-23)
- [x] **ART** Ảnh minh họa tự tạo (giai đoạn 2) · 10đ · rủi ro: HIGH · KH: 2027-10-18 → 2027-11-08 · tiến độ: 100% · người: Thuc · bắt đầu: 2026-10-21 · xong: 2026-10-22 · ghi chú: đã nối vào mẻ full (ADR 0012, nhánh feat/art-wiring); cần WORKERS_AI_TOKEN + CLOUDFLARE_ACCOUNT_ID để vẽ thật; hạn mức Workers AI vẫn chờ kiểm (câu hỏi mở 13)
  - [x] AC-ART-01 Prompt vẽ khái niệm, không người thật
  - [x] AC-ART-02 Kiểm duyệt ảnh, vẽ lại một lần rồi về emoji
  - [x] AC-ART-03 Hết hạn mức thì vẽ bù đợt sau
  - [x] AC-ART-04 Lưu ảnh theo băm nội dung
  - [x] AC-ART-05 Phục vụ ảnh qua Worker với cache bất biến
  - [x] AC-ART-06 Client hiện emoji trước, ảnh sau
  - [x] AC-ART-07 Ảnh bị chặn không được tải
  - [x] AC-ART-08 Phóng lớn bất ngờ khi ghép ra món lần đầu (thêm 2026-10-20)
  - [x] AC-ART-09 Mẻ full vẽ ảnh cho phần tử mới (thêm 2026-10-21, ADR 0012)
  - [x] AC-ART-10 Thiếu cấu hình hoặc lỗi vẽ kéo dài không làm hỏng mẻ (thêm 2026-10-21, ADR 0012)
  - [ ] AC-ART-11 Vẽ bù ảnh cho phần tử lõi (thêm 2026-10-23)

## Kiểm thử
- [ ] **UAT2** Kiểm thử nghiệm thu & sửa lỗi (giai đoạn 2) · 6.5đ · rủi ro: MEDIUM · KH: 2027-11-09 → 2027-11-22 · tiến độ: 0% · người: Thuc · bắt đầu:  · xong:  · ghi chú: 
