# Tiêu chí nghiệm thu - Chơi ghép / Nhúng lẩu (GAME)

> Giai đoạn 1. Component: web (React) + logic tra graph thuần trong client. Test chạy ở ranh giới component/module, graph và manifest giả lập.
> Từ vựng: Nhúng lẩu = ghép; Nồi trào / Khét rồi = ghép trượt; Đĩa nhúng = kho phần tử của người chơi.

### AC-GAME-01: Bàn chơi lần đầu
- **Cho** trình duyệt chưa có tiến độ cục bộ và manifest + graph tải thành công
- **Khi** thực khách mở trang chủ
- **Thì** Đĩa nhúng có đúng 4 phần tử khởi đầu lấy từ manifest (🌶️ Cay, 😂 Cười, 💀 Toang, ⏰ Deadline với lõi hiện tại); nồi lẩu ở giữa có 2 chỗ thả trống
- Ưu tiên: Bắt buộc

### AC-GAME-02: Nhúng lẩu qua nồi - ghép thành công
- **Cho** Đĩa có A và B, graph có công thức A + B = C
- **Khi** thả A vào chỗ thả 1 và B vào chỗ thả 2 (chuột hoặc cảm ứng, qua Pointer Events)
- **Thì** hiệu ứng nồi sôi chạy tối đa 1,2 s; chạm/nhấp trong lúc hiệu ứng thì bỏ qua ngay; C xuất hiện trên bàn và được thêm vào Đĩa với thời điểm khám phá; 2 chỗ thả trống lại
- Ưu tiên: Bắt buộc

### AC-GAME-03: Thả chồng trên mặt bàn
- **Cho** A và B đang nằm trên mặt bàn, graph có A + B = C
- **Khi** kéo A thả chồng lên B
- **Thì** A và B được thay bằng C tại vị trí của B, hiệu ứng hơi lẩu nhỏ (≤ 0,6 s); C được thêm vào Đĩa
- Ưu tiên: Bắt buộc

### AC-GAME-04: Ghép ra phần tử đã có
- **Cho** Đĩa đã có C, graph có A + B = C
- **Khi** ghép A với B (theo thứ tự nào cũng được)
- **Thì** C hiện trên bàn nhưng Đĩa không có bản trùng; thời điểm khám phá cũ giữ nguyên
- Ưu tiên: Bắt buộc

### AC-GAME-05: Nồi trào - câu cố định theo cặp
- **Cho** cặp (A, B) không có công thức
- **Khi** ghép A với B, rồi ghép B với A, rồi tải lại trang và ghép lại
- **Thì** cả 3 lần hiện cùng một câu "Nồi trào / Khét rồi" lấy từ danh sách câu Nồi trào của manifest; câu được chọn bằng hàm tất định của cặp tên đã chuẩn hóa (không dùng số ngẫu nhiên); A và B trở lại bàn
- Ưu tiên: Bắt buộc

### AC-GAME-06: Gợi ý khi trượt
- **Cho** thực khách vừa trượt 3 lần liên tiếp (ngưỡng mặc định - câu hỏi mở)
- **Khi** lần trượt thứ 3 xảy ra
- **Thì** cùng câu Nồi trào hiện thêm gợi ý "Thử <emoji> <tên phần tử X> xem" trong đó X là phần tử người chơi đang có và tồn tại công thức X + Y với Y cũng đang có, kết quả chưa có trong Đĩa; gợi ý không chứa tên kết quả; bộ đếm trượt về 0. Không còn công thức nào chưa khám phá từ Đĩa hiện tại thì không hiện gợi ý
- Ưu tiên: Bắt buộc

### AC-GAME-07: Tìm trong Đĩa nhúng không dấu
- **Cho** Đĩa có "Cà Phê Sữa Đá" và "Cà Khịa"
- **Khi** gõ "ca phe" (hoặc "CÀ PHÊ", "  ca   phe ")
- **Thì** chỉ "Cà Phê Sữa Đá" hiện; so khớp dùng cùng quy tắc chuẩn hóa `fold` với pipeline (bỏ dấu, chữ thường, gộp khoảng trắng); ô tìm rỗng thì hiện cả Đĩa
- Ưu tiên: Bắt buộc

### AC-GAME-08: Sắp xếp Đĩa nhúng
- **Cho** Đĩa có ít nhất 3 phần tử với thời điểm khám phá, tên và độ sâu khác nhau
- **Khi** chọn lần lượt "Mới khám phá", "Tên", "Độ sâu"
- **Thì** thứ tự lần lượt là: thời điểm khám phá giảm dần; tên theo thứ tự chữ cái tiếng Việt (so trên tên đã `fold`, hòa thì theo tên gốc); độ sâu tăng dần (hòa thì theo tên). Lựa chọn sắp xếp được nhớ cục bộ
- Ưu tiên: Bắt buộc

### AC-GAME-09: Nhãn "MỚI"
- **Cho** manifest version V; phần tử C có mẻ thêm vào = V và không bị hoãn nóng; phần tử D thêm ở mẻ trước
- **Khi** C và D hiện trong Đĩa hoặc trên bàn
- **Thì** C có nhãn "MỚI", D không có
- Ưu tiên: Bắt buộc

### AC-GAME-10: Lưu và khôi phục tiến độ cục bộ
- **Cho** thực khách đã khám phá thêm phần tử và đặt vài phần tử trên bàn
- **Khi** tải lại trang
- **Thì** Đĩa, vị trí các phần tử trên bàn, lựa chọn sắp xếp và trạng thái đã xem hướng dẫn được khôi phục; không gọi API ghi nào để làm việc này
- Ưu tiên: Bắt buộc

### AC-GAME-11: Dọn bàn và Chơi lại từ đầu
- **Cho** bàn có phần tử và Đĩa có hơn 4 phần tử
- **Khi** bấm "Dọn bàn"; sau đó bấm "Chơi lại từ đầu" → hộp xác nhận → "Hủy"; rồi lặp lại và chọn "Xóa"
- **Thì** "Dọn bàn" chỉ xóa phần tử trên bàn, Đĩa giữ nguyên; "Hủy" không đổi gì; "Xóa" đưa Đĩa về 4 phần tử khởi đầu và xóa tiến độ cục bộ, nhưng **giữ** UUID, nickname và lịch sử Daily/streak
- Ưu tiên: Bắt buộc

### AC-GAME-12: Hướng dẫn lần đầu
- **Cho** trình duyệt chưa đánh dấu đã xem hướng dẫn
- **Khi** mở trang lần đầu, đóng hướng dẫn, rồi tải lại trang
- **Thì** lần đầu hiện hướng dẫn 1 màn hình (kéo 2 món vào nồi); sau khi đóng thì không hiện lại; có nút "?" mở lại hướng dẫn
- Ưu tiên: Bắt buộc

### AC-GAME-13: Chế độ tối
- **Cho** hệ điều hành đặt giao diện tối và người chơi chưa chọn chế độ
- **Khi** mở trang; sau đó bấm nút chuyển chế độ
- **Thì** trang hiện chế độ tối theo hệ thống; nút chuyển đổi sang sáng và lựa chọn được nhớ cục bộ, ưu tiên hơn cài đặt hệ thống
- Ưu tiên: Bắt buộc

### AC-GAME-14: Ghép tra trong bộ nhớ dưới 50 ms
- **Cho** graph của lõi (363 công thức) đã tải vào bộ nhớ
- **Khi** thực hiện 1 000 lượt tra + giải mã cặp ngẫu nhiên (seed cố định)
- **Thì** không có lượt nào gọi mạng; p95 thời gian một lượt < 50 ms trong môi trường test
- Ưu tiên: Bắt buộc

### AC-GAME-15: Phần tử bị chặn nóng
- **Cho** danh sách chặn có phần tử E và công thức A + B
- **Khi** client khởi động với Đĩa đang có E; rồi ghép A với B
- **Thì** E không hiện trong Đĩa và trên bàn (vẫn giữ trong lưu trữ cục bộ để hiện lại nếu được bỏ chặn); A + B được xử lý như ghép trượt; mọi công thức có kết quả là E cũng xử lý như trượt
- Ưu tiên: Bắt buộc

### AC-GAME-16: Lỗi tải graph
- **Cho** tiến độ cục bộ có sẵn và yêu cầu tải manifest hoặc graph lỗi mạng / trả 5xx
- **Khi** mở trang
- **Thì** hiện thông báo lỗi có `role="alert"` và nút "Thử lại"; Đĩa vẫn hiện từ lưu trữ cục bộ; tiến độ không bị xóa; ghép bị vô hiệu tới khi tải được graph
- Ưu tiên: Bắt buộc

### AC-GAME-17: Đổi version graph giữ tiến độ
- **Cho** tiến độ cục bộ tạo ở graph version V1; manifest hiện là V2
- **Khi** client tải V2
- **Thì** mọi phần tử đã khám phá vẫn còn trong Đĩa (trừ phần tử bị chặn - AC-GAME-15); tra cứu dùng graph V2; không hỏi người chơi gì
- Ưu tiên: Bắt buộc

### AC-GAME-18: Nồi lẩu nằm trong màn hình đầu tiên (thêm 2026-10-21)
- **Cho** thực khách mở trang lần đầu (đã đóng hướng dẫn) ở các khung nhìn 1366×768 (PC), 1024×768 và 768×1024 (tablet), 390×844 và 360×640 (mobile), thẻ Món đặc biệt đang hiện
- **Khi** trang vừa tải xong, chưa cuộn
- **Thì** toàn bộ nồi lẩu (2 chỗ thả) nằm trọn trong khung nhìn; trên mobile Đĩa nhúng có thể nằm dưới nồi và phải cuộn mới thấy; chiều cao mặt bàn co theo khung nhìn thay vì cố định. Kiểm bằng Vitest browser mode với Playwright (Chromium thật) đo hộp bao của nồi ở cả 5 khung nhìn, vì jsdom không tính bố cục; test vẫn chạy qua `vitest -t AC-GAME-18` như các test khác (chốt 2026-10-21)
- Ưu tiên: Bắt buộc


### AC-GAME-19: Nút điều khiển nằm ở khu bàn lẩu, đăng nhập ở đầu trang (thêm 2026-10-22)
- **Cho** thực khách mở trang ở khung nhìn 1366×768 (PC) và 390×844 (mobile)
- **Khi** trang vừa tải xong; rồi đăng nhập Google thành công
- **Thì** đầu trang chỉ có tên game, nút đổi giao diện sáng/tối và khu tài khoản: chưa đăng nhập là nút "Đăng nhập bằng Google" (ở vị trí cũ của "Dọn bàn"), đã đăng nhập là "Đã đăng nhập: <nickname>" như AC-AUTH-02; chân trang không còn nút đăng nhập. "Dọn bàn", "Chơi lại từ đầu" và "?" nằm trong khu bàn lẩu (PC: góc trên bên phải mặt bàn; mobile: một hàng ngay trên mặt bàn), không đè lên nồi lẩu hay món trên bàn; hành vi của ba nút giữ nguyên như AC-GAME-11 và hướng dẫn
- Ưu tiên: Bắt buộc

### AC-GAME-20: Nồi lẩu vẽ trọn, quai ngang thân nồi (thêm 2026-10-22)
- **Cho** nồi lẩu ở các khung nhìn của AC-GAME-18, giao diện sáng và tối
- **Khi** trang vừa tải xong; và khi nồi đang sôi
- **Thì** hàng lửa dưới nồi hiện trọn chiều cao, không bị mép dưới mặt bàn hay khung nào cắt; hai quai nồi gắn vào nửa trên của thân nồi (ngay dưới miệng nồi), không thấp hơn giữa thân. Kiểm bằng Vitest browser mode như AC-GAME-18: hộp bao của hàng lửa nằm trọn trong mặt bàn, tâm quai nằm trên đường giữa thân nồi
- Ưu tiên: Bắt buộc

### AC-GAME-21: Vuốt cuộn trang trên màn hình cảm ứng (thêm 2026-10-22)
- **Cho** thực khách dùng điện thoại cảm ứng (390×844), trên bàn có món, Đĩa nhúng nằm dưới nồi
- **Khi** vuốt dọc bắt đầu ở chỗ trống trên mặt bàn; rồi giữ và kéo một món vào nồi
- **Thì** vuốt ở chỗ trống cuộn trang bình thường (chỉ món trên bàn và trong Đĩa giữ cử chỉ kéo); kéo món vẫn thả vào nồi như AC-GAME-02. Lần đầu mở trên thiết bị cảm ứng hiện gợi ý "Giữ món để kéo, vuốt chỗ trống để cuộn" sát mặt bàn; gợi ý ẩn khi bấm đóng hoặc sau lần kéo thả thành công đầu tiên, và không hiện lại sau khi tải lại trang (lưu cùng tiến độ cục bộ)
- Ưu tiên: Bắt buộc
