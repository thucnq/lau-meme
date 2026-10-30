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
- **Thì** hiệu ứng nồi sôi chạy tối đa 1,2 s; chạm/nhấp trong lúc hiệu ứng thì bỏ qua ngay; C xuất hiện trên bàn và được thêm vào Đĩa với thời điểm khám phá; 2 chỗ thả trống lại; (cập nhật 2026-10-25, góp ý "trên web khi kéo thì thẻ không theo chuột") trong suốt lúc kéo, món bóng đi theo con trỏ hoặc ngón tay: tâm món bóng cách điểm con trỏ ≤ 4 px ở mọi vị trí trên trang (kể cả khi trang đã cuộn), món bóng mang nền, viền và hình nhỏ tier của món đang kéo (AC-TIER-02)
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
- **Thì** cả 3 lần hiện cùng một câu "Nồi trào / Khét rồi" lấy từ danh sách câu Nồi trào của manifest; câu được chọn bằng hàm tất định của cặp tên đã chuẩn hóa (không dùng số ngẫu nhiên); A và B trở lại bàn. Lần trượt thứ 3 liên tiếp có gợi ý thì gợi ý hiện thay câu (AC-GAME-06, cập nhật 2026-10-30)
- Ưu tiên: Bắt buộc

### AC-GAME-06: Gợi ý cặp khi trượt (cập nhật 2026-10-30: gợi ý cả cặp A + B thay câu Nồi trào ở lần trượt thứ 3, thẻ nháy sáng - câu hỏi mở 103)
- **Cho** thực khách ở bàn lẩu chính vừa trượt 3 lần liên tiếp (ngưỡng mặc định - câu hỏi mở 9)
- **Khi** lần trượt thứ 3 xảy ra
- **Thì** chỗ câu Nồi trào hiện gợi ý "Thử <emoji A> <tên A> + <emoji B> <tên B> xem" thay cho câu Nồi trào (lần trượt thứ 1, 2 của chuỗi vẫn hiện câu Nồi trào như AC-GAME-05; lần thứ 3 chỉ hiện gợi ý), trong đó A và B là hai phần tử khác nhau người chơi đang có trong Đĩa (không gợi ý một món ghép với chính nó), tồn tại công thức A + B và kết quả chưa có trong Đĩa; gợi ý không chứa tên hay emoji của kết quả; bộ đếm trượt về 0. Khi có nhiều cặp hợp lệ, chọn theo cùng quy tắc chọn phần tử như trước (một cặp, ổn định với cùng Đĩa). Thẻ A và thẻ B nháy sáng nhẹ và chậm ở mọi chỗ đang hiện (trên bàn và trong Đĩa nhúng; Đĩa không tự cuộn tới thẻ). Dòng gợi ý và hiệu ứng nháy ở lại (không tự ẩn theo thời gian), và cùng tắt khi người chơi ghép một cặp bất kỳ (thành công hay trượt), sang màn hình khác hoặc tải lại trang; gợi ý không lưu vào tiến độ cục bộ (AC-GAME-10). Thiết bị bật giảm chuyển động (`prefers-reduced-motion`) thì thẻ chỉ có viền sáng tĩnh, không nháy. Không còn công thức nào chưa khám phá từ Đĩa hiện tại thì không hiện gợi ý, không thẻ nào nháy và lần trượt thứ 3 hiện câu Nồi trào như thường. Chỉ áp cho bàn lẩu chính; Món đặc biệt (DAILY) và mQuiz không đổi
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

### AC-GAME-11: Dọn bàn (cập nhật 2026-10-24: bỏ "Chơi lại từ đầu" - câu hỏi mở 71)
- **Cho** bàn có phần tử và Đĩa có hơn 4 phần tử
- **Khi** bấm "Dọn bàn"
- **Thì** "Dọn bàn" chỉ xóa phần tử trên bàn, Đĩa giữ nguyên; giao diện không còn nút "Chơi lại từ đầu" hay cách nào khác để xóa Đĩa (cả khi chưa đăng nhập); UUID, nickname và lịch sử Daily/streak không đổi
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
- **Cho** graph của lõi (518 công thức) đã tải vào bộ nhớ
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
- **Thì** toàn bộ nồi lẩu (2 chỗ thả) nằm trọn trong khung nhìn; trên mobile Đĩa nhúng có thể nằm dưới nồi và phải cuộn mới thấy; chiều cao mặt bàn co theo khung nhìn thay vì cố định. (cập nhật 2026-10-24, góp ý "bàn hơi chật") Mặt bàn lấp phần còn lại của khung nhìn đầu tiên: mép dưới mặt bàn cách đáy khung nhìn không quá 24 px ở cả 5 khung nhìn (không tràn ra ngoài), và chiều cao mặt bàn ≥ 60% chiều cao khung nhìn ở PC/tablet, ≥ 55% ở mobile (mặc định - câu hỏi mở 72); khi khung nhìn đổi cỡ thì mặt bàn đổi theo, món trên bàn không rơi ra ngoài mặt bàn. Kiểm bằng Vitest browser mode với Playwright (Chromium thật) đo hộp bao của nồi ở cả 5 khung nhìn, vì jsdom không tính bố cục; test vẫn chạy qua `vitest -t AC-GAME-18` như các test khác (chốt 2026-10-21)
- Ưu tiên: Bắt buộc


### AC-GAME-19: Nút điều khiển nằm ở khu bàn lẩu, đăng nhập ở đầu trang (thêm 2026-10-22)
- **Cho** thực khách mở trang ở khung nhìn 1366×768 (PC) và 390×844 (mobile)
- **Khi** trang vừa tải xong; rồi đăng nhập Google thành công
- **Thì** đầu trang chỉ có tên game, nút đổi giao diện sáng/tối và khu tài khoản: chưa đăng nhập là nút "Đăng nhập bằng Google" (ở vị trí cũ của "Dọn bàn"), đã đăng nhập là "Đã đăng nhập: <nickname>" như AC-AUTH-02; chân trang không còn nút đăng nhập. "Dọn bàn" và "?" (cập nhật 2026-10-24: không còn "Chơi lại từ đầu" - AC-GAME-11) nằm trong khu bàn lẩu (PC: góc trên bên phải mặt bàn; mobile: một hàng ngay trên mặt bàn), không đè lên nồi lẩu hay món trên bàn; hành vi của hai nút giữ nguyên như AC-GAME-11 và hướng dẫn
- Ưu tiên: Bắt buộc

### AC-GAME-20: Nồi lẩu vẽ trọn, quai ngang thân nồi (thêm 2026-10-22)
- **Cho** nồi lẩu ở các khung nhìn của AC-GAME-18, giao diện sáng và tối
- **Khi** trang vừa tải xong; và khi nồi đang sôi
- **Thì** mọi ngọn lửa trong hàng lửa dưới nồi hiện trọn, không ngọn nào bị cắt ngang (ngọn ngoài cùng hai bên đủ bề rộng như các ngọn khác - góp ý 2026-10-22: ngọn ngoài cùng bên phải bị cắt), và hàng lửa không bị mép dưới mặt bàn hay khung nào cắt; hai quai nồi gắn vào nửa trên của thân nồi (ngay dưới miệng nồi), không thấp hơn giữa thân. Kiểm bằng Vitest browser mode như AC-GAME-18: hộp bao của hàng lửa nằm trọn trong mặt bàn, hàng lửa chỉ vẽ số nguyên ngọn lửa (bề rộng hàng chia hết cho bề rộng một ngọn, hoặc lặp kiểu `space`), tâm quai nằm trên đường giữa thân nồi
- Ưu tiên: Bắt buộc

### AC-GAME-21: Vuốt cuộn trang trên màn hình cảm ứng (thêm 2026-10-22)
- **Cho** thực khách dùng điện thoại cảm ứng (390×844), trên bàn có món, Đĩa nhúng nằm dưới nồi
- **Khi** vuốt dọc bắt đầu ở chỗ trống trên mặt bàn; rồi giữ và kéo một món vào nồi
- **Thì** vuốt ở chỗ trống cuộn trang bình thường (chỉ món trên bàn và trong Đĩa giữ cử chỉ kéo); kéo món vẫn thả vào nồi như AC-GAME-02. (cập nhật 2026-10-25, góp ý "không trượt được màn hình khi đặt tay vào vùng có món") Vuốt dọc bắt đầu ngay trên một món ở bàn hoặc trong Đĩa cũng cuộn trang (hoặc cuộn danh sách Đĩa) như ở chỗ trống, không kéo món và không hiện món bóng; kéo ngang một món thì kéo ngay; giữ yên món ≥ 250 ms rồi kéo theo hướng bất kỳ (kể cả dọc) thì kéo món và trang không cuộn; bấm nhanh vẫn cho vào nồi như AC-GAME-24; danh sách Đĩa cuộn đến đầu/cuối thì vuốt tiếp cuộn trang trên điện thoại (bề rộng ≤ 640 px). Lần đầu mở trên thiết bị cảm ứng hiện gợi ý "Giữ món để kéo, vuốt chỗ trống để cuộn" sát mặt bàn; gợi ý ẩn khi bấm đóng hoặc sau lần kéo thả thành công đầu tiên, và không hiện lại sau khi tải lại trang (lưu cùng tiến độ cục bộ)
- Ưu tiên: Bắt buộc

### AC-GAME-22: Vùng cấm đặt món (thêm 2026-10-24)
- **Cho** khu bàn lẩu có hàng nút "Dọn bàn", "?" (AC-GAME-19), vùng câu Nồi trào + gợi ý khi đang hiện (AC-GAME-05/06), và gợi ý vuốt cuộn khi đang hiện (AC-GAME-21); khung nhìn 1366×768 và 390×844
- **Khi** kéo một món từ Đĩa hoặc trên bàn thả vào giữa vùng nút hoặc vùng gợi ý; và khi ghép trượt đưa A, B trở lại bàn (AC-GAME-05) hay ghép thành công đặt món mới lên bàn (AC-GAME-02) trong lúc các vùng đó đang hiện
- **Thì** không món nào nằm (dù một phần) trong hộp bao của vùng nút hay vùng gợi ý: món thả vào đó được đặt ở chỗ trống gần nhất ngoài các vùng cấm và vẫn nằm trọn trong mặt bàn; vị trí món tự đặt sau ghép cũng tránh các vùng này; nút vẫn bấm được ngay sau đó (không món nào đè lên nút). Kiểm bằng Vitest browser mode như AC-GAME-18: hộp bao của mọi món không giao với hộp bao của vùng cấm
- Ưu tiên: Bắt buộc

### AC-GAME-23: Đĩa nhúng cao bằng bàn lẩu, thanh cuộn mỏng (thêm 2026-10-24)
- **Cho** Đĩa có 120 phần tử (nhiều hơn số hiện được trong một màn); 5 khung nhìn của AC-GAME-18; giao diện sáng và tối
- **Khi** trang vừa tải xong; rồi cuộn trong Đĩa
- **Thì** vùng danh sách phần tử của Đĩa (kể cả ô tìm và chọn sắp xếp) có chiều cao bằng chiều cao mặt bàn (sai lệch ≤ 2 px) và không đổi khi số phần tử tăng; danh sách cuộn bên trong vùng đó, trang không dài thêm theo số phần tử; thanh cuộn mỏng (bề rộng ≤ 8 px), màu theo giao diện sáng/tối, vẫn kéo được bằng chuột và vuốt được trên cảm ứng; kéo món từ Đĩa vào nồi vẫn chạy như AC-GAME-02 khi Đĩa đã cuộn
- Ưu tiên: Bắt buộc

### AC-GAME-24: Bấm món là cho vào nồi (thêm 2026-10-24)
- **Cho** nồi đang trống; A ở Đĩa, B trên mặt bàn; graph có A + B = C
- **Khi** bấm/chạm A (nhả ra mà không kéo: di chuyển < 6 px và giữ < 500 ms); rồi bấm/chạm B; và trường hợp khác: chỉ bấm A khi nồi đã có một món ở chỗ thả 1
- **Thì** A vào chỗ thả trống đầu tiên (chỗ 1 rồi chỗ 2), B vào chỗ còn lại, rồi ghép như AC-GAME-02; khi đủ 2 chỗ thì ghép ngay, không cần thao tác thêm; trong lúc nồi đang sôi thì bấm món không làm gì; giữ lâu hơn 500 ms vẫn là cử chỉ giữ của AC-CONTRIB (hiện người tạo), không cho vào nồi; với bàn phím, phần tử đang được chọn (focus) nhấn Enter hoặc Space cũng vào nồi như bấm
- Ưu tiên: Bắt buộc

### AC-GAME-25: Hiệu ứng khi ghép ra món Vàng và Đỏ (thêm 2026-10-24)
- **Cho** graph có A + B = V (tier 4 Vàng) và A + D = R (tier 5 Đỏ) (AC-TIER); V, R chưa có trong Đĩa
- **Khi** ghép ra V lần đầu; ghép ra R lần đầu; rồi ghép ra lại V và R
- **Thì** lần đầu ra V: hiệu ứng ánh vàng lan từ nồi + hạt lấp lánh, dài ≤ 1,5 s, đi cùng phóng lớn của AC-ART-08; lần đầu ra R: hiệu ứng riêng lớn hơn hiệu ứng Vàng (lửa đỏ bùng quanh nồi, bàn rung nhẹ, pháo giấy), dài ≤ 2,5 s; cả hai bỏ qua được bằng bấm/Esc như AC-ART-08 và không chặn kéo thả tiếp; ghép ra lại món đã có chỉ có viền sáng ngắn ≤ 0,6 s; `prefers-reduced-motion` thì không rung, không hạt, chỉ đổi màu viền tĩnh; Món đặc biệt chưa giải không làm lộ tier qua hiệu ứng trước khi ghép ra
- Ưu tiên: Bắt buộc

### AC-GAME-26: Âm thanh khi ghép ra món Vàng và Đỏ (thêm 2026-10-24)
- **Cho** thực khách ghép ra món Vàng hoặc Đỏ lần đầu (AC-GAME-25)
- **Khi** hiệu ứng chạy; rồi bấm nút loa ở khu bàn lẩu để tắt tiếng, tải lại trang và ghép ra món Đỏ khác
- **Thì** có một tiếng ngắn riêng cho Vàng và một tiếng riêng cho Đỏ (≤ 2 s, mỗi file ≤ 50 KB, phục vụ dưới `/lau-meme/` - không tải từ ngoài, AC-SUBPATH-07); âm thanh chỉ phát sau thao tác ghép của người chơi (không tự phát khi tải trang); tắt tiếng thì không phát gì và lựa chọn này được giữ sau khi tải lại (lưu cùng tiến độ cục bộ, khóa `laumeme:`); mặc định bật tiếng (câu hỏi mở 73); trình duyệt chặn phát thì bỏ qua êm, không báo lỗi
- Ưu tiên: Tùy chọn

### AC-GAME-27: Giao diện mới - phông chữ, bảng màu và hệ thống thiết kế (thêm 2026-10-24)
- **Cho** hướng thiết kế mới được chốt ở `/dk:design` (ADR, dùng skill design-taste-frontend: phông, bảng màu, khoảng cách, bo góc, đổ bóng, chuyển động - người duyệt bằng ảnh chụp các khung nhìn của AC-GAME-18 ở hai chế độ sáng/tối trước khi build)
- **Khi** mở trang chơi, hộp xác nhận, bảng xếp hạng và trang chính sách ở 5 khung nhìn của AC-GAME-18, sáng và tối
- **Thì** (cập nhật 2026-10-25, người duyệt chọn Helvetica và màu chủ đạo xanh lá) mọi chữ dùng một họ phông Helvetica của hệ điều hành (`"Helvetica Neue", Helvetica, Arial`, không tải file phông nào), hiển thị đủ dấu tiếng Việt (kiểm chuỗi "Ầ ẫ ặ ỡ ự Đ"), emoji hiện bằng phông emoji màu của hệ điều hành (không thành ô vuông hay nét đen); không gọi Google Fonts hay CDN; màu nhấn (nút chính, nhãn, tiêu đề) là xanh lá; màu, cỡ chữ, khoảng cách, bo góc lấy từ một bộ token duy nhất (biến CSS) có bản sáng và tối; chữ thường đạt tương phản ≥ 4,5:1 và chữ lớn/biểu tượng ≥ 3:1 ở cả hai chế độ; không có cuộn ngang ở khung nhìn 360 px, kể cả khi đã đăng nhập với nickname dài (cập nhật 2026-10-25: thanh đầu trang co lại, nickname quá dài cắt bằng dấu "…", tên đầy đủ vẫn có cho trình đọc màn hình và khi rê chuột); các AC bố cục GAME-18..23, TIER-02 vẫn đạt. Kiểm bằng Vitest browser mode (họ phông tính ra của chữ, tương phản tính từ màu thực tế, không request ra ngoài tiền tố)
- Ưu tiên: Bắt buộc

### AC-GAME-28: Đổi kiểu mặt bàn (thêm 2026-10-25)
- **Cho** thực khách mở trang chơi lần đầu (chưa chọn kiểu bàn); giao diện sáng và tối
- **Khi** trang tải xong; rồi bấm nút đổi bàn trong hàng nút trên bàn ("Dọn bàn", loa, "?"); rồi tải lại trang
- **Thì** mặc định mặt bàn là bàn nhựa vỉa hè (xanh dương, gờ nhựa đúc quanh mép, chấm nổi nhỏ); bấm nút thì đổi sang bàn vân gỗ (ván gỗ sáng, vân dọc), bấm lần nữa thì về bàn nhựa; tên nút cho trình đọc màn hình nói kiểu sẽ đổi sang ("Đổi sang bàn gỗ" / "Đổi sang bàn nhựa"); lựa chọn lưu ở localStorage với khóa `laumeme:table` (giá trị `plastic` hoặc `wood`) và được giữ sau khi tải lại; giá trị lạ hoặc localStorage bị chặn thì dùng bàn nhựa, không báo lỗi; cả hai kiểu vẽ bằng CSS (không tải ảnh), lửa dưới nồi vẫn nhìn rõ trên cả hai mặt bàn; nút nằm trong vùng cấm đặt món của AC-GAME-22
- Ưu tiên: Tùy chọn
