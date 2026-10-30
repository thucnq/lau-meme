# Tiêu chí nghiệm thu - Kiểm duyệt nội dung tự động (MOD)

> Giai đoạn 2. Component: pipeline (logic thuần; phản hồi LLM truyền vào/mock). Danh mục cấm theo `ghi-chu-hop.md` mục 7 và luật người thật 7.1.
> Danh mục cấm: người thật bị chế giễu · chính trị · tôn giáo · tình dục · phân biệt vùng miền/sắc tộc/giới tính · body shaming · bạo lực · ma túy · tự hại · quấy rối/xâm hại.

### AC-MOD-01: Lớp 1 - danh sách từ cấm
- **Cho** danh sách từ cấm (lưu ngoài repo nếu nhạy cảm - `/dk:design` chốt) và khái niệm chứa một từ cấm, kể cả viết không dấu, hoa thường, chèn dấu chấm/khoảng trắng giữa các chữ
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm bị loại ở lớp 1, không gửi LLM; báo cáo đợt đếm vào "từ cấm"
- Ưu tiên: Bắt buộc

### AC-MOD-02: Lớp 2 - LLM phân loại theo danh mục
- **Cho** khái niệm qua lớp 1 và phản hồi LLM gắn danh mục "chính trị"
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm bị loại; báo cáo đợt đếm theo danh mục; khái niệm LLM trả "an toàn" thì đi tiếp
- Ưu tiên: Bắt buộc

### AC-MOD-03: Không chắc thì loại
- **Cho** phản hồi LLM là "không chắc", điểm tin cậy dưới ngưỡng, không đúng schema, hoặc lời gọi lỗi sau hết retry
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm bị loại (hoặc vào hàng chờ nếu do hết quota - AC-PIPE-12), không bao giờ được coi là an toàn
- Ưu tiên: Bắt buộc

### AC-MOD-04: Kiểm cả tên kết quả công thức và văn bản phụ
- **Cho** công thức mới có tên kết quả vi phạm; và phần tử an toàn nhưng gợi ý Daily hoặc gợi ý ảnh nhắc tới một vụ việc/người đang là tâm điểm
- **Khi** kiểm duyệt chạy
- **Thì** công thức đó bị loại; gợi ý vi phạm bị loại (phần tử không đủ điều kiện làm Món đặc biệt cho tới khi có gợi ý đạt); kiểm duyệt áp cho tên, emoji, mô tả, gợi ý Daily, gợi ý ảnh
- Ưu tiên: Bắt buộc

### AC-MOD-05: Luật người thật dựa trên ngữ cảnh nguồn
- **Cho** khái niệm "TG" kèm đoạn ngữ cảnh nguồn; LLM trả lời "có trỏ tới người cụ thể: <tên>, tên gọi khác: <bí danh 1>, <bí danh 2>"
- **Khi** kiểm duyệt chạy
- **Thì** payload gửi LLM có kèm đoạn ngữ cảnh nguồn (không chỉ tiêu đề); khái niệm bị loại; tên và mọi bí danh (dạng `fold`) được thêm vào danh sách chặn bí danh
- Ưu tiên: Bắt buộc

### AC-MOD-06: Danh sách chặn bí danh áp cho mọi đầu vào sau
- **Cho** danh sách chặn bí danh có "abc xyz"
- **Khi** đợt sau crawl được khái niệm chứa "ABC Xyz"; và thực khách đặt nickname "abcxyz" hoặc "a.b.c xyz"
- **Thì** khái niệm bị loại ở lớp 1; nickname bị từ chối theo AC-DISC-03 (danh sách bí danh được đồng bộ sang Worker)
- Ưu tiên: Bắt buộc

### AC-MOD-07: Tiếng lóng chung và hiện tượng chung được phép
- **Cho** khái niệm "Còn Cái Nịt" (tiếng lóng đã tách khỏi người gốc) với LLM trả "không trỏ tới người cụ thể"
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm đi tiếp
- Ưu tiên: Bắt buộc

### AC-MOD-08: Hoãn nội dung nóng vì một người
- **Cho** khái niệm hiện tượng chung được phép nhưng LLM đánh dấu "đang nóng vì một vụ của một người" vào ngày D
- **Khi** phần tử được thêm vào graph
- **Thì** phần tử có cờ hoãn đến D + 30 ngày: không được chọn làm Món đặc biệt và không có nhãn "MỚI" trước ngày đó (ngày so với `batch_at`, không dùng đồng hồ hệ thống); sau ngày đó được xét bình thường
- Ưu tiên: Bắt buộc

### AC-MOD-09: Không bao giờ - cáo buộc và quấy rối
- **Cho** khái niệm nhận ra được người thật gắn với cáo buộc (ứng xử, quấy rối, tình dục, pháp lý, nợ nần, đời tư), hoặc đùa về quấy rối/xâm hại dạng chung chung
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm bị loại, kể cả khi LLM chấm hài cao; tên/bí danh liên quan vào danh sách chặn bí danh
- Ưu tiên: Bắt buộc

### AC-MOD-10: Tên bị quản trị chặn không quay lại
- **Cho** quản trị đã "chặn" phần tử "X" (AC-ADMIN-05)
- **Khi** đợt sau crawl được khái niệm có `fold` trùng "X"
- **Thì** khái niệm bị loại ở lớp 1, báo cáo đợt đếm vào "đã bị chặn"
- Ưu tiên: Bắt buộc

### AC-MOD-11: Bị chặn thì lưu lại, không bỏ đi (thêm 2026-10-30)
- **Cho** đợt `full` có 4 khái niệm bị chặn: 1 chứa từ cấm (lớp 1), 1 trùng bí danh bị chặn (AC-MOD-06), 1 LLM gắn "chính trị" (lớp 2), 1 LLM trả "không chắc" (AC-MOD-03); khái niệm thứ 5 trùng `fold` với một dòng đã có trong danh sách "Bị chặn" từ đợt trước
- **Khi** đợt đăng
- **Thì** 4 khái niệm không vào graph (như cũ) nhưng được ghi vào danh sách "Bị chặn" cùng lần ghi nguyên khối với nội dung đợt (AC-PIPE-11), mỗi dòng gồm: tên, emoji và mô tả nếu đã có, nguồn (tên nguồn + URL), đoạn ngữ cảnh nguồn tối đa 500 ký tự, mọi lý do (mã + nhãn, không chỉ lý do đầu tiên), bước bị chặn (lớp 1 / lớp 2), đợt, thời điểm; khái niệm thứ 5 không tạo dòng mới mà tăng số lần gặp, cập nhật lần gặp cuối và gộp lý do mới; đợt lỗi giữa chừng không ghi gì; không có dữ liệu người chơi (AC-PIPE-13); báo cáo đợt vẫn chỉ đếm theo danh mục (AC-ADMIN-11); khái niệm hoãn vì hết quota không tính là bị chặn (vào hàng chờ, AC-PIPE-12)
- Ưu tiên: Bắt buộc

### AC-MOD-12: Không phải meme - lớp 1 theo dấu hiệu tiêu đề (thêm 2026-10-30)
- **Cho** các khái niệm crawl được có tên: "🔴 TRỰC TIẾP: BOX GAMING vs BOOM ESPORTS | GIAI ĐOẠN PLAYOFFS | ĐTDV MÙA ĐÔNG 2026", "🔴 TRỰC TIẾP: FPT POLYTECHNIC vs SAIGON PHANTOM | GIAI ĐOẠN PLAYOFFS | ĐTDV MÙA ĐÔNG 2026", "Ngày 1 | CKTG 2026 - Vòng Swiss Ngày 24.10.2026"; và các khái niệm đối chứng "Còn Cái Nịt", "Mèo vs Dưa Leo", "Live Laugh Love", "Mùa Đông Không Lạnh"
- **Khi** kiểm duyệt chạy
- **Thì** 3 khái niệm đầu bị loại ở lớp 1 (không gửi LLM) với lý do "không phải meme" khi **tên** có ít nhất một dấu hiệu: ký tự 🔴; cụm "trực tiếp", "livestream" hoặc "live stream" (không phân biệt dấu, hoa thường); từ 2 dấu "|" trở lên; ngày đủ ngày-tháng-năm (`24.10.2026`, `24/10/2026`, `24-10-2026`); cụm giải đấu "vòng bảng", "vòng loại", "vòng swiss", "vòng <số>", "giai đoạn", "playoff(s)", "mùa giải", "mùa xuân/hạ/hè/thu/đông <năm 4 chữ số>"; hoặc hơn 10 từ. Chỉ xét tên, không xét mô tả hay ngữ cảnh nguồn. Các khái niệm đối chứng đi tiếp sang lớp 2. Khái niệm bị loại vào danh sách "Bị chặn" với mã lý do `not_meme` (cùng mã với lớp 2, AC-MOD-13) và bước lớp 1 (AC-MOD-11); tab "Bị chặn" của trang quản trị hiện nhãn "Không phải meme" và lọc được theo lý do này; báo cáo đợt đếm vào "không phải meme"; admin Bỏ chặn thì mẻ sau bỏ qua lớp 1 và lớp 2 như AC-PIPE-21
- Ưu tiên: Bắt buộc

### AC-MOD-13: Không phải meme - lớp 2 LLM phân loại (thêm 2026-10-30)
- **Cho** khái niệm qua lớp 1: "đội tuyển bóng đá quốc gia bồ đào nha", "thủy tiên", `AI Rumpelstiltskin "Tip Toein' In My Jordans"` với phản hồi LLM gắn danh mục `not_meme`; và "Còn Cái Nịt" với phản hồi "an toàn"
- **Khi** kiểm duyệt chạy
- **Thì** yêu cầu phân loại gửi LLM có danh mục `not_meme` kèm định nghĩa: tên người, đội, câu lạc bộ, nhóm nhạc hoặc tổ chức đứng một mình; tên bài hát, phim, chương trình; tiêu đề trận đấu, livestream, tin tức hoặc sự kiện - không phải câu nói, hình ảnh hay trào lưu được chế lại; 3 khái niệm đầu bị loại với lý do "không phải meme", bước lớp 2, vào danh sách "Bị chặn" (AC-MOD-11); "Còn Cái Nịt" đi tiếp; luật người thật (AC-MOD-05) vẫn áp như cũ: khái niệm vừa `not_meme` vừa trỏ tới người cụ thể thì tên và bí danh vẫn vào danh sách chặn bí danh
- Ưu tiên: Bắt buộc
