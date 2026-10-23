# Tiêu chí nghiệm thu - Thẻ chia sẻ (SHARE)

> Giai đoạn 1. Component: web (tạo thẻ chữ và ảnh PNG ở client, không gọi server để vẽ). Không lộ đáp án.

### AC-SHARE-01: Thẻ Daily dạng chữ
- **Cho** thực khách hoàn thành Món đặc biệt của mẻ 12:00 ngày 20/10 sau 1 giờ 05 phút kể từ lúc mẻ lên (thời gian giải do server tính, AC-DAILY-06), xếp hạng 12 trong mẻ, món có emoji 📈
- **Khi** mở thẻ chia sẻ Daily
- **Thì** chữ có dạng:
  ```
  Lẩu Meme 🍲 Món đặc biệt 20/10 · mẻ 12h
  📈 giải sau 1 giờ 05 phút · hạng #12
  <link trang chủ>?ref=daily
  ```
  không chứa tên món đích và không chứa tên 2 phần tử đã ghép ra món; chưa đăng nhập thì không có thẻ chia sẻ Daily, vì chỉ lời giải đã đăng nhập mới được ghi nhận (cập nhật 2026-10-23, câu hỏi mở 58)
- Ưu tiên: Bắt buộc

### AC-SHARE-02: Thời gian giải trên thẻ (cập nhật 2026-10-21, thay chuỗi emoji các bước)
- **Cho** thời gian giải 45 phút 08 giây; và 26 giờ 3 phút (mẻ kéo dài)
- **Khi** tạo thẻ Daily
- **Thì** thẻ hiện "45 phút" và "26 giờ 03 phút" (làm tròn xuống phút, dưới 1 phút hiện "dưới 1 phút"); không còn chuỗi emoji các bước vì DAILY không đếm bước nữa
- Ưu tiên: Bắt buộc

### AC-SHARE-03: Thẻ Daily dạng ảnh PNG
- **Cho** cùng dữ liệu như AC-SHARE-01
- **Khi** bấm "Lưu ảnh" / "Chia sẻ ảnh"
- **Thì** client tạo PNG 1080×1080 hình nồi lẩu có: logo chữ "Lẩu Meme", ngày + mẻ, emoji món, thời gian giải, hạng (nếu có), link; không chứa tên món và tên 2 phần tử đã ghép
- Ưu tiên: Bắt buộc

### AC-SHARE-04: Thẻ Công thức gia truyền
- **Cho** thực khách vừa được ghi là người đầu tiên khám phá phần tử 🧅 "Ăn Hành" (AC-DISC-05)
- **Khi** mở thẻ chia sẻ
- **Thì** có chữ "Mình là người đầu tiên nấu ra 🧅 Ăn Hành trên Lẩu Meme - Công thức gia truyền của <nickname>" + link `?ref=disc` và ảnh PNG 1080×1080 tương ứng; không chứa 2 phần tử đầu vào của công thức
- Ưu tiên: Bắt buộc

### AC-SHARE-05: Sao chép và chia sẻ hệ thống
- **Cho** thẻ đang mở
- **Khi** bấm "Chia sẻ" trên trình duyệt có `navigator.share`; trên trình duyệt không có; và bấm "Sao chép"
- **Thì** có `navigator.share` thì mở bảng chia sẻ hệ thống với chữ (và ảnh nếu `navigator.canShare` cho phép file); không có thì sao chép chữ vào clipboard; "Sao chép" luôn sao chép chữ; cả hai hiện thông báo "Đã sao chép" khi sao chép xong; người dùng hủy bảng chia sẻ thì không báo lỗi
- Ưu tiên: Bắt buộc

### AC-SHARE-06: Ghi sự kiện chia sẻ
- **Cho** thực khách đã đồng ý gửi dữ liệu
- **Khi** chia sẻ hoặc sao chép thành công thẻ Daily / thẻ Công thức gia truyền
- **Thì** client gửi sự kiện `share` với `card: daily|discovery` (theo contract, cập nhật 2026-10-23) và `method: native|copy|image` (AC-METRIC-02); chưa đồng ý thì không gửi
- Ưu tiên: Bắt buộc
