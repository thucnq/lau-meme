# Tiêu chí nghiệm thu - Đĩa nhúng theo tài khoản (SYNC)

> Thêm 2026-10-24 (góp ý gameplay). Component: worker (lưu và trả Đĩa của tài khoản, D1), web (gộp Đĩa khi tải trang và sau mỗi lần ghép).
> Chỉ áp cho thực khách **đã đăng nhập Google** (AUTH). Chưa đăng nhập thì Đĩa vẫn chỉ lưu cục bộ như AC-GAME-10.
> "Phiên" ở đây là một trình duyệt/máy đang chơi bằng cùng tài khoản. Đĩa của tài khoản = hợp của mọi phần tử các phiên đã ghép ra.
> Thay cho câu "Đĩa nhúng không đồng bộ" trong AC-AUTH-04 (cập nhật 2026-10-24).

### AC-SYNC-01: Ghép ra món mới thì ghi vào Đĩa của tài khoản
- **Cho** tài khoản T đã đăng nhập ở máy 1; Đĩa của T có 4 phần tử khởi đầu; graph có A + B = C, A và B đã có trong Đĩa
- **Khi** máy 1 ghép A với B ra C lần đầu
- **Thì** client gửi C kèm cặp (A, B) đã dùng; server kiểm A + B = C có trong graph đang giữ (bản hiện hành hoặc 14 bản giữ lại - AC-GRAPH), rồi thêm C vào Đĩa của T với thời điểm server nhận; trả 200 kèm số phần tử của Đĩa; gửi lại cùng C lần nữa trả 200, không tạo bản trùng, thời điểm khám phá giữ lần đầu; game không chờ phản hồi này mới cho ghép tiếp
- Ưu tiên: Bắt buộc

### AC-SYNC-02: Tải lại trang kéo Đĩa tổng hợp của mọi phiên
- **Cho** tài khoản T: máy 1 đã ghép ra C và D, máy 2 (UUID khác) đã ghép ra E, cả hai đều đã ghi vào Đĩa của T (AC-SYNC-01)
- **Khi** tải lại trang ở máy 2 (hoặc đăng nhập T ở máy 3 mới)
- **Thì** Đĩa ở máy 2 có 4 phần tử khởi đầu + C, D, E; thời điểm khám phá của mỗi phần tử là thời điểm sớm nhất trong các phiên; sắp xếp, nhãn "MỚI" (AC-GAME-09) và tìm kiếm chạy trên Đĩa tổng hợp; vị trí món trên bàn vẫn là của riêng từng máy (không đồng bộ bàn)
- Ưu tiên: Bắt buộc

### AC-SYNC-03: Tiến độ trước khi đăng nhập được gộp vào tài khoản
- **Cho** máy 1 chơi chưa đăng nhập, Đĩa cục bộ có thêm F và G (đã ghép ra bằng công thức có thật); Đĩa của T trên server có C
- **Khi** đăng nhập T ở máy 1
- **Thì** F và G được gửi lên kèm cặp đã dùng và thêm vào Đĩa của T theo AC-SYNC-01; Đĩa ở máy 1 sau đó = khởi đầu + C + F + G; phần tử cục bộ không gửi kèm được cặp hợp lệ thì vẫn giữ ở Đĩa cục bộ của máy 1 nhưng không vào Đĩa của T
- (cập nhật 2026-10-26, góp ý "chưa thấy đĩa được đồng bộ giữa các phiên") Phần tử cục bộ không lưu cặp (tiến độ ghép trước khi có SYNC, trước 2026-10-24): **Cho** Đĩa cục bộ của máy 1 có K không kèm cặp, graph đang giữ có A + B = K với A và B cũng đang ở Đĩa cục bộ của máy 1 (khởi đầu, có cặp hay không có cặp đều được) và không bị chặn (AC-GAME-15); **Khi** T đã đăng nhập ở máy 1 và trang tải xong (mỗi lần tải, không chỉ lần đăng nhập đầu); **Thì** client tự tìm một cặp như vậy trong graph đang giữ, lưu cặp đó cho K ở Đĩa cục bộ và gửi K kèm cặp lên theo lô như trên (server kiểm công thức như AC-SYNC-01/04, không đổi contract); thời điểm khám phá cục bộ của K giữ nguyên; người chơi không phải ghép lại; K không tìm được cặp nào từ Đĩa cục bộ thì giữ ở máy 1 như trên và lần tải sau thử lại (sau khi máy 1 có thêm món)
- Ưu tiên: Bắt buộc

### AC-SYNC-04: Từ chối phần tử không ghép ra được
- **Cho** tài khoản T đã đăng nhập
- **Khi** gửi phần tử X với cặp (A, B) mà graph không có A + B = X; gửi X không tồn tại; gửi body sai định dạng, thừa trường hoặc quá 64 KB
- **Thì** công thức không có thật trả 422 problem+json, phần tử không tồn tại trả 404, body sai trả 400; Đĩa của T không đổi; không lộ trong lỗi việc cặp đó có ghép ra món nào khác hay không
- Ưu tiên: Bắt buộc

### AC-SYNC-05: Chưa đăng nhập, phiên hết hạn và cách ly tài khoản
- **Cho** tài khoản T và tài khoản U, mỗi tài khoản có Đĩa riêng
- **Khi** gọi API Đĩa của tài khoản không có cookie phiên; với cookie đã đăng xuất; với cookie của U kèm header UUID của một máy đã gắn vào T
- **Thì** hai trường hợp đầu trả 401 problem+json, client tiếp tục chơi với Đĩa cục bộ; trường hợp ba chỉ đọc/ghi Đĩa của U, không phần tử nào của T lộ ra hay bị ghi
- Ưu tiên: Bắt buộc

### AC-SYNC-06: Mất mạng thì chơi tiếp, gửi bù sau
- **Cho** T đã đăng nhập, API Đĩa trả lỗi mạng hoặc 5xx
- **Khi** ghép ra H và I trong lúc lỗi; rồi API hoạt động lại (lần ghép sau hoặc tải lại trang)
- **Thì** H và I vẫn vào Đĩa cục bộ ngay, không hiện lỗi chặn người chơi; client gửi bù H và I khi API hoạt động lại (thử lại có giới hạn, không gửi trùng khi đã nhận 200); tải lại trang trong lúc lỗi thì dùng Đĩa cục bộ, không mất phần tử nào
- Ưu tiên: Bắt buộc

### AC-SYNC-07: Không có cách xóa Đĩa của tài khoản từ giao diện (cập nhật 2026-10-24 - câu hỏi mở 71)
- **Cho** T đã đăng nhập ở máy 1, Đĩa của T có 30 phần tử, trên bàn có món
- **Khi** bấm "Dọn bàn"; rồi tải lại trang
- **Thì** bàn trống, Đĩa vẫn có đủ 30 phần tử của T cả trước và sau khi tải lại; giao diện không có nút "Chơi lại từ đầu" hay nút xóa Đĩa nào (AC-GAME-11); API Đĩa không có endpoint xóa và không có request xóa nào được gửi
- Ưu tiên: Bắt buộc

### AC-SYNC-08: Phần tử bị chặn và graph đổi version
- **Cho** Đĩa của T có J; sau đó J bị chặn nóng (AC-GAME-15) hoặc bị ẩn ở mẻ sau; manifest lên version mới
- **Khi** tải lại trang
- **Thì** server vẫn giữ J trong Đĩa của T, client ẩn J như AC-GAME-15 (không hiện, không dùng để ghép); J được bỏ chặn thì hiện lại không cần ghép lại; đổi version graph không làm mất phần tử nào của Đĩa (AC-GAME-17)
- Ưu tiên: Bắt buộc

### AC-SYNC-09: Giới hạn tần suất và kích thước
- **Cho** T đã đăng nhập
- **Khi** gửi hơn 120 lần ghi trong 1 phút (mặc định - câu hỏi mở 68); gửi một lần gộp hơn 500 phần tử
- **Thì** vượt tần suất trả 429 problem+json kèm `Retry-After`, Đĩa không đổi, client gửi bù sau như AC-SYNC-06; lần gộp quá 500 phần tử trả 400 (client chia lô ≤ 500)
- Ưu tiên: Bắt buộc

### AC-SYNC-10: Xóa và xuất dữ liệu
- **Cho** Đĩa của T có 30 phần tử
- **Khi** T xem/xuất dữ liệu của mình (AC-PRIV-08); rồi xóa tài khoản (AC-AUTH-06)
- **Thì** bản xuất có danh sách phần tử của Đĩa kèm thời điểm khám phá; xóa tài khoản xóa toàn bộ Đĩa của T; đăng nhập lại bằng cùng Google bắt đầu với Đĩa chỉ có 4 phần tử khởi đầu (Đĩa cục bộ của máy đang dùng vẫn gộp lên theo AC-SYNC-03); trang chính sách (AC-PRIV-01) nêu thêm dữ liệu "danh sách món đã ghép ra theo tài khoản", mục đích "chơi tiếp trên nhiều máy", thời hạn "đến khi xóa tài khoản"
- Ưu tiên: Bắt buộc

### AC-SYNC-11: Quay lại tab thì kéo Đĩa mới của tài khoản (thêm 2026-10-26)
- **Cho** T đã đăng nhập và đang mở game ở cả máy 1 và máy 2; Đĩa ở máy 2 chưa có C (góp ý "chưa thấy đĩa được đồng bộ giữa các phiên")
- **Khi** máy 1 ghép ra C (AC-SYNC-01); máy 2 bị ẩn (chuyển tab, thu nhỏ, khóa màn hình) rồi hiện lại khi đã qua ít nhất 30 s từ lần kéo Đĩa trước của máy 2 (chốt 2026-10-26)
- **Thì** máy 2 kéo Đĩa của T (GET như AC-SYNC-02) và gộp vào Đĩa cục bộ mà không tải lại trang: C hiện trong Đĩa với nhãn "MỚI" (AC-GAME-09), thời điểm khám phá theo AC-SYNC-02; bàn, nồi và món đang kéo ở máy 2 không đổi; phần tử cục bộ máy 2 còn thiếu trên server được gửi bù như AC-SYNC-03/06; hiện lại khi chưa đủ 30 s từ lần kéo trước, hoặc lúc tab đang ẩn, thì không gọi API Đĩa; lỗi mạng, 5xx, 401, 429 xử lý như AC-SYNC-05/06/09 (không hiện lỗi chặn người chơi); chưa đăng nhập thì không gọi
- Ưu tiên: Bắt buộc
