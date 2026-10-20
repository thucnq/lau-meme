# Tiêu chí nghiệm thu - Công thức gia truyền (DISC)

> Giai đoạn 1. Component: web (UUID, nickname, gửi khám phá), worker (kiểm công thức, ghi người đầu tiên, giới hạn tần suất).
> UUID gửi qua header ở mọi yêu cầu của thực khách; chỉ gửi khi đã đồng ý (AC-PRIV-02). IP chỉ dùng dạng băm (AC-PRIV-06).

### AC-DISC-01: Sinh UUID cục bộ
- **Cho** trình duyệt chưa có UUID
- **Khi** mở trang lần đầu
- **Thì** client sinh UUID v4 bằng `crypto.randomUUID()` và lưu cục bộ; tải lại vẫn giữ UUID đó; UUID không hiện ở bất kỳ chỗ công khai nào
- Ưu tiên: Bắt buộc

### AC-DISC-02: Đặt nickname hợp lệ
- **Cho** thực khách đã đồng ý lưu nickname (AC-PRIV-03)
- **Khi** gửi `PUT` nickname "Bếp Trưởng 99"
- **Thì** trả 200 với nickname đã cắt khoảng trắng đầu/cuối; nickname dài 2–20 ký tự (mặc định), chỉ chữ (có dấu), số, khoảng trắng, `_`, `-`; đổi nickname thì mọi chỗ hiển thị dùng nickname mới
- Ưu tiên: Bắt buộc

### AC-DISC-03: Nickname bị từ chối
- **Cho** nickname rỗng, 1 ký tự, dài hơn 20 ký tự, có ký tự ngoài tập cho phép, chứa từ cấm hoặc bí danh bị chặn (so trên dạng `fold`, bỏ dấu câu/khoảng trắng - AC-MOD-06)
- **Khi** gửi `PUT` nickname
- **Thì** trả 422 problem+json với thông báo tiếng Việt chung ("Nickname không hợp lệ") - không nói từ nào bị chặn; nickname cũ giữ nguyên
- Ưu tiên: Bắt buộc

### AC-DISC-04: Nickname trùng
- **Cho** nickname "Bếp Trưởng" đã thuộc UUID khác (so trên dạng `fold`)
- **Khi** gửi `PUT` nickname "bep truong"
- **Thì** trả 409 problem+json "Nickname đã có người dùng" (mặc định duy nhất - câu hỏi mở)
- Ưu tiên: Bắt buộc

### AC-DISC-05: Ghi nhận người khám phá đầu tiên
- **Cho** phần tử C (không phải phần tử khởi đầu) chưa có ai khám phá; công thức A + B = C có thật và đang hoạt động
- **Khi** gửi `POST` khám phá `{a: "A", b: "B", result: "C"}` kèm UUID
- **Thì** trả 201 `{element, nickname, discovered_at, first: true}`; bản ghi khám phá lưu UUID, công thức đã dùng, thời điểm
- Ưu tiên: Bắt buộc

### AC-DISC-06: Đã có người khám phá
- **Cho** C đã có người khám phá
- **Khi** UUID khác gửi khám phá C bằng công thức có thật
- **Thì** trả 200 với người khám phá hiện có và `first: false`; bản ghi cũ không đổi
- Ưu tiên: Bắt buộc

### AC-DISC-07: Công thức không có thật
- **Cho** A + B không phải công thức đang hoạt động ra C (không tồn tại, kết quả khác, công thức hoặc phần tử đang ẩn/chặn)
- **Khi** gửi khám phá
- **Thì** trả 422 problem+json; không ghi gì
- Ưu tiên: Bắt buộc

### AC-DISC-08: Gửi đồng thời
- **Cho** C chưa có ai khám phá
- **Khi** 2 UUID gửi khám phá C cùng lúc
- **Thì** đúng 1 yêu cầu nhận 201 `first: true`, yêu cầu kia nhận 200 `first: false` với người đầu tiên; chỉ có 1 bản ghi khám phá cho C (ràng buộc duy nhất trong D1)
- Ưu tiên: Bắt buộc

### AC-DISC-09: Hiện Công thức gia truyền
- **Cho** C được khám phá bởi người có nickname "Bếp Trưởng"; D được khám phá bởi người không có nickname; E chưa ai khám phá
- **Khi** client gọi `GET` khám phá cho danh sách phần tử [C, D, E] (tối đa 50 phần tử/lần)
- **Thì** C hiện "Công thức gia truyền của Bếp Trưởng", D hiện "Công thức gia truyền của Thực khách ẩn danh", E không có dòng nào; phản hồi không chứa UUID và không chứa công thức đã dùng (tránh lộ đáp án); phản hồi cache được ≤ 60 s
- Ưu tiên: Bắt buộc

### AC-DISC-10: Phần tử khởi đầu không có Công thức gia truyền
- **Cho** phần tử khởi đầu "Cay"
- **Khi** gửi khám phá với `result: "Cay"`
- **Thì** trả 422 problem+json
- Ưu tiên: Bắt buộc

### AC-DISC-11: Giới hạn tần suất theo UUID và IP băm
- **Cho** cùng UUID gửi quá 30 khám phá/phút, hoặc cùng IP băm gửi quá 60 khám phá/phút (mặc định)
- **Khi** gửi yêu cầu vượt ngưỡng
- **Thì** trả 429 problem+json có `Retry-After`; không ghi gì
- Ưu tiên: Bắt buộc

### AC-DISC-12: Đầu vào sai định dạng
- **Cho** thiếu UUID, UUID không đúng định dạng v4, thiếu `a`/`b`/`result`, hoặc chuỗi dài hơn 100 ký tự
- **Khi** gửi khám phá hoặc đặt nickname
- **Thì** trả 400 problem+json; không ghi gì
- Ưu tiên: Bắt buộc
