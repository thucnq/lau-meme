# Tiêu chí nghiệm thu - Ngon / Nhạt (FEEDBACK)

> Tùy chọn (không có trong danh sách MVP). Component: web (nút), worker (lưu phiếu, tổng hợp), pipeline (đọc tỉ lệ ở đợt sau).

### AC-FEEDBACK-01: Bỏ phiếu sau khi ghép
- **Cho** thực khách vừa ghép A + B = C và đã đồng ý gửi dữ liệu
- **Khi** bấm "Ngon" hoặc "Nhạt" trên kết quả
- **Thì** client gửi `PUT` phiếu cho công thức (A, B) kèm UUID, trả 200; nút đã chọn được đánh dấu; sau khi phiếu được ghi, client xếp sự kiện `feedback` (`value`) vào hàng đợi metrics (AC-METRIC-04, câu hỏi mở 63)
- Ưu tiên: Tùy chọn

### AC-FEEDBACK-02: Một phiếu mỗi UUID mỗi công thức
- **Cho** UUID đã bỏ "Ngon" cho (A, B)
- **Khi** bỏ "Nhạt" cho (B, A)
- **Thì** phiếu cũ được thay bằng "Nhạt" (cặp không thứ tự); tổng phiếu của công thức vẫn tính 1 cho UUID đó
- Ưu tiên: Tùy chọn

### AC-FEEDBACK-03: Phiếu không hợp lệ
- **Cho** công thức không có thật / không hoạt động, giá trị ngoài {ngon, nhat}, hoặc thiếu UUID
- **Khi** gửi phiếu
- **Thì** công thức không có thật trả 422, giá trị sai 422, thiếu UUID 400 - problem+json; vượt 60 phiếu/phút/UUID trả 429
- Ưu tiên: Tùy chọn

### AC-FEEDBACK-04: Pipeline ẩn công thức nhiều "Nhạt"
- **Cho** tổng hợp ẩn danh (không UUID): công thức X có 12 phiếu, 8 "Nhạt"; công thức Y có 5 phiếu, 5 "Nhạt"
- **Khi** đợt sau chạy
- **Thì** X (≥ 10 phiếu và ≥ 60 % "Nhạt" - ngưỡng mặc định, câu hỏi mở) bị ẩn khỏi graph mới, trừ khi là công thức duy nhất giữ phần tử tới được (khi đó chỉ ghi cảnh báo); Y giữ nguyên vì chưa đủ phiếu; báo cáo đợt liệt kê công thức bị ẩn do "Nhạt"
- Ưu tiên: Tùy chọn

### AC-FEEDBACK-05: Chỉ tính phiếu của người đã chơi (thêm 2026-10-27, câu hỏi mở 85)
- **Cho** công thức X có 12 phiếu "Nhạt": 9 phiếu từ UUID chưa có lịch sử chơi, 3 phiếu từ UUID đã chơi (UUID có ít nhất một dòng Công thức gia truyền, hoặc ít nhất một sự kiện `combine_summary` với `ok` ≥ 1 còn trong thời hạn giữ 90 ngày)
- **Khi** pipeline đọc `/pipeline/state.feedback`
- **Thì** X chỉ có 3 phiếu (3 "Nhạt"): phiếu của UUID chưa chơi vẫn được lưu (`PUT /votes` vẫn 200, AC-FEEDBACK-01) nhưng không được đếm vào tổng hợp; khi UUID đó có lịch sử chơi thì phiếu được đếm từ lần đọc tiếp theo; X không bị ẩn vì chưa đủ 10 phiếu
- Ưu tiên: Tùy chọn
