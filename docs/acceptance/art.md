# Tiêu chí nghiệm thu - Ảnh minh họa tự tạo (ART)

> Giai đoạn 2 (giai đoạn 1 chỉ emoji - trả lời câu hỏi phạm vi 2). Component: pipeline (vẽ + kiểm duyệt ảnh, adapter Workers AI / Gemini mock), worker (phục vụ `/img/*`), web (hiện ảnh).
> Cần kiểm tra trước khi làm: hạn mức Workers AI gói free; R2 có đòi thẻ thanh toán không (dự phòng: kho ảnh đóng gói làm static assets).

### AC-ART-01: Prompt vẽ khái niệm, không người thật
- **Cho** phần tử mới có gợi ý ảnh "con ốc sên đội tờ lịch, bò chậm rãi"
- **Khi** pipeline tạo prompt vẽ
- **Thì** prompt = gợi ý ảnh + đoạn phong cách chung (vẽ tay bằng bút mực và màu nước, nét run nhẹ như phác thảo, nền trơn, có nồi lẩu khi hợp, không chữ, không người thật, không logo - cập nhật 2026-10-20, thay phong cách sticker) cấu hình một chỗ; prompt không chứa tên phần tử nếu tên nằm trong danh sách chặn bí danh hoặc là tên riêng
- Ưu tiên: Bắt buộc

### AC-ART-02: Kiểm duyệt ảnh, vẽ lại một lần rồi về emoji
- **Cho** Gemini kiểm ảnh lần 1 trả "vi phạm: mặt người giống thật", lần 2 trả "vi phạm: chữ trong ảnh"
- **Khi** bước vẽ chạy cho phần tử đó
- **Thì** có đúng 2 lần vẽ; phần tử không có ảnh (client dùng emoji); báo cáo đợt đếm ảnh bị loại theo lý do. Nếu lần 2 đạt thì ảnh lần 2 được dùng. Lý do vi phạm gồm: mặt người giống thật, logo/thương hiệu, nhân vật có bản quyền, chữ trong ảnh, danh mục cấm mục 7
- Ưu tiên: Bắt buộc

### AC-ART-03: Hết hạn mức thì vẽ bù đợt sau
- **Cho** Workers AI báo hết hạn mức sau khi vẽ xong 5 trong 12 phần tử
- **Khi** bước vẽ chạy
- **Thì** 7 phần tử còn lại không có ảnh, được đánh dấu "chờ vẽ"; đợt sau vẽ các phần tử "chờ vẽ" trước phần tử mới; đợt không thất bại
- Ưu tiên: Bắt buộc

### AC-ART-04: Lưu ảnh theo băm nội dung
- **Cho** ảnh đạt kiểm duyệt
- **Khi** pipeline lưu ảnh
- **Thì** ảnh được chuyển WebP 256×256, lưu ở khóa `img/<12 ký tự đầu sha256 nội dung>.webp`; cùng nội dung thì cùng khóa và không tải lên lại; phần tử lưu khóa ảnh; graph chứa khóa ảnh trong phần kết quả đã mã hóa
- Ưu tiên: Bắt buộc

### AC-ART-05: Phục vụ ảnh qua Worker với cache bất biến
- **Cho** ảnh `img/abc123def456.webp` tồn tại
- **Khi** gọi `GET /img/abc123def456.webp`; và gọi một khóa không tồn tại hoặc sai định dạng
- **Thì** lần đầu trả 200 `image/webp` với `Cache-Control: public, max-age=31536000, immutable` và đưa vào Cache API; khóa không tồn tại trả 404, sai định dạng (không khớp `^[0-9a-f]{12}\.webp$`) trả 400 - cả hai dạng problem+json
- Ưu tiên: Bắt buộc

### AC-ART-06: Client hiện emoji trước, ảnh sau
- **Cho** phần tử có khóa ảnh
- **Khi** phần tử được hiện; ảnh tải xong; hoặc ảnh tải lỗi
- **Thì** emoji hiện ngay; ảnh tải xong thì thay emoji; ảnh lỗi thì giữ emoji, không thử lại liên tục, không hiện biểu tượng ảnh vỡ
- Ưu tiên: Bắt buộc

### AC-ART-07: Ảnh bị chặn không được tải
- **Cho** danh sách chặn có ảnh của phần tử P (AC-REPORT-05 hoặc admin)
- **Khi** P được hiện
- **Thì** chỉ hiện emoji; client không gửi yêu cầu tới `/img/...` của ảnh đó
- Ưu tiên: Bắt buộc

### AC-ART-08: Phóng lớn bất ngờ khi ghép ra món lần đầu (thêm 2026-10-20)
- **Cho** thực khách ghép ra phần tử P chưa từng có trong Đĩa của mình (lần khám phá đầu tiên)
- **Khi** kết quả hiện ra; rồi thực khách bấm vào lớp phủ, nhấn Esc, hoặc chờ đủ 2,5 s
- **Thì** ảnh vẽ tay của P (hoặc emoji của P nếu P không có ảnh, ảnh bị chặn hay ảnh chưa tải xong - AC-ART-06/07) hiện phóng lớn giữa bàn với tên P, kèm hiệu ứng bật ra; lớp phủ tự thu nhỏ về chỗ món trên bàn sau 2,5 s hoặc khi bấm/Esc; không chặn thao tác kéo thả tiếp; ghép lại ra món đã có trong Đĩa thì không phóng lớn; có `prefers-reduced-motion` thì hiện tĩnh không có hiệu ứng; tên P được đọc qua `aria-live` (thời lượng và hành vi ở chế độ Thử thách - câu hỏi mở 31)
- Ưu tiên: Bắt buộc
