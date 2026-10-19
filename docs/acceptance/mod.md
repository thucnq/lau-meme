# Tiêu chí nghiệm thu — Kiểm duyệt nội dung tự động (MOD)

> Giai đoạn 2. Component: pipeline (logic thuần; phản hồi LLM truyền vào/mock). Danh mục cấm theo `ghi-chu-hop.md` mục 7 và luật người thật 7.1.
> Danh mục cấm: người thật bị chế giễu · chính trị · tôn giáo · tình dục · phân biệt vùng miền/sắc tộc/giới tính · body shaming · bạo lực · ma túy · tự hại · quấy rối/xâm hại.

### AC-MOD-01: Lớp 1 — danh sách từ cấm
- **Cho** danh sách từ cấm (lưu ngoài repo nếu nhạy cảm — `/dk:design` chốt) và khái niệm chứa một từ cấm, kể cả viết không dấu, hoa thường, chèn dấu chấm/khoảng trắng giữa các chữ
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm bị loại ở lớp 1, không gửi LLM; báo cáo đợt đếm vào "từ cấm"
- Ưu tiên: Bắt buộc

### AC-MOD-02: Lớp 2 — LLM phân loại theo danh mục
- **Cho** khái niệm qua lớp 1 và phản hồi LLM gắn danh mục "chính trị"
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm bị loại; báo cáo đợt đếm theo danh mục; khái niệm LLM trả "an toàn" thì đi tiếp
- Ưu tiên: Bắt buộc

### AC-MOD-03: Không chắc thì loại
- **Cho** phản hồi LLM là "không chắc", điểm tin cậy dưới ngưỡng, không đúng schema, hoặc lời gọi lỗi sau hết retry
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm bị loại (hoặc vào hàng chờ nếu do hết quota — AC-PIPE-12), không bao giờ được coi là an toàn
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

### AC-MOD-09: Không bao giờ — cáo buộc và quấy rối
- **Cho** khái niệm nhận ra được người thật gắn với cáo buộc (ứng xử, quấy rối, tình dục, pháp lý, nợ nần, đời tư), hoặc đùa về quấy rối/xâm hại dạng chung chung
- **Khi** kiểm duyệt chạy
- **Thì** khái niệm bị loại, kể cả khi LLM chấm hài cao; tên/bí danh liên quan vào danh sách chặn bí danh
- Ưu tiên: Bắt buộc

### AC-MOD-10: Tên bị quản trị chặn không quay lại
- **Cho** quản trị đã "chặn" phần tử "X" (AC-ADMIN-05)
- **Khi** đợt sau crawl được khái niệm có `fold` trùng "X"
- **Thì** khái niệm bị loại ở lớp 1, báo cáo đợt đếm vào "đã bị chặn"
- Ưu tiên: Bắt buộc
