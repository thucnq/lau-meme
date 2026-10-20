# Tiêu chí nghiệm thu — Nạp lõi nội dung classic (SEED)

> Giai đoạn 1. Component: pipeline (hàm thuần kiểm + nạp), đầu vào `noi-dung-loi.json` (khóa `starters`, `elements`, `recipes`, `miss_lines`, `daily_examples`).
> Lỗi kiểm tra ⇒ không nạp gì (toàn bộ hoặc không gì cả).

### AC-SEED-01: Nạp lõi hợp lệ
- **Cho** `noi-dung-loi.json` hiện tại
- **Khi** chạy lệnh nạp lõi vào kho nội dung rỗng
- **Thì** kho có 139 phần tử, 363 công thức, 40 câu Nồi trào, 4 phần tử khởi đầu (Cay, Cười, Toang, Deadline), mọi phần tử ở trạng thái hoạt động và gắn mẻ "classic"; lệnh in tóm tắt các con số này
- Ưu tiên: Bắt buộc

### AC-SEED-02: Phần tử không tới được
- **Cho** file lõi có phần tử X không phải khởi đầu và không là kết quả của công thức nào tới được từ 4 phần tử khởi đầu
- **Khi** chạy lệnh nạp
- **Thì** lệnh thất bại, liệt kê X; kho không đổi
- Ưu tiên: Bắt buộc

### AC-SEED-03: Trùng cặp
- **Cho** file lõi có 2 công thức (A, B) và (B, A), hoặc 2 công thức cùng cặp khác kết quả
- **Khi** chạy lệnh nạp
- **Thì** lệnh thất bại, liệt kê cặp trùng; kho không đổi
- Ưu tiên: Bắt buộc

### AC-SEED-04: Trùng tên sau chuẩn hóa hoặc trùng emoji
- **Cho** file lõi có "Cà Khịa" và "ca khia", hoặc 2 phần tử cùng emoji
- **Khi** chạy lệnh nạp
- **Thì** lệnh thất bại, liệt kê các phần tử trùng; kho không đổi
- Ưu tiên: Bắt buộc

### AC-SEED-05: Tham chiếu không tồn tại và tự tham chiếu
- **Cho** công thức có đầu vào hoặc kết quả không có trong `elements`, hoặc công thức có kết quả trùng một trong hai đầu vào
- **Khi** chạy lệnh nạp
- **Thì** lệnh thất bại, liệt kê công thức lỗi; kho không đổi
- Ưu tiên: Bắt buộc

### AC-SEED-06: Depth tính lại bằng BFS
- **Cho** file lõi có phần tử ghi `depth` khác độ dài đường ngắn nhất từ khởi đầu
- **Khi** chạy lệnh nạp
- **Thì** depth lưu trong kho là giá trị BFS; lệnh cảnh báo các phần tử lệch; 4 phần tử khởi đầu có depth 0
- Ưu tiên: Bắt buộc

### AC-SEED-07: Ràng buộc tên
- **Cho** phần tử có tên rỗng, tên dài hơn 4 từ, hoặc emoji rỗng
- **Khi** chạy lệnh nạp
- **Thì** lệnh thất bại, liệt kê phần tử lỗi; kho không đổi
- Ưu tiên: Bắt buộc

### AC-SEED-08: Nạp lại idempotent
- **Cho** kho đã nạp lõi
- **Khi** chạy lại lệnh nạp với cùng file
- **Thì** kho không đổi (cùng số bản ghi, cùng id, cùng depth); lệnh báo "không có thay đổi"
- Ưu tiên: Bắt buộc
