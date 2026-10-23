# Tiêu chí nghiệm thu - Ảnh minh họa tự tạo (ART)

> Giai đoạn 2 (giai đoạn 1 chỉ emoji - trả lời câu hỏi phạm vi 2). Component: pipeline (vẽ + kiểm duyệt ảnh, adapter Workers AI / Gemini mock), worker (phục vụ `/img/*`), web (hiện ảnh).
> Test mang nhãn `AC-ART-ABUSE` / `AC-ART-VALIDATION` là test phòng thủ bổ sung (quy ước chung của dự án), không phải AC riêng.
> Cần kiểm tra trước khi làm: hạn mức Workers AI gói free. R2 đã bật ngày 2026-10-21, không bị đòi thẻ thanh toán (câu hỏi mở 13); bucket `lau-meme-img` / `lau-meme-img-staging`, binding `IMG` (`docs/dev/huong-dan-tai-khoan.md` mục 6).

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
- **Thì** ảnh vẽ tay của P (hoặc emoji của P nếu P không có ảnh, ảnh bị chặn hay ảnh chưa tải xong - AC-ART-06/07) hiện phóng lớn giữa bàn với tên P, kèm hiệu ứng bật ra; lớp phủ tự thu nhỏ về chỗ món trên bàn sau 2,5 s hoặc khi bấm/Esc; không chặn thao tác kéo thả tiếp; ghép lại ra món đã có trong Đĩa thì không phóng lớn; có `prefers-reduced-motion` thì hiện tĩnh không có hiệu ứng; tên P được đọc qua `aria-live`; ghép ra Món đặc biệt lần đầu trên bàn/nồi chính cũng phóng lớn như mọi món mới (chế độ Thử thách đã bỏ khi làm lại DAILY, cập nhật 2026-10-21 - câu hỏi mở 31)
- Ưu tiên: Bắt buộc

### AC-ART-09: Mẻ full vẽ ảnh cho phần tử mới (thêm 2026-10-21, ADR 0012)
- **Cho** mẻ `full` có `WORKERS_AI_TOKEN` và `CLOUDFLARE_ACCOUNT_ID`, crawl ra 22 meme mới qua kiểm duyệt, mỗi meme có gợi ý ảnh; kho đầu vào có `art_pending` rỗng
- **Khi** mẻ chạy tới bước vẽ minh họa (sau giám khảo, trước chọn Món đặc biệt và đăng mẻ)
- **Thì** pipeline vẽ đúng 20 phần tử (giới hạn 20 ảnh mỗi đợt); mỗi ảnh được chuyển WebP 256×256, Gemini kiểm chính các byte WebP đó (AC-ART-02), rồi tải lên `PUT /api/pipeline/images/{key}` **trước** khi đăng mẻ (đã có object cùng khóa thì không tải lại, AC-ART-04); phần tử trong graph đăng ra mang `image_key` của ảnh đã lên R2; 2 phần tử còn lại nằm trong `store.art_pending` và được vẽ trước phần tử mới ở đợt sau (AC-ART-03); tải lên lỗi thì mẻ vẫn thành công, phần tử đó không có `image_key` và vào chờ vẽ; bước vẽ chạy quá 8 phút thì dừng, phần còn lại chờ vẽ; báo cáo đợt (GitHub Issue) ghi số ảnh vẽ được, về emoji, chờ vẽ, số lần vẽ và số ảnh bị loại theo lý do; chạy lại cùng mẻ thì gửi cùng `seed` nên ra cùng khóa ảnh (AC-PIPE-10)
- Ưu tiên: Bắt buộc

### AC-ART-10: Thiếu cấu hình hoặc lỗi vẽ kéo dài không làm hỏng mẻ (thêm 2026-10-21, ADR 0012)
- **Cho** lần lượt: (a) thiếu `WORKERS_AI_TOKEN` hoặc `CLOUDFLARE_ACCOUNT_ID`; (b) Workers AI hoặc Gemini trả 401/403/404 (token, account hoặc model sai); (c) một phần tử gặp lỗi tạm thời (mạng, 5xx) ở 3 đợt liên tiếp trong khi phần tử khác vẫn vẽ được; (d) mọi lần vẽ của một đợt đều lỗi mạng
- **Khi** mẻ `full` chạy
- **Thì** cả bốn trường hợp mẻ vẫn thành công và đăng phần đã qua kiểm duyệt; (a) bỏ bước vẽ, phần tử mới vào chờ vẽ, báo cáo đợt cảnh báo thiếu cấu hình; (b) bước vẽ dừng ngay, mọi phần tử giữ chờ vẽ, không tính lần thử, báo cáo đợt cảnh báo lỗi cấu hình; (c) `art_attempts` của phần tử tăng mỗi đợt, sau đợt thứ 3 phần tử hết chờ vẽ và giữ emoji; (d) không phần tử nào bị tính lần thử (sự cố chung); báo cáo đợt đếm lỗi theo loại. Khác ART: thiếu `GEMINI_API_KEY` thì mẻ `full` thất bại (ADR 0011)
- Ưu tiên: Bắt buộc

### AC-ART-11: Vẽ bù ảnh cho phần tử lõi (thêm 2026-10-23)
- **Cho** mẻ `full` đủ cấu hình vẽ (AC-ART-10a không xảy ra); `art_pending` có 3 phần tử, đợt có 5 phần tử mới; kho có 174 phần tử lõi chưa có `image_key`, có `image_hint`
- **Khi** mẻ chạy tới bước vẽ minh họa
- **Thì** thứ tự vẽ: phần tử chờ vẽ, rồi phần tử mới, rồi phần tử lõi đang hoạt động chưa có ảnh (xếp depth tăng dần, rồi tên đã `fold`) cho tới đủ 20 ảnh mỗi đợt (AC-ART-09) ⇒ đợt này vẽ 3 + 5 + 12 phần tử lõi; ảnh lõi qua cùng kiểm duyệt (AC-ART-02), cùng luật lỗi và số lần thử (AC-ART-10); phần tử lõi đã có ảnh, đã hết lượt thử (giữ emoji) hoặc bị ẩn/chặn thì không vẽ lại; báo cáo đợt ghi thêm "Lõi còn chưa có ảnh: N"; mẻ `core` không vẽ (không đổi)
- Ưu tiên: Bắt buộc
