# 0023 - mQuiz giao diện kiểu game quiz: không thư viện hoạt ảnh, QR bằng `qrcode-generator` tải lười, âm thanh Web Audio

- Trạng thái: Đề xuất
- Ngày: 2026-10-30
- Nguồn: AC-QUIZ-29..39; câu hỏi mở 99, 101; ADR 0017, ADR 0021

## Bối cảnh
- Góp ý 2026-10-30: làm mQuiz bắt mắt theo quy ước chung của thể loại game quiz (ô màu kèm ký hiệu, đồng hồ dạng thanh, phản hồi đúng/sai, bảng điểm động, bục nhận giải, QR, âm thanh). Không sao chép giao diện của game cụ thể nào.
- Web hiện chỉ phụ thuộc `react`/`react-dom`. Mỗi thư viện thêm vào là dung lượng tải trên điện thoại và một nguồn rủi ro chuỗi cung ứng.
- Người chơi ít, chạy trên điện thoại tầm trung; `prefers-reduced-motion` phải tắt được mọi hoạt ảnh (AC-QUIZ-36).

## Quyết định
- **Hoạt ảnh:** CSS transition/keyframes và một canvas confetti tự viết (chạy một lần, ≤ 3 giây, dừng khi `prefers-reduced-motion`). Không thêm thư viện hoạt ảnh. Bảng điểm trượt bằng kỹ thuật FLIP (đo vị trí trước/sau, transform).
- **Ô đáp án:** 4 màu cố định kèm ký hiệu ▲◆●■ để không phụ thuộc màu (người mù màu), tương phản chữ ≥ 4.5:1 đo trong test bằng hàm tính độ sáng tương đối.
- **QR (Tùy chọn):** `qrcode-generator` (MIT, không phụ thuộc, ≈ 20 KB) tải bằng `import()` chỉ khi phòng chờ hiện QR, vẽ SVG ngay trên trình duyệt từ link mời; không gọi dịch vụ QR bên ngoài (link mời không rời trình duyệt).
- **Âm thanh (Tùy chọn):** sinh bằng Web Audio (oscillator + gain), không tệp âm thanh. Bật mặc định nhưng chỉ phát sau lần chạm đầu tiên (chính sách tự phát của trình duyệt); nút 🔊/🔇 lưu `localStorage` (bọc try/catch), dùng chung khóa với cài đặt âm thanh của ADR 0017 nếu đã có.
- **Đếm người đã chốt:** tin WebSocket `progress { q, answered, total }` (contract 0.11.0, `docs/api/quiz-ws.md`). DO phát sau mỗi lần nộp hợp lệ và khi số người kết nối đổi trong lúc câu đang mở; không có seat hay đáp án (câu hỏi mở 101).
- **Chuỗi đúng 🔥:** tính ở client từ các tin `reveal` của chính mình, không đổi contract; vào lại giữa ván thì chuỗi tính từ lúc vào lại.

## Hệ quả
- Một phụ thuộc runtime mới (`qrcode-generator`), nằm trong chunk riêng; bundle chính không lớn thêm.
- Rung (`navigator.vibrate`) chỉ có trên Android; iOS bỏ qua, không lỗi.
- Test hoạt ảnh kiểm thuộc tính/lớp CSS và thời lượng khai báo, không đo khung hình.

## Phương án đã loại
- **Thư viện hoạt ảnh (framer-motion và tương tự):** nặng so với vài transition cần dùng.
- **API QR bên ngoài (ảnh từ dịch vụ khác):** lộ link mời cho bên thứ ba, phụ thuộc mạng.
- **Tự viết bộ mã hóa QR:** Reed-Solomon và mặt nạ dễ sai, không đáng so với một thư viện nhỏ đã kiểm chứng.
- **Tệp âm thanh mp3/ogg:** thêm tải xuống và giấy phép âm thanh; tiếng bíp tổng hợp đủ cho mục đích.
