# Tiêu chí nghiệm thu - Đóng góp meme (CONTRIB)

> Thêm 2026-10-23. Component: web (form đề xuất, tên người tạo trên phần tử, tab "Top cống hiến"), worker (`/api/contributions*`, `/api/admin/contributions*`, bảng xếp hạng cống hiến), pipeline (đưa đề xuất đã duyệt vào graph ở mẻ kế tiếp).
> Đề xuất meme = một phần tử mới tạo từ cặp 2 phần tử có sẵn. Kiểm duyệt = lọc từ cấm + bí danh lúc gửi, rồi admin sửa và duyệt tay; nội dung đề xuất và mọi dữ liệu tài khoản **không** gửi cho Gemini hay LLM nào (câu hỏi mở 46). Chỉ thực khách đã đăng nhập Google (AC-AUTH) mới gửi được (mặc định - câu hỏi mở 54); người tạo hiển thị bằng nickname của tài khoản.

### AC-CONTRIB-01: Gửi đề xuất hợp lệ
- **Cho** thực khách đã đăng nhập, đã đồng ý chính sách (AC-PRIV-02); "Deadline" và "Cà Phê" là phần tử đang hoạt động; cặp (Deadline, Cà Phê) chưa có công thức
- **Khi** gửi đề xuất: cặp (Deadline, Cà Phê), tên "Cà Phê Chạy Deadline"; lần khác gửi thêm biểu tượng "☕", mô tả "Uống để thức tới sáng", link ảnh `https://example.com/a.png`
- **Thì** trả 201 với mã đề xuất, trạng thái "Chờ duyệt"; chỉ **tên** là bắt buộc, biểu tượng, mô tả, link ảnh là tùy chọn; đề xuất lưu kèm tài khoản người gửi và thời điểm; cặp được lưu không thứ tự ((Cà Phê, Deadline) là cùng cặp); đề xuất chưa duyệt không xuất hiện trong graph hay với người chơi khác
- Ưu tiên: Bắt buộc

### AC-CONTRIB-02: Đầu vào không hợp lệ
- **Cho** thực khách đã đăng nhập
- **Khi** gửi lần lượt: thiếu tên; tên chỉ có khoảng trắng; tên dài hơn 40 ký tự; mô tả dài hơn 200 ký tự; biểu tượng không phải đúng 1 emoji; link ảnh không phải `https://` hoặc dài hơn 500 ký tự; một trong hai phần tử không tồn tại, đang ẩn hoặc bị chặn; thân không phải JSON
- **Thì** mỗi trường hợp trả 400 problem+json nêu trường sai (giới hạn độ dài mặc định - câu hỏi mở 51); không tạo đề xuất
- Ưu tiên: Bắt buộc

### AC-CONTRIB-03: Trùng cặp, trùng tên, gửi lặp
- **Cho** cặp (Cười, Toang) đã có công thức trong graph; phần tử "Stonks" đã có; thực khách A đã có đề xuất "Chờ duyệt" cho cặp (Deadline, Cà Phê)
- **Khi** A gửi đề xuất cho (Cười, Toang); gửi đề xuất tên "stonks!!" cho cặp khác; gửi lại (Deadline, Cà Phê) (kể cả bấm 2 lần liên tiếp)
- **Thì** cả ba trả 409 problem+json: cặp đã có công thức; tên trùng phần tử đã có theo `fold` (mặc định - câu hỏi mở 52); A đã có đề xuất chờ duyệt cho cặp này; không tạo đề xuất thứ hai. Thực khách B vẫn gửi được đề xuất cho (Deadline, Cà Phê) - admin chọn khi duyệt (AC-CONTRIB-08)
- Ưu tiên: Bắt buộc

### AC-CONTRIB-04: Từ cấm và bí danh bị chặn
- **Cho** danh sách từ cấm và bí danh bị chặn (AC-DISC-03, AC-MOD)
- **Khi** gửi đề xuất có tên hoặc mô tả chứa từ cấm hoặc bí danh bị chặn (so theo `fold`)
- **Thì** trả 422 problem+json với thông báo chung "Nội dung không phù hợp", không nêu từ nào bị khớp; không tạo đề xuất; không gọi LLM
- Ưu tiên: Bắt buộc

### AC-CONTRIB-05: Chưa đăng nhập, chưa đồng ý, giới hạn tần suất
- **Cho** thực khách chưa đăng nhập; thực khách đã đăng nhập nhưng chưa đồng ý chính sách; tài khoản đã gửi 5 đề xuất trong ngày GMT+7 (mặc định - câu hỏi mở 51)
- **Khi** gửi đề xuất
- **Thì** chưa đăng nhập trả 401; chưa đồng ý trả 403; đề xuất thứ 6 trong ngày trả 429 problem+json có `Retry-After` tới 00:00 GMT+7 hôm sau; cùng IP băm gửi quá 10 yêu cầu/phút cũng trả 429 (AC-PRIV-06); giao diện hiện nút "Đóng góp meme" kèm lời mời đăng nhập khi chưa đăng nhập
- Ưu tiên: Bắt buộc

### AC-CONTRIB-06: Thực khách xem đề xuất của mình
- **Cho** tài khoản A có 3 đề xuất: chờ duyệt, đã duyệt, bị từ chối (lý do "Trùng ý với Stonks"); tài khoản B có đề xuất khác
- **Khi** A mở "Đề xuất của tôi"; A gọi xem đề xuất của B theo mã
- **Thì** A thấy đúng 3 đề xuất của mình, mới nhất trước, mỗi đề xuất: cặp, tên, biểu tượng, mô tả, trạng thái, lý do từ chối (nếu có), thời điểm gửi; thông tin admin đã sửa hiện theo bản đã sửa; đề xuất của B trả 404 (không lộ là có tồn tại); danh sách rỗng hiện "Bạn chưa đóng góp meme nào"
- Ưu tiên: Bắt buộc

### AC-CONTRIB-07: Admin xem và sửa đề xuất
- **Cho** token quản trị đúng (AC-ADMIN-01); có 25 đề xuất chờ duyệt
- **Khi** mở mục "Đề xuất meme"; sửa biểu tượng, tên, mô tả, link ảnh của một đề xuất; sửa tên thành chuỗi rỗng hoặc trùng phần tử đã có
- **Thì** danh sách phân trang (`page`, `size` tối đa 100), cũ nhất trước, lọc theo trạng thái; mỗi dòng: cặp, tên, biểu tượng, mô tả, link ảnh dạng chữ (trang quản trị không tự tải hay nhúng ảnh từ link; khi duyệt admin có thể chọn dùng link làm ảnh món - AC-ART-14), nickname người gửi, thời điểm; sửa hợp lệ trả 200 và ghi audit (trước/sau) theo AC-ADMIN-09; sửa không hợp lệ trả 400/409 như AC-CONTRIB-02/03, không ghi audit; admin không thấy mã tài khoản hay UUID của người gửi
- Ưu tiên: Bắt buộc

### AC-CONTRIB-08: Admin duyệt hoặc từ chối
- **Cho** đề xuất X chờ duyệt cho cặp (Deadline, Cà Phê) của A, đề xuất Y cùng cặp của B
- **Khi** admin duyệt X kèm gợi ý ảnh do admin viết và tier (mặc định 1 - AC-TIER-01); duyệt Y sau đó; từ chối một đề xuất với lý do; duyệt X lần thứ hai
- **Thì** duyệt X: tạo phần tử mới (nguồn "đóng góp", người tạo = tài khoản A) và công thức (Deadline, Cà Phê) = phần tử đó trong kho nội dung, trạng thái X thành "Đã duyệt", ghi audit; Y tự chuyển "Bị từ chối" với lý do "Cặp đã có công thức"; từ chối cần lý do 1-200 ký tự, thiếu lý do trả 400; duyệt lại X trả 409; phần tử mới vào graph ở mẻ kế tiếp (không sửa graph đang phục vụ), qua cùng bất biến graph (AC-INV) - mẻ kế tiếp tính depth theo BFS; nếu tới mẻ kế tiếp một trong hai phần tử cha đã bị ẩn/chặn thì phần tử vẫn ở kho nhưng không vào graph cho tới khi cha hoạt động lại, báo cáo đợt ghi số đề xuất chưa vào được graph
- Ưu tiên: Bắt buộc

### AC-CONTRIB-09: Ảnh và biểu tượng của meme đóng góp
- **Cho** phần tử đóng góp đã duyệt, có biểu tượng "☕" và gợi ý ảnh do admin viết; một phần tử đóng góp khác không có biểu tượng
- **Khi** mẻ `full` kế tiếp chạy; và khi client hiện phần tử
- **Thì** phần tử hiện biểu tượng người gửi (hoặc admin đã sửa) làm emoji; không có biểu tượng thì dùng emoji mặc định "🍲"; trùng emoji với phần tử đã có vẫn được (ngoại lệ của luật emoji duy nhất của lõi - mặc định - câu hỏi mở 52); ảnh vẽ tay chỉ vẽ từ gợi ý ảnh do admin viết theo AC-ART (ART vẽ như phần tử mới), không dùng link ảnh của người gửi, trừ khi admin chọn dùng link làm ảnh lúc duyệt (AC-ART-14, khi đó không vẽ); pipeline không gửi tên, mô tả, link ảnh gốc hay nickname người gửi cho Gemini; sau khi duyệt, tên và gợi ý ảnh là nội dung game và được dùng như phần tử khác (câu hỏi mở 55, đã chốt)
- Ưu tiên: Bắt buộc

### AC-CONTRIB-10: Hiện người tạo trên phần tử
- **Cho** phần tử đóng góp do tài khoản có nickname "Bún Chả" tạo; một phần tử đóng góp của tài khoản không đặt nickname; một phần tử lõi
- **Khi** thực khách có phần tử trong Đĩa hoặc trên bàn, rê chuột lên phần tử; trên màn hình cảm ứng chạm giữ 500 ms (mặc định - câu hỏi mở 50); dùng bàn phím đưa focus vào phần tử
- **Thì** hiện "Meme của Bún Chả" (không nickname: "Meme của Thực khách ẩn danh"); phần tử lõi và crawl không hiện dòng này; chạm giữ không kích hoạt kéo thả hay ghép; dòng chữ có cho trình đọc màn hình (`aria-describedby`); nickname lấy theo nickname hiện tại của tài khoản, đổi nickname thì hiện tên mới từ mẻ kế tiếp; graph không chứa mã tài khoản
- Ưu tiên: Bắt buộc

### AC-CONTRIB-13: Chọn hai phần tử cho đề xuất
- **Cho** thực khách đã đăng nhập, Đĩa có "Deadline", "Cà Phê" và "Cười"; trên bàn có "Deadline"; form "Đóng góp meme" đang mở (thêm 2026-10-25, góp ý "phần tử 1 và 2 không chọn được hay kéo thả từ bàn hay đĩa vào được")
- **Khi** ở ô "Phần tử 1" gõ "dead" rồi chọn "Deadline" trong danh sách (chuột, chạm, hoặc phím mũi tên + Enter); kéo "Cà Phê" từ Đĩa thả vào ô "Phần tử 2"; lần khác kéo "Deadline" từ bàn thả vào ô "Phần tử 2"; gõ một tên không có trong Đĩa
- **Thì** mỗi ô hiện danh sách phần tử trong Đĩa (emoji và tên), lọc theo chữ đã gõ so theo `fold`; chọn hoặc thả xong ô hiện emoji và tên phần tử đã chọn và có nút bỏ chọn; thả món từ bàn vào ô không đưa món khỏi bàn, thả món vào ô không đưa món vào nồi; chỉ chọn được phần tử có trong Đĩa (mặc định - câu hỏi mở 82): tên gõ không khớp phần tử nào thì ô vẫn trống và nút "Gửi đề xuất" báo cần chọn phần tử; thân gửi lên vẫn là tên hai phần tử như AC-CONTRIB-01 (không đổi contract); ô có nhãn cho trình đọc màn hình (`role="combobox"`)
- Ưu tiên: Bắt buộc

### AC-CONTRIB-11: Bảng xếp hạng "Top cống hiến"
- **Cho** tài khoản A có 5 đề xuất đã duyệt (cái thứ 5 duyệt ngày 20/10), B có 5 (cái thứ 5 duyệt ngày 21/10), C có 2 và 4 đề xuất bị từ chối, D chỉ có đề xuất chờ duyệt
- **Khi** gọi `GET` bảng xếp hạng cống hiến (có phiên hoặc không); mở tab "Bảng xếp hạng" trên web
- **Thì** xếp theo số đề xuất đã duyệt từ trước tới giờ giảm dần, hòa thì ai đạt số đó trước đứng trước ⇒ A, B, C; D không xuất hiện (0 đề xuất duyệt); trả tối đa 20 dòng: hạng, nickname (hoặc "Thực khách ẩn danh"), số meme đã duyệt; có phiên thì kèm hạng của mình kể cả ngoài top 20; không có mã tài khoản hay UUID trong phản hồi; tab "Bảng xếp hạng" có thêm thẻ "Cống hiến" cạnh "Mẻ này", "Tuần", "Tháng" (AC-DAILY-17), cùng huy chương top 3 và tô dòng của mình; bảng rỗng hiện "Chưa có meme đóng góp nào được duyệt"
- Ưu tiên: Bắt buộc

### AC-CONTRIB-12: Xóa tài khoản và xuất dữ liệu
- **Cho** tài khoản A có 1 đề xuất chờ duyệt và 2 đề xuất đã duyệt
- **Khi** A xuất dữ liệu (AC-PRIV-08); rồi A xóa tài khoản (AC-AUTH-06)
- **Thì** bản xuất có cả 3 đề xuất (đủ các trường A đã gửi và trạng thái); sau khi xóa: đề xuất chờ duyệt bị xóa, 2 phần tử đã duyệt vẫn ở trong game nhưng không còn gắn với tài khoản và hiện "Meme của Thực khách ẩn danh" từ mẻ kế tiếp (mặc định - câu hỏi mở 56), A biến khỏi "Top cống hiến" ngay
- Ưu tiên: Bắt buộc
