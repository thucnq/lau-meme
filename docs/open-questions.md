# Câu hỏi mở — Lẩu Meme

> Ngày: 2026-10-19 · Dự án cá nhân: "khách" = Thuc. Mỗi câu đã có mặc định được dùng trong AC; trả lời khác mặc định thì sửa AC tương ứng trước `/dk:approve spec`.
> Đã trả lời (từ `docs/scope.md`): go-live giai đoạn 1 với lõi classic + pipeline chạy tay; ảnh sau, emoji trước; cần bảng sự kiện D1; thêm streak; không làm landing riêng.

| # | Câu hỏi | Vì sao cần chốt | Mặc định nếu khách không trả lời | Ảnh hưởng báo giá (Có/Không) |
|---|---|---|---|---|
| 1 | Giai đoạn 1 chưa có crawl: mẻ nhúng có chạy **cron chế độ lõi** 2 lần/ngày (chỉ đổi Món đặc biệt + manifest, không thêm nội dung) không? | Daily cần đổi món mỗi mẻ; nếu không có cron thì phải đổi tay hoặc Daily đứng yên | Có — cron chế độ lõi (AC-PIPE-01/02) ở giai đoạn 1; crawl + tự động đăng ở giai đoạn 2 | Có |
| 2 | Lõi chỉ có **40 món độ sâu 4–8** ⇒ hết món chưa lặp sau ~20 ngày. Lặp lại món cũ, nới khoảng độ sâu, hay bổ sung lõi trước go-live? | Giai đoạn 1 không có nội dung mới từ crawl | Lặp lại món đã dùng lâu nhất (AC-DAILY-01) | Không |
| 3 | Thử thách Daily chơi trên **bàn riêng bắt đầu từ 4 phần tử khởi đầu**, hay dùng Đĩa hiện có của người chơi? | Quyết định bảng xếp hạng có công bằng không; Đĩa đầy thì 1 bước là xong | Bàn riêng từ 4 phần tử khởi đầu (AC-DAILY-04) | Có |
| 4 | **Streak** tính theo ngày (GMT+7, ≥ 1 món/ngày) hay theo từng mẻ (2 món/ngày, bỏ 1 mẻ là mất)? | Đổi cách tính, bảng xếp hạng streak | Theo ngày GMT+7 (AC-DAILY-10) | Không |
| 5 | Phần tử bị ẩn do báo cáo: các công thức đi ra từ nó xử lý thế nào — ẩn theo, hay giữ nhưng không gợi ý? (câu hỏi mở 4 trong ghi chú họp) | Ảnh hưởng tính tới được của các phần tử phía sau | Mọi công thức có phần tử đó ở đầu vào/kết quả đều không hoạt động; phần tử phía sau còn đường khác thì giữ, mất đường thì pipeline nối lại (AC-REPORT-09, AC-INV-03) | Có |
| 6 | **Trẻ em**: người chơi dưới 16 tuổi có thể vào chơi. Ghi trong chính sách "dành cho người từ 16 tuổi", hay thiết kế không cần đồng ý của cha mẹ (không thu gì kèm UUID khi chưa xác nhận tuổi)? | Dữ liệu trẻ em là dữ liệu nhạy cảm theo Luật BVDLCN 2025 — đổi luồng đồng ý và giá | Chính sách ghi dành cho người từ 16 tuổi; hộp đồng ý có câu "Tôi từ 16 tuổi trở lên"; không thu tuổi | Có |
| 7 | **Domain**: mua domain riêng (vd `laumeme.vn`) hay tạm dùng `*.workers.dev`? (câu hỏi mở 1 trong ghi chú họp) | Link trên thẻ chia sẻ, CORS, Web Analytics | `*.workers.dev` cho staging; domain riêng trước go-live, cấu hình qua biến môi trường | Không |
| 8 | Nickname có phải **duy nhất** không? | Bảng xếp hạng dễ bị mạo danh nếu trùng | Duy nhất theo dạng `fold` (AC-DISC-04) | Không |
| 9 | Gợi ý khi trượt: sau **bao nhiêu lần trượt liên tiếp**? | "Thỉnh thoảng" chưa đo được | Sau 3 lần trượt liên tiếp (AC-GAME-06) | Không |
| 10 | Giới hạn tần suất: khám phá 30/phút/UUID & 60/phút/IP; Daily 10/phút; báo cáo 10/giờ/UUID & 30/giờ/IP; sự kiện 20 lô/phút — có chấp nhận không? | Cân giữa chống gian lận và người chơi thật dùng chung IP (4G, quán net) | Như bên trái | Không |
| 11 | Thời hạn lưu: IP băm 7 ngày, sự kiện 90 ngày, bằng chứng đồng ý đến 1 năm sau khi xóa, audit admin 12 tháng — có đồng ý? | Ghi vào trang chính sách | Như bên trái | Không |
| 12 | Mục tiêu số cho chỉ số thành công (D1, D7, người chơi Daily/ngày)? | Để biết go-live thành công hay không | Chưa đặt — xem số liệu 2 tuần đầu rồi chốt | Không |
| 13 | (Giai đoạn 2) R2 có đòi khai báo thẻ thanh toán không; hạn mức Workers AI gói free hiện hành? (Q9, Q14 ghi chú họp) | Quyết định nơi lưu ảnh và số ảnh vẽ được mỗi đợt | Dùng R2; nếu bị đòi thẻ thì đóng gói ảnh làm static assets | Có |
| 14 | (Giai đoạn 2) Meme không nối được: giữ trong hàng chờ **bao nhiêu đợt** rồi bỏ? | Hàng chờ phình to, tốn quota | 6 đợt (3 ngày) (AC-PIPE-07) | Không |
| 15 | (Tùy chọn FEEDBACK) Ngưỡng ẩn công thức "Nhạt"? | Ẩn quá tay sẽ làm tăng tỉ lệ trượt | ≥ 10 phiếu và ≥ 60 % "Nhạt" (AC-FEEDBACK-04) | Không |
| 16 | Danh sách từ cấm lưu ở đâu — trong repo public hay GitHub Secret/kho riêng? | Danh sách từ cấm tiếng Việt có thể bị dùng để lách | Kho riêng / secret, pipeline và Worker đọc lúc chạy (`/dk:design` chốt) | Không |
