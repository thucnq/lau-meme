# Tiêu chí nghiệm thu - Pipeline Mẻ nhúng mới (PIPE)

> Component: pipeline (Python, GitHub Actions). Logic thuần: không mạng/đồng hồ/ngẫu nhiên - giờ mẻ, kết quả crawl và phản hồi LLM truyền vào như dữ liệu; adapter mạng tách riêng và được mock trong test.
> **Giai đoạn 1**: chỉ AC-PIPE-01, 02, 11, 13, 14 (chế độ lõi). **Giai đoạn 2**: phần còn lại (chạy tay trước, bật cron tự động đăng sau).
> Kiểm duyệt nằm ở MOD, vẽ ảnh ở ART, chọn Món đặc biệt ở DAILY.

### AC-PIPE-01: Chế độ lõi (giai đoạn 1)
- **Cho** kho nội dung chỉ có lõi classic và cấu hình `mode=core`
- **Khi** mẻ chạy (cron hoặc chạy tay) lúc T
- **Thì** pipeline không gọi adapter crawl nào và không gọi LLM; chọn Món đặc biệt mới (AC-DAILY-01), xuất graph + manifest version mới với `batch_at` = T (AC-GRAPH-04), deploy, ghi báo cáo đợt (AC-PIPE-14)
- Ưu tiên: Bắt buộc

### AC-PIPE-02: Lịch chạy và chạy tay
- **Cho** workflow mẻ nhúng trong `.github/workflows/`
- **Khi** đọc cấu hình workflow
- **Thì** có `schedule` cron `0 17 * * *` và `0 5 * * *` (00:00 và 12:00 GMT+7), có `workflow_dispatch` với tham số chế độ (`core`/`full`), có `timeout-minutes: 15` và `concurrency` để không có 2 mẻ chạy cùng lúc
- Ưu tiên: Bắt buộc

### AC-PIPE-03: Một nguồn lỗi không làm hỏng cả đợt
- **Cho** 5 adapter (Reddit, Know Your Meme, Google Trends VN, YouTube trending, RSS) trong đó adapter Reddit ném lỗi / hết thời gian
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

### AC-PIPE-08: Công thức bổ sung
- **Cho** phần tử đang hoạt động P có ít hơn 3 công thức mà P là đầu vào
- **Khi** bước công thức bổ sung chạy
- **Thì** pipeline xin LLM thêm công thức cho P với kết quả là phần tử đã có hoặc phần tử mới đã qua kiểm duyệt; mọi công thức bổ sung đều qua cùng luật hợp lệ như AC-PIPE-06 và qua giám khảo (AC-PIPE-09); báo cáo đợt ghi số phần tử còn dưới 3 công thức đi ra
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
