# Tiêu chí nghiệm thu - Graph mã hóa + manifest + rollback (GRAPH)

> Giai đoạn 1. Component: pipeline (xuất graph, manifest, rollback - logic thuần), worker (phục vụ manifest/graph), web (giải mã).
> Thuật toán cụ thể (hàm băm, KDF, mã hóa) chốt ở `/dk:design` (ADR). AC chỉ ràng buộc tính chất.

### AC-GRAPH-01: Khóa tra cứu là băm của cặp tên đã chuẩn hóa
- **Cho** công thức "Cay" + "Cười" = "Tới Công Chuyện"
- **Khi** pipeline xuất graph
- **Thì** mục của công thức có khóa = băm(`fold("Cay")`, `fold("Cười")`) với cặp đã sắp xếp, nên khóa của (Cay, Cười) và (Cười, Cay) trùng nhau; khóa không chứa tên dạng đọc được
- Ưu tiên: Bắt buộc

### AC-GRAPH-02: Kết quả mã hóa bằng khóa dẫn xuất từ 2 tên đầu vào
- **Cho** graph đã xuất
- **Khi** client giải mã mục của cặp (A, B) bằng 2 tên A và B
- **Thì** nhận đúng thông tin kết quả (tên, emoji, depth, mẻ thêm vào, khóa ảnh nếu có); giải mã bằng (A, X) với X ≠ B, hoặc bằng khóa băm thiếu tên, thất bại có kiểm soát (không ném lỗi ra UI, coi như trượt)
- Ưu tiên: Bắt buộc

### AC-GRAPH-03: Graph công khai không lộ tên kết quả
- **Cho** graph xuất từ lõi classic
- **Khi** kiểm file graph và manifest với mọi phần tử có depth ≥ 1
- **Thì** graph ngoài 3 khóa cố định (`format`, `version`, `entries`) chỉ chứa khóa và giá trị dạng base64url; trong graph không tìm thấy chuỗi con là tên (dạng gốc hoặc `fold`) dài ≥ 6 ký tự hoặc có ký tự ngoài bảng base64url (dấu cách, chữ có dấu), cũng không có emoji nào của chúng; trong manifest (trừ `miss_lines`) không giá trị chuỗi nào chứa tên hoặc `fold` của chúng dưới dạng nguyên từ; chỉ tên 4 phần tử khởi đầu được phép xuất hiện dạng đọc được (trong manifest). Tên ngắn dạng ASCII (vd `fold("Ế")` = "e", "gg") được bảo vệ bởi ràng buộc chỉ-base64url vì chúng trùng ngẫu nhiên với bản mã.
- Ưu tiên: Bắt buộc

### AC-GRAPH-04: Manifest có version và giờ mẻ thật
- **Cho** một mẻ chạy xong lúc T (giờ thật của máy chạy, truyền vào hàm xuất như tham số)
- **Khi** pipeline xuất manifest và client gọi `GET` manifest
- **Thì** manifest có: `version` tăng nghiêm ngặt so với bản trước, `batch_at` = T (ISO 8601 UTC), đường dẫn graph của version đó, 4 phần tử khởi đầu, danh sách câu Nồi trào, thông tin Món đặc biệt (AC-DAILY-03); manifest phục vụ với cache ngắn (≤ 60 s), graph phục vụ với `Cache-Control: public, max-age=31536000, immutable`
- Ưu tiên: Bắt buộc

### AC-GRAPH-05: Giữ 14 bản gần nhất
- **Cho** đã có 14 bản graph + manifest
- **Khi** mẻ thứ 15 xuất thành công
- **Thì** còn đúng 14 bản: bản cũ nhất bị xóa, bản mới thành hiện hành
- Ưu tiên: Bắt buộc

### AC-GRAPH-06: Rollback về đợt trước bằng một lệnh
- **Cho** bản hiện hành V và bản trước V−1 còn lưu
- **Khi** quản trị chạy workflow rollback chạy tay (không tham số, hoặc chỉ định version)
- **Thì** manifest hiện hành trỏ về V−1 (hoặc version chỉ định) trong ≤ 5 phút; nội dung (phần tử, công thức, Món đặc biệt) phục vụ cho DISC/DAILY khớp với version đó; workflow ghi bản rollback vào báo cáo đợt
- Ưu tiên: Bắt buộc

### AC-GRAPH-07: Rollback khi không có bản trước
- **Cho** chỉ còn 1 bản, hoặc version chỉ định không tồn tại
- **Khi** chạy workflow rollback
- **Thì** workflow thất bại với thông báo rõ ràng, bản hiện hành không đổi
- Ưu tiên: Bắt buộc

### AC-GRAPH-08: Manifest chưa có
- **Cho** môi trường mới chưa chạy mẻ nào
- **Khi** gọi `GET` manifest
- **Thì** trả 503 `application/problem+json` với `title` tiếng Việt; client hiện thông báo lỗi theo AC-GAME-16
- Ưu tiên: Bắt buộc
