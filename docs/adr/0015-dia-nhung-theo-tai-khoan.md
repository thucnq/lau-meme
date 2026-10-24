# 0015 - Đĩa nhúng theo tài khoản lưu ở D1, server kiểm công thức, client gộp

- Trạng thái: Đề xuất
- Ngày: 2026-10-24
- Nguồn: SYNC (AC-SYNC-01..10), AC-AUTH-04/06 cập nhật; câu hỏi mở 68, 71, 75

## Bối cảnh
- Trước đây Đĩa nhúng chỉ lưu cục bộ trên từng trình duyệt (AC-GAME-10). Góp ý 2026-10-24: các phiên của cùng một tài khoản phải gộp Đĩa cho nhau.
- Chỉ tài khoản Google gộp được (câu hỏi mở 75): UUID ẩn danh không nối được hai máy (ADR 0004).
- Graph mã hóa (ADR 0002): client chỉ biết tên kết quả sau khi tự ghép ra. Server không được nhận một phần tử nếu không có bằng chứng đã ghép ra nó, nếu không Đĩa của tài khoản thành chỗ "mở khóa" tên chưa ghép.
- Không có nút xóa Đĩa (câu hỏi mở 71). Chỉ xóa tài khoản mới xóa Đĩa.

## Quyết định
- **Bảng `account_element`** (migration `0008_account_plate_auto_tier.sql`): khóa `(account_id, element_id)`, `found_at` là lúc server nhận lần ghi đầu, `ON DELETE CASCADE` theo `account`. 4 phần tử khởi đầu không lưu. Vị trí món trên bàn không đồng bộ.
- **Bằng chứng = cặp tên đã dùng.** Mỗi lần ghi gửi `Combination` (`a`, `b`, `result` dạng tên, như `POST /discoveries`). Worker đổi sang ElementId và kiểm trong danh mục `recipe`:
  - `last_version` ≥ version cũ nhất còn giữ (14 bản, AC-GRAPH-05), để người đang giữ graph cũ vẫn ghi được.
  - Công thức và phần tử không bị chặn (AC-REPORT-09).
  - Lỗi không nói cặp đó có ra món khác hay không (AC-SYNC-04).
- **Ba endpoint**, đều xác định tài khoản **chỉ** từ cookie phiên (AC-SYNC-05):
  - `GET /me/plate` trả cả Đĩa.
  - `POST /me/plate` ghi một món. Trả 404 hoặc 422 rõ ràng.
  - `POST /me/plate/merge` gộp ≤ 500 món (sau đăng nhập, gửi bù). Mục sai chỉ báo bằng chỉ số trong `skipped`, mục đúng vẫn ghi trong một `DB.batch`.
- **Giới hạn:** 120 lần ghi/phút/tài khoản qua `rate_counter` sẵn có, scope `plate` (câu hỏi mở 68). Mỗi lần gộp tính là 1 lần ghi.
- **Client gộp:** khi tải trang có phiên thì lấy `GET /me/plate`, hợp với Đĩa cục bộ, thời điểm khám phá lấy giá trị sớm nhất. Phần tử cục bộ chưa có trên server mà có cặp thì gửi `merge`. Các lần ghi lỗi mạng/5xx/429 vào hàng chờ cục bộ (khóa `laumeme:`), gửi bù có giới hạn số lần, bỏ khỏi hàng khi đã nhận 200.
- **`GET /me/plate` không phân trang** (lệch quy ước max 100/trang): Đĩa bị chặn bởi số phần tử danh mục (≤ 20 000, `BatchContent.elements.maxItems`). Client cần cả Đĩa trước khi vẽ. Một lần đọc theo khóa chính là đủ rẻ trên D1.

## Hệ quả
- Một bảng mới. Dữ liệu cá nhân gắn tài khoản: thêm vào xuất dữ liệu (`MyData.account.plate`), xóa tài khoản, và trang chính sách (AC-SYNC-10).
- Ghi không chặn trò chơi: game cập nhật Đĩa cục bộ trước, request chạy nền.
- Phần tử bị ẩn hoặc rời graph vẫn nằm trong `account_element`. Client ẩn theo danh sách chặn và graph hiện hành, bỏ chặn thì hiện lại (AC-SYNC-08).
- Mỗi lần ghép ra món mới thêm 1 request D1 (2 truy vấn đọc + 1 ghi). Với tải của dự án, gói free D1 dư.

## Phương án đã loại
- **Gửi cả Đĩa cục bộ không kèm cặp:** ai cũng tự thêm được tên chưa ghép, phá AC-GRAPH-03.
- **Đồng bộ qua `discovery` theo UUID:** `discovery` chỉ ghi người đầu tiên và gắn UUID, không gắn tài khoản. Hai máy của cùng tài khoản vẫn không thấy nhau.
- **Lưu Đĩa dạng một cột JSON trên `account`:** ghi đồng thời từ hai máy sẽ đè nhau (mất phần tử), và không dùng được `ON CONFLICT` theo từng phần tử.
- **KV/Durable Object:** thêm hạ tầng mà D1 đã đủ (ADR 0001).
