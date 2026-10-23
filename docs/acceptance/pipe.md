# Tiêu chí nghiệm thu - Pipeline Mẻ nhúng mới (PIPE)

> Component: pipeline (Python, GitHub Actions). Logic thuần: không mạng/đồng hồ/ngẫu nhiên - giờ mẻ, kết quả crawl và phản hồi LLM truyền vào như dữ liệu; adapter mạng tách riêng và được mock trong test.
> **Giai đoạn 1**: chỉ AC-PIPE-01, 02, 11, 13, 14 (chế độ lõi). **Giai đoạn 2**: phần còn lại (chạy tay trước, bật cron tự động đăng sau).
> Kiểm duyệt nằm ở MOD, vẽ ảnh ở ART, chọn Món đặc biệt ở DAILY.

### AC-PIPE-01: Chế độ lõi (giai đoạn 1)
- **Cho** kho nội dung chỉ có lõi classic và cấu hình `mode=core`
- **Khi** mẻ chạy (cron hoặc chạy tay) lúc T
- **Thì** pipeline không gọi adapter crawl nào và không gọi LLM; chọn Món đặc biệt mới (AC-DAILY-01), xuất graph + manifest version mới với `batch_at` = T (AC-GRAPH-04), deploy, ghi báo cáo đợt (AC-PIPE-14)
- Ưu tiên: Bắt buộc

### AC-PIPE-02: Lịch chạy và chạy tay (cập nhật 2026-10-23)
- **Cho** workflow mẻ nhúng trong `.github/workflows/`
- **Khi** đọc cấu hình workflow
- **Thì** có `schedule` cron `0 17 * * *` và `0 5 * * *` (00:00 và 12:00 GMT+7) cho production và cron `0 */2 * * *` (mỗi 2 tiếng, giờ chẵn UTC) cho staging (cập nhật 2026-10-23); cron nào kích hoạt thì chọn môi trường tương ứng (`github.event.schedule`), `BATCH_HOURS_UTC` của môi trường khớp lịch cron (AC-DAILY-12); có `workflow_dispatch` với tham số chế độ (`core`/`full`) và môi trường; có `timeout-minutes: 15` và `concurrency` theo môi trường để không có 2 mẻ cùng môi trường chạy cùng lúc
- Ưu tiên: Bắt buộc

### AC-PIPE-03: Một nguồn lỗi không làm hỏng cả đợt
- **Cho** các adapter (Reddit, Know Your Meme, Google Trends VN, YouTube trending, RSS, Tuổi Trẻ - AC-PIPE-15, Threads - AC-PIPE-17) trong đó adapter Reddit ném lỗi / hết thời gian
- **Khi** bước crawl chạy
- **Thì** khái niệm từ 4 adapter còn lại vẫn đi tiếp; báo cáo đợt ghi "Reddit: lỗi <loại lỗi>"; đợt không bị đánh dấu thất bại chỉ vì một nguồn
- Ưu tiên: Bắt buộc

### AC-PIPE-04: Adapter chỉ thu khái niệm, tôn trọng robots.txt
- **Cho** adapter nhận trang/API trả về có ảnh, video và đường dẫn bị robots.txt cấm
- **Khi** adapter chạy
- **Thì** mỗi khái niệm chỉ gồm tên, câu nói, đoạn ngữ cảnh nguồn, link nguồn, tên nguồn; không tải file ảnh/video nào; không truy cập đường dẫn bị cấm; không có adapter nào cho Facebook hoặc TikTok
- Ưu tiên: Bắt buộc

### AC-PIPE-05: Khử trùng
- **Cho** kho có "Còn Cái Nịt"; crawl trả về "con cai nit", "CÒN CÁI NỊT!!", và "Còn mỗi cái nịt"
- **Khi** bước khử trùng chạy
- **Thì** 2 khái niệm đầu bị loại bằng so khớp chuỗi `fold` (bỏ dấu, chữ thường, bỏ dấu câu) mà không gọi LLM; chỉ "Còn mỗi cái nịt" (gần giống) được gửi LLM hỏi trùng; LLM nói trùng thì loại
- Ưu tiên: Bắt buộc

### AC-PIPE-06: Liên kết ngược hợp lệ
- **Cho** meme mới M đã qua kiểm duyệt và LLM đề xuất 3 cặp: (A, B) hợp lệ, (A, C) đã có công thức khác, (M, A) tự tham chiếu
- **Khi** bước liên kết ngược chạy
- **Thì** chỉ (A, B) = M được thêm; 2 cặp kia bị loại kèm lý do; depth của M = min(depth A, depth B) + 1 theo BFS lại toàn graph; cặp có phần tử không tồn tại hoặc đang ẩn/chặn cũng bị loại
- Ưu tiên: Bắt buộc

### AC-PIPE-07: Hàng chờ meme chưa nối được
- **Cho** meme M không có cặp hợp lệ nào sau liên kết ngược
- **Khi** đợt kết thúc; rồi đợt sau chạy
- **Thì** M không vào graph, được đưa vào hàng chờ với số lần thử = 1; đợt sau M được thử lại trước meme mới; sau 6 lần thử không nối được thì bỏ khỏi hàng chờ và ghi vào báo cáo đợt (ngưỡng mặc định - câu hỏi mở)
- Ưu tiên: Bắt buộc

### AC-PIPE-08: Công thức bổ sung (cập nhật 2026-10-20)
- **Cho** phần tử đang hoạt động P có ít hơn 3 công thức mà P là đầu vào; và graph sau bước liên kết ngược
- **Khi** bước công thức bổ sung chạy
- **Thì** (1) pipeline xin LLM thêm công thức cho P tới khi đủ 3 công thức đi ra; (2) thêm tối đa 150 cặp mỗi đợt (hạn mức mặc định - câu hỏi mở 30) chọn trong các cặp **chưa có kết quả** theo mức "hay cùng nằm trên Đĩa": chạy mô phỏng AC-INV-12 (seed cố định) trên graph hiện tại, đếm số lượt mỗi phần tử có mặt trên Đĩa, xếp cặp theo tích hai số đếm giảm dần (bằng nhau thì theo thứ tự tên đã `fold`), bỏ cặp đã nằm trong danh sách "đã hỏi, bị loại"; với cả (1) và (2) kết quả là phần tử đã có hoặc phần tử mới đã qua kiểm duyệt, qua cùng luật hợp lệ như AC-PIPE-06 và qua giám khảo (AC-PIPE-09); cặp LLM trả "không hợp" hoặc bị giám khảo loại được ghi vào danh sách "đã hỏi, bị loại" để các đợt sau không hỏi lại; báo cáo đợt ghi số phần tử còn dưới 3 công thức đi ra, số cặp đã hỏi / được thêm, và tỉ lệ trượt AC-INV-12 trước và sau bước này
- Ưu tiên: Bắt buộc

### AC-PIPE-09: Giám khảo hài
- **Cho** các công thức mới với điểm LLM chấm theo rubric: 2, 3, 5 và một phản hồi không đọc được
- **Khi** bước giám khảo chạy
- **Thì** chỉ giữ công thức điểm ≥ 3; công thức điểm 2 và công thức không chấm được bị loại; điểm lưu kèm công thức
- Ưu tiên: Bắt buộc

### AC-PIPE-10: Idempotent
- **Cho** cùng ảnh chụp kho đầu vào, cùng kết quả crawl, cùng phản hồi LLM đã lưu theo mã đợt và cùng `batch_at`
- **Khi** chạy lại đợt đó
- **Thì** graph và manifest xuất ra giống hệt từng byte; không tạo phần tử/công thức trùng; không gọi lại LLM cho phần đã có phản hồi lưu
- Ưu tiên: Bắt buộc

### AC-PIPE-11: Lỗi giữa chừng không đăng gì
- **Cho** bản hiện hành V; đợt mới lỗi ở bất kỳ bước nào trước khi deploy xong (ném lỗi, kiểm tra bất biến INV thất bại, deploy lỗi)
- **Khi** đợt kết thúc
- **Thì** manifest hiện hành vẫn là V; kho nội dung phục vụ người chơi không đổi; workflow kết thúc với trạng thái lỗi và báo cáo đợt ghi bước lỗi
- Ưu tiên: Bắt buộc

### AC-PIPE-12: Gom lô Gemini, backoff, hết quota dừng êm
- **Cho** 25 khái niệm cần phân loại, kích thước lô cấu hình 10; Gemini trả 429 hai lần rồi thành công ở lô 1, và báo hết quota ở lô 3
- **Khi** các bước gọi LLM chạy
- **Thì** có đúng 3 lời gọi lô (10, 10, 5) cộng các lần retry; retry chờ theo backoff lũy thừa (thời gian chờ là tham số, test không ngủ thật); khi hết quota thì dừng gọi, các khái niệm chưa xử lý vào hàng chờ, phần đã xử lý và đạt kiểm duyệt vẫn được đăng; báo cáo đợt ghi "hết quota"
- Ưu tiên: Bắt buộc

### AC-PIPE-13: Không gửi dữ liệu người chơi cho LLM
- **Cho** pipeline và quyền truy cập của nó
- **Khi** xây payload gửi Gemini / Workers AI ở mọi bước
- **Thì** payload chỉ chứa dữ liệu meme công khai (tên, câu nói, ngữ cảnh nguồn, tên phần tử, gợi ý ảnh); token pipeline không có quyền đọc bảng người chơi (player, discovery, kết quả Daily, báo cáo, phiếu, sự kiện, đồng ý); test kiểm schema payload không có trường nào ngoài danh sách cho phép. Ngoại lệ duy nhất: số liệu tổng hợp ẩn danh của METRIC và tỉ lệ "Nhạt" theo công thức (FEEDBACK), không chứa UUID
- Ưu tiên: Bắt buộc

### AC-PIPE-14: Báo cáo đợt qua GitHub Issue
- **Cho** một đợt kết thúc (thành công, lỗi, hoặc rollback)
- **Khi** bước báo cáo chạy
- **Thì** một GitHub Issue được tạo với: version, `batch_at`, chế độ, trạng thái, số meme crawl/thêm/bị chặn (theo danh mục)/vào hàng chờ, lỗi từng nguồn, quota Gemini đã dùng, Món đặc biệt (emoji, không lộ tên trong tiêu đề), số liệu METRIC của đợt; lỗi khi tạo Issue chỉ ghi log, không làm đợt thất bại
- Ưu tiên: Bắt buộc

### AC-PIPE-15: Nguồn Tuổi Trẻ chuyên mục meme (thêm 2026-10-23)
- **Cho** trang `https://tuoitre.vn/meme.html` (HTML mẫu lưu trong test, không gọi mạng) có 20 bài, mỗi bài có tiêu đề, đoạn tóm tắt, link, ảnh đại diện; robots.txt của tuoitre.vn (mẫu) cấm `/tim-kiem.htm` và `/print/`
- **Khi** adapter Tuổi Trẻ chạy trong mẻ `full`
- **Thì** trả 20 khái niệm theo AC-PIPE-04: tên = tiêu đề bài, ngữ cảnh = đoạn tóm tắt (cắt tối đa 500 ký tự), link nguồn = link bài tuyệt đối, tên nguồn "Tuổi Trẻ"; không tải ảnh đại diện; chỉ đọc trang chuyên mục, không đi theo link bị robots.txt cấm; chỉ đọc trang 1 (mặc định); cấu trúc HTML đổi khiến không đọc được bài nào thì báo lỗi nguồn "Tuổi Trẻ: không đọc được trang" theo AC-PIPE-03, đợt không thất bại; User-Agent nêu tên dự án
- Ưu tiên: Bắt buộc

### AC-PIPE-16: Ghi mức trending (mặn) của phần tử (thêm 2026-10-23)
- **Cho** kho có "Còn Cái Nịt" (`trend_peak` = 2) và "Stonks" (`trend_peak` = 0); đợt crawl thu được 4 khái niệm khử trùng (AC-PIPE-05) về "Còn Cái Nịt" từ 3 nguồn khác nhau, 1 khái niệm về "Stonks", và meme mới M được thêm từ 2 khái niệm
- **Khi** đợt kết thúc thành công; rồi đợt sau crawl được 1 khái niệm về "Còn Cái Nịt"
- **Thì** mức trending của một phần tử trong một đợt = số khái niệm crawl của đợt đó trùng với phần tử (khớp `fold` hoặc LLM nói trùng ở AC-PIPE-05; với phần tử mới: số khái niệm gộp lại thành nó); `trend_peak` = mức cao nhất từng ghi nhận, gồm cả đợt hiện tại (câu hỏi mở 42): sau đợt 1 "Còn Cái Nịt" = 4, "Stonks" = 1, M = 2; sau đợt 2 "Còn Cái Nịt" vẫn = 4; phần tử chưa từng được crawl thấy có `trend_peak` = 0; mẻ `core` và đợt lỗi không đổi `trend_peak`; chạy lại cùng đợt (AC-PIPE-10) không cộng dồn; báo cáo đợt liệt kê 5 phần tử có mức trending cao nhất của đợt (tên không xuất hiện trong tiêu đề Issue)
- Ưu tiên: Bắt buộc

### AC-PIPE-17: Nguồn Threads qua API chính thức (thêm 2026-10-23)
- **Cho** mẻ `full` có GitHub Secret `THREADS_ACCESS_TOKEN` và variable `THREADS_KEYWORDS` (danh sách phân tách bằng dấu phẩy, vd. `meme,trend`); phản hồi mẫu của API tìm theo từ khóa của Threads (lưu trong test, không gọi mạng) có 15 bài công khai, mỗi bài có nội dung chữ, permalink, tên người đăng, ảnh/video
- **Khi** adapter Threads chạy
- **Thì** chỉ gọi API chính thức của Meta (không scrape trang threads.net); trả khái niệm theo AC-PIPE-04: tên/câu nói lấy từ nội dung bài, link nguồn = permalink, tên nguồn "Threads"; **không** lưu hay gửi LLM tên người đăng, ảnh đại diện, link hồ sơ; không tải ảnh/video; thiếu `THREADS_ACCESS_TOKEN` hoặc `THREADS_KEYWORDS` rỗng thì adapter không thu gì và báo cáo đợt cảnh báo thiếu cấu hình, đợt không thất bại; API trả 401/403 (token hết hạn, quyền chưa được duyệt) hoặc 429 thì ghi lỗi nguồn "Threads: <loại lỗi>" theo AC-PIPE-03; tối đa 50 bài mỗi đợt (mặc định)
- Ưu tiên: Bắt buộc
