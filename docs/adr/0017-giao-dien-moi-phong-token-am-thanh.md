# 0017 - Giao diện mới: hai họ phông tự phục vụ, một bộ token CSS, âm thanh tạo bằng Web Audio

- Trạng thái: Chấp nhận (người duyệt duyệt ảnh chụp 2026-10-25, với phông Helvetica, màu chủ đạo xanh lá và hai kiểu mặt bàn - xem mục Cập nhật; tông tier Xanh lá giữ nguyên)
- Ngày: 2026-10-24
- Nguồn: AC-GAME-27, AC-GAME-25/26, AC-GAME-18/22/23, AC-TIER-02, AC-SUBPATH-07; câu hỏi mở 72, 73, 74

## Bối cảnh
- Góp ý 2026-10-24: giao diện cần "đẹp hơn", có hệ thống thiết kế. AC-GAME-27 đòi:
  - Tối đa 2 họ phông, đủ dấu tiếng Việt, woff2 tự phục vụ dưới `/lau-meme/`, tổng ≤ 150 KB, không CDN.
  - Một bộ token có bản sáng/tối, tương phản ≥ 4,5:1.
  - Người duyệt bằng ảnh chụp 5 khung nhìn × 2 chế độ **trước khi build**.
- Hiện màu và khoảng cách rải rác trong CSS từng thành phần. Tier (AC-TIER-02) đã có 5 màu cần giữ nghĩa.
- Âm thanh Vàng/Đỏ (AC-GAME-26, Tùy chọn): mỗi file ≤ 50 KB, có giấy phép dùng được, không tải từ ngoài.

## Quyết định
- **Phông:**
  - **Be Vietnam Pro** (OFL) cho chữ thường và giao diện. Thiết kế cho tiếng Việt, dấu chồng không đè dòng.
  - **Baloo 2** (OFL) chỉ cho tiêu đề, tên game và thẻ kết quả. Tròn, vui, hợp chất "lẩu".
  - Chỉ cắt subset `latin` + `vietnamese`, mỗi họ tối đa 2 độ đậm (Be Vietnam Pro 400/600, Baloo 2 700). File để trong `web/public/fonts/`, `font-display: swap`. Test kiểm tổng ≤ 150 KB và chuỗi "Ầ ẫ ặ ỡ ự Đ".
- **Token:** một file `web/src/styles/tokens.css` khai báo biến CSS trên `:root` và bản tối trong `[data-theme="dark"]`. Thành phần chỉ được dùng biến, không viết mã màu trực tiếp. Lint màu viết cứng ngoài `tokens.css` thêm như một test, không sửa cấu hình eslint.
  - Màu: `--color-bg`, `--color-surface`, `--color-table` (mặt bàn), `--color-text`, `--color-text-muted`, `--color-accent` (đỏ ớt), `--color-broth` (nước lẩu cam hổ phách), `--color-focus`, `--tier-1..5` và `--tier-1..5-strong`.
  - Kích thước: `--space-1..8` (thang 4 px), `--radius-sm|md|lg|pill`, `--shadow-1..3`, `--font-body`, `--font-display`, `--text-xs..2xl`.
  - Chuyển động: `--motion-fast` (150 ms), `--motion-base` (250 ms), `--motion-celebrate` (Vàng ≤ 1,5 s, Đỏ ≤ 2,5 s - AC-GAME-25), tất cả về 0 dưới `prefers-reduced-motion`.
- **Hướng hình ảnh:** "quán lẩu đêm":
  - Nền kem ấm ở chế độ sáng, than tối ở chế độ tối.
  - Mặt bàn gỗ trầm, điểm nhấn đỏ ớt và vàng nước dùng.
  - Bo góc lớn, đổ bóng mềm.
- **Cổng duyệt ảnh chụp:** bước đầu của `/dk:build ui3` là tầng token + phông (chưa đổi bố cục):
  - Chạy skill design-taste-frontend để chỉnh hướng ở trên.
  - Chụp 5 khung nhìn của AC-GAME-18 × sáng/tối gửi người duyệt.
  - Duyệt xong mới viết test RED cho AC-GAME-27 và làm tiếp. Mã màu cụ thể được chốt ở bước này và ghi lại vào ADR này.
- **Hiệu ứng Vàng/Đỏ** (AC-GAME-25): CSS animation và canvas hạt nhẹ, không thư viện. Ghép ra lại chỉ có viền sáng ≤ 0,6 s (câu hỏi mở 74).
- **Âm thanh** (AC-GAME-26): tạo bằng Web Audio API (bộ dao động + đường bao), không có file âm thanh.
  - Không có vấn đề giấy phép, 0 KB tải về, không gọi ra ngoài.
  - `AudioContext` chỉ tạo sau thao tác ghép đầu tiên của người chơi.
  - Mặc định bật, nút loa lưu lựa chọn ở khóa `laumeme:` (câu hỏi mở 73).

## Cập nhật 2026-10-25 (góp ý khi duyệt ảnh chụp)
- **Phông:** người duyệt chọn **Helvetica** cho mọi chữ, thay Be Vietnam Pro + Baloo 2.
  - Helvetica có bản quyền, không tự phục vụ được: dùng phông của hệ điều hành `"Helvetica Neue", Helvetica, Arial, sans-serif`. Máy không có Helvetica (Windows, Android) dùng Arial/Roboto, đều đủ dấu tiếng Việt.
  - Bỏ 6 file woff2 trong `web/src/styles/fonts/`: 0 KB phông tải về, không còn `@font-face`.
- **Màu nhấn:** xanh lá thay đỏ ớt. Sáng `#13703a` (≥ 4,7:1 trên nền kem, mặt bàn và chữ trắng trên nút); tối `#4ade80` với chữ trên nút `#052e16`. Nồi lẩu giữ đỏ ớt và vàng nước dùng.
- **Emoji:** token `--font-emoji` (Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji) cho mọi chỗ hiện emoji, và thêm vào `--font-body` trước `sans-serif`. Thiếu nó, Windows/Linux vẽ emoji thành nét đen hoặc ô vuông (góp ý 2026-10-25).

- **Mặt bàn** (AC-GAME-28): bàn nhựa vỉa hè xanh dương (mặc định) và bàn vân gỗ, vẽ bằng gradient CSS (0 KB ảnh), nút đổi bàn lưu ở `laumeme:table`. Trên bàn nhựa lửa dưới nồi dùng màu hổ phách. Hình nhỏ tier có viền sáng `--color-badge-ring` để tách khỏi mặt bàn (AC-TIER-02).
- **Kiểm tra:** `web/src/game/ui27.browser.test.tsx` kiểm họ phông tính ra, không có `@font-face` hay file phông, không request ra ngoài, emoji màu, màu nhấn xanh lá, tương phản thực tế và không có màu viết cứng trong `index.css`. Ảnh chia sẻ (canvas, `src/share`) là PNG, không thuộc phạm vi token.

## Hệ quả
- Thêm khoảng ≤ 150 KB phông vào lần tải đầu (cache bất biến). Không thêm phụ thuộc npm.
- Mọi thành phần web phải chuyển sang token. Phần này tốn nhất trong UI3 (3 điểm).
- Ảnh chụp duyệt nằm trong `/dk:build ui3`, không nằm trong `/dk:design`: ảnh chụp cần app thật chạy với token mới. Đây là điểm lệch so với câu chữ "trước khi build" của AC-GAME-27; thứ tự vẫn giữ (duyệt trước khi viết test và đổi bố cục).

## Phương án đã loại
- **Google Fonts/CDN:** trái AC-GAME-27 và AC-SUBPATH-07, lộ IP người chơi cho bên thứ ba.
- **Tailwind hoặc thư viện component:** đổi cả cách viết CSS của web giữa chừng. Biến CSS đủ cho một bộ token.
- **File âm thanh CC0:** phải tìm, kiểm giấy phép, nén ≤ 50 KB. Web Audio cho tiếng ngắn đủ tốt mà không có file.
- **Thư viện hiệu ứng (vd. canvas-confetti):** thêm phụ thuộc cho hai hiệu ứng ngắn.
