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
- **Thì** thứ tự vẽ: phần tử chờ vẽ, rồi phần tử mới, rồi phần tử lõi đang hoạt động chưa có ảnh (xếp depth tăng dần, rồi tên đã `fold`) cho tới đủ 20 ảnh mỗi đợt (AC-ART-09) ⇒ đợt này vẽ 3 + 5 + 12 phần tử lõi; ảnh lõi qua cùng kiểm duyệt (AC-ART-02), cùng luật lỗi và số lần thử (AC-ART-10); phần tử lõi đã có ảnh, đã hết lượt thử (giữ emoji) hoặc bị ẩn/chặn thì không vẽ lại; báo cáo đợt ghi thêm "Lõi còn chưa có ảnh: N" (N = lõi đang hoạt động, chưa có ảnh, chưa hết lượt thử, không bị chặn - số còn sẽ vẽ; chốt 2026-10-23); mẻ `core` không vẽ (không đổi)
- Ưu tiên: Bắt buộc

### AC-ART-12: Ưu tiên vẽ ảnh cho món sắp lên Vàng/Đỏ (thêm 2026-10-24)
- **Cho** mẻ `full` đủ cấu hình vẽ; hạn mức 20 ảnh/đợt (AC-ART-09); kho có 4 phần tử độ sâu ≥ 5 chưa có ảnh (đang bị giữ ở Xanh dương - AC-TIER-04), 1 phần tử admin gán Vàng mà ảnh vừa bị chặn do báo cáo (AC-REPORT), 3 phần tử chờ vẽ, 5 phần tử mới, 30 phần tử lõi chưa có ảnh
- **Khi** mẻ chạy tới bước vẽ minh họa
- **Thì** thứ tự vẽ (cập nhật thứ tự của AC-ART-11): trước hết phần tử tier tự động Vàng/Đỏ đang chờ ảnh và phần tử admin gán Vàng/Đỏ mà mất ảnh (xếp độ sâu giảm dần, rồi tên đã `fold`), rồi phần tử chờ vẽ, phần tử mới, phần tử lõi như AC-ART-11, tới đủ 20 ảnh; ảnh vẽ cùng phong cách vẽ tay chung và qua cùng kiểm duyệt (AC-ART-02); có ảnh hợp lệ thì phần tử lên tier tự động đúng độ sâu ngay trong graph của mẻ đó; phần tử admin gán Vàng/Đỏ mà không còn ảnh hợp lệ sau khi hết lượt vẽ được ghi vào báo cáo đợt "Vàng/Đỏ thiếu ảnh: <tên>" để admin xử lý (graph vẫn đăng, phần tử hiện emoji)
- Ưu tiên: Bắt buộc

### AC-ART-13: Admin tải tranh vẽ tay cho phần tử (thêm 2026-10-24)
- **Cho** token admin đúng; phần tử P chưa có ảnh hoặc có ảnh tự vẽ
- **Khi** admin tải lên một file PNG hoặc WebP ≤ 1 MB cho P; tải file sai định dạng, quá cỡ hoặc cho phần tử không tồn tại
- **Thì** file hợp lệ được chuẩn hóa về WebP 256×256 và lưu theo băm nội dung như AC-ART-04, gắn vào P thay ảnh cũ, ghi audit (trước/sau khóa ảnh) theo AC-ADMIN-09, có trong graph từ mẻ kế tiếp; ảnh do admin tải không qua kiểm duyệt LLM và không bị mẻ sau vẽ đè; sai định dạng hoặc quá cỡ trả 400, phần tử không tồn tại trả 404, không đổi gì (câu hỏi mở 70)
- Ưu tiên: Tùy chọn

### AC-ART-14: Dùng link ảnh của đề xuất làm ảnh món (thêm 2026-10-25, câu hỏi mở 46)
- **Cho** token admin đúng; đề xuất X chờ duyệt có link ảnh `https://example.com/a.png` (admin có thể sửa link trước theo AC-CONTRIB-07); đề xuất Y chờ duyệt không có link ảnh
- **Khi** admin duyệt X và chọn "Dùng link làm ảnh"; duyệt Y và chọn "Dùng link làm ảnh"; mẻ `full` kế tiếp chạy khi link trả ảnh PNG, JPEG hoặc WebP hợp lệ; và khi link lỗi (không tải được, không phải ảnh, quá 1 MB, chuyển hướng sang `http://`, trỏ vào địa chỉ nội bộ, loopback hoặc mạng riêng)
- **Thì** duyệt X trả 200, lựa chọn được lưu và có trong audit `approve_contribution`; duyệt Y trả 400, không đổi gì; mẻ kế tiếp pipeline tải link (chỉ `https://`, tối đa 1 MB, hết giờ sau 15 giây), chuẩn hóa về WebP 256×256 và lưu theo băm nội dung như AC-ART-04, gắn vào phần tử như ảnh admin tải (AC-ART-13: không qua kiểm duyệt LLM, mẻ sau không vẽ đè, coi là có ảnh khi tính tier); phần tử chọn dùng link không bao giờ được vẽ bằng Workers AI; link lỗi thì phần tử giữ emoji, mẻ sau thử lại, báo cáo đợt ghi "Link ảnh lỗi: N" (chỉ số đếm, không ghi link), admin vẫn có thể tải tranh thay theo AC-ART-13; link không bao giờ gửi cho Gemini, không hiện cho người chơi, trang quản trị vẫn không nhúng ảnh từ link
- Ưu tiên: Tùy chọn

### AC-ART-15: Job tìm ảnh trên web cho meme chưa có ảnh (thêm 2026-10-30, ADR 0024, câu hỏi mở 104)
- **Cho** workflow chạy tay `art-search` có đủ cấu hình (`ADMIN_TOKEN`, địa chỉ API quản trị của môi trường, khóa API tìm ảnh trong GitHub Secret); danh mục có phần tử A, B đang hoạt động chưa có ảnh (`image_key` rỗng), phần tử C có ảnh Workers AI, D có ảnh admin, E có ảnh đang bị ẩn/chặn, F bị ẩn
- **Khi** người chạy workflow, chọn môi trường (mặc định staging), số phần tử tối đa (mặc định 50) và chạy thử (mặc định tắt); với A, API tìm ảnh trả link ảnh hợp lệ; với B, mọi kết quả đều lỗi (không có kết quả, không tải được, không phải ảnh, quá 1 MB, chuyển hướng sang `http://`, trỏ vào địa chỉ nội bộ)
- **Thì** job đọc danh mục qua `GET /admin/elements`, chỉ chọn phần tử đang hoạt động có `image_key` rỗng (bỏ C, D, E, F), xếp độ sâu giảm dần rồi tên đã `fold`, lấy tối đa số phần tử đã chọn; với mỗi phần tử tìm ảnh với truy vấn "<tên phần tử> meme" (câu hỏi mở 104), thử lần lượt tối đa 3 kết quả đầu với cùng luật tải an toàn của AC-ART-14 (chỉ `https://`, tối đa 1 MB, hết giờ sau 15 giây, chặn địa chỉ nội bộ); ảnh tải được chuẩn hóa về WebP 256×256 rồi gắn qua `PUT /admin/elements/{id}/image` như ảnh admin tải (AC-ART-13: audit `set_image`, mẻ sau không vẽ đè, coi là có ảnh khi tính tier, có trong graph từ mẻ kế tiếp); ảnh không qua kiểm duyệt LLM và **không lọc mặt người thật hay bản quyền** (chủ dự án chốt 2026-10-30); B giữ emoji, lần chạy sau thử lại; gắn ảnh lỗi (API quản trị trả 4xx/5xx) thì đếm vào lỗi theo loại, phần tử giữ emoji và job đi tiếp phần tử sau; job có ngân sách 25 phút: hết ngân sách thì không xét phần tử mới, phần còn lại để lần chạy sau, job vẫn xanh và bản tóm tắt ghi "Dừng vì hết thời gian, còn N phần tử"; chạy thử thì chỉ in tên phần tử và link sẽ dùng, không gắn ảnh; bản tóm tắt của job ghi số phần tử xét, gắn được, không tìm được, lỗi tải theo loại; API tìm ảnh trả 401/403 hoặc hết hạn mức thì job dừng và đỏ, ảnh đã gắn trước đó giữ nguyên; tên phần tử chỉ gửi cho API tìm ảnh, không gửi dữ liệu người chơi; ảnh không ổn thì admin chặn ảnh (AC-ART-07) hoặc tải tranh thay (AC-ART-13), thực khách báo cáo ảnh như mọi ảnh khác (AC-REPORT)
- Ưu tiên: Tùy chọn
