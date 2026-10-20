# Tiêu chí nghiệm thu - Báo cáo + chặn nóng (REPORT)

> Giai đoạn 1. Component: worker (nhận báo cáo, tự ẩn, danh sách chặn), web (nút báo cáo, áp danh sách chặn).
> Lý do báo cáo: người thật · chính trị/tôn giáo · tình dục · phân biệt/body shaming · bạo lực/ma túy/tự hại · ảnh không phù hợp · khác.

### AC-REPORT-01: Báo cáo phần tử
- **Cho** phần tử P đang hoạt động; thực khách có UUID và đã đồng ý gửi dữ liệu
- **Khi** bấm "Báo cáo" trên P, chọn lý do "người thật" và gửi `POST` báo cáo `{target: element, id, reason}`
- **Thì** trả 201; client hiện "Cảm ơn, tụi mình sẽ xem lại"; báo cáo lưu UUID, lý do, thời điểm, trạng thái "mới"
- Ưu tiên: Bắt buộc

### AC-REPORT-02: Báo cáo không hợp lệ
- **Cho** lý do không nằm trong danh sách; hoặc đích không tồn tại; hoặc thiếu/sai UUID; hoặc lý do "khác" kèm ghi chú dài hơn 200 ký tự
- **Khi** gửi báo cáo
- **Thì** lý do sai / ghi chú quá dài trả 422; đích không tồn tại trả 404; thiếu/sai UUID trả 400 - đều problem+json; không ghi gì
- Ưu tiên: Bắt buộc

### AC-REPORT-03: Một UUID chỉ tính một lần
- **Cho** UUID U đã báo cáo P
- **Khi** U báo cáo P lần nữa (cùng hoặc khác lý do)
- **Thì** trả 200 với báo cáo đã có; số UUID khác nhau đã báo cáo P không đổi
- Ưu tiên: Bắt buộc

### AC-REPORT-04: Đủ 3 UUID khác nhau ⇒ tự ẩn ngay
- **Cho** P đã có báo cáo từ 2 UUID khác nhau
- **Khi** UUID thứ 3 báo cáo P
- **Thì** trong cùng yêu cầu, P được thêm vào danh sách chặn với lý do "tự ẩn do báo cáo"; `GET` danh sách chặn ngay sau đó (bỏ qua cache) có P; P không còn được chọn làm Món đặc biệt; DISC/DAILY coi công thức ra P là không hoạt động
- Ưu tiên: Bắt buộc

### AC-REPORT-05: Báo cáo ảnh ⇒ về emoji ngay
- **Cho** phần tử P có ảnh minh họa
- **Khi** một UUID báo cáo ảnh của P (`target: image`)
- **Thì** ảnh của P vào danh sách chặn ảnh ngay sau 1 báo cáo; client hiện emoji cho P (AC-ART-07); bản thân phần tử P vẫn hoạt động (chỉ tính vào ngưỡng ẩn phần tử nếu báo cáo `target: element`)
- Ưu tiên: Bắt buộc

### AC-REPORT-06: Danh sách chặn nóng
- **Cho** danh sách chặn có phần tử, công thức và ảnh
- **Khi** gọi `GET` danh sách chặn
- **Thì** trả 200 với 3 mảng định danh (phần tử, công thức, ảnh) dạng mã/băm - không có tên phần tử dạng đọc được; `Cache-Control` tối đa 60 s; danh sách rỗng trả các mảng rỗng
- Ưu tiên: Bắt buộc

### AC-REPORT-07: Client áp danh sách chặn khi khởi động
- **Cho** danh sách chặn mới có P (thêm sau lần deploy gần nhất)
- **Khi** client khởi động, và khi manifest được kiểm lại định kỳ (AC-DAILY-12)
- **Thì** client tải danh sách chặn và áp theo AC-GAME-15 mà không cần deploy; tải lỗi thì dùng bản đã lưu cục bộ gần nhất
- Ưu tiên: Bắt buộc

### AC-REPORT-08: Giới hạn tần suất báo cáo
- **Cho** cùng UUID gửi quá 10 báo cáo/giờ hoặc cùng IP băm quá 30 báo cáo/giờ (mặc định)
- **Khi** gửi báo cáo vượt ngưỡng
- **Thì** trả 429 problem+json có `Retry-After`; không ghi gì và không tính vào ngưỡng tự ẩn
- Ưu tiên: Bắt buộc

### AC-REPORT-09: Phần tử bị ẩn và các công thức liên quan
- **Cho** P bị ẩn (tự ẩn hoặc admin); công thức X + P = Q và công thức A + B = P
- **Khi** client và server xử lý ghép/khám phá
- **Thì** công thức có P là đầu vào hoặc kết quả đều không hoạt động; Q vẫn hoạt động nếu còn công thức khác ra Q (mặc định - câu hỏi mở); pipeline đợt sau nối lại phần tử mất đường tới (AC-INV-03)
- Ưu tiên: Bắt buộc
