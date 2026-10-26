# Tiêu chí nghiệm thu - Món đặc biệt hôm nay (DAILY)

> Giai đoạn 1. Component: pipeline (chọn món - logic thuần), worker (nhận kết quả, bảng xếp hạng, streak), web (thử thách, đếm bước, đồng hồ).
> Cập nhật 2026-10-21: bỏ bàn thử thách và đếm bước. Ghép ra Món đặc biệt ngay trên bàn lẩu là được ghi nhận; thời gian giải = thời điểm server nhận kết quả − `batch_at` của mẻ. Chỉ thực khách **đã đăng nhập Google** (AC-AUTH) mới nộp kết quả và có tên trên bảng xếp hạng; kết quả, streak, nickname thuộc về tài khoản.

### AC-DAILY-01: Chọn Món đặc biệt (cập nhật 2026-10-23)
- **Cho** kho có phần tử trend (crawl) và classic (lõi); mỗi phần tử có mức mặn `trend_peak` (AC-PIPE-16) và mẻ đầu tiên phần tử có mặt trong kho; danh sách Món đặc biệt của các mẻ trước
- **Khi** pipeline chọn món cho mẻ mới
- **Thì** ứng viên là phần tử có depth trong [4, 8], tới được từ khởi đầu, đang hoạt động, không bị hoãn nóng (AC-MOD-08), có gợi ý đạt kiểm duyệt (phần tử lõi: `daily_hint` viết tay trong `noi-dung-loi.json`, thay cho chỉ `daily_examples` - câu hỏi mở 41; phần tử crawl: gợi ý đã qua MOD) và **không là Món đặc biệt của 1 trong 30 mẻ gần nhất** (đếm theo mẻ, không theo ngày - câu hỏi mở 43). Ứng viên xếp theo (1) `trend_peak` giảm dần (mặn), (2) chưa từng làm Món đặc biệt trước, rồi tới món có lần làm gần nhất cũ nhất (lâu chưa ra - chốt 2026-10-24 để AC-DAILY-18 đạt), (3) mẻ đầu tiên có mặt trong kho giảm dần (mới), (4) thứ tự tất định theo seed = version mẻ; chọn ứng viên đầu bảng. Ví dụ: A (mặn 5, có mặt từ mẻ 10), B (mặn 5, từ mẻ 12), C (mặn 0, từ mẻ 12) ⇒ thứ tự B, A, C; nếu B là món của một trong 30 mẻ gần nhất thì chọn A. Mọi phần tử thỏa điều kiện đều nằm trong 30 mẻ gần nhất thì chọn món có lần làm Món đặc biệt gần nhất là cũ nhất và báo cáo đợt ghi cảnh báo "Pool thử thách cạn" (mặc định - câu hỏi mở 43)
- Ưu tiên: Bắt buộc

### AC-DAILY-02: Không có ứng viên nào
- **Cho** không phần tử nào thỏa depth [4, 8] và các điều kiện khác
- **Khi** pipeline chọn món
- **Thì** mẻ thất bại theo AC-PIPE-11 (bản cũ giữ nguyên) và báo cáo đợt ghi "không chọn được Món đặc biệt"
- Ưu tiên: Bắt buộc

### AC-DAILY-03: Công bố món không lộ tên
- **Cho** mẻ mới đã chọn món "Stonks"
- **Khi** client đọc manifest
- **Thì** manifest có emoji, gợi ý mờ, depth và khóa băm của tên đã `fold`; không chứa tên "Stonks" dạng đọc được; thẻ Daily hiện emoji + gợi ý, tên hiện là "???"
- Ưu tiên: Bắt buộc

### AC-DAILY-04: Ghép ra Món đặc biệt trên bàn lẩu
- **Cho** mẻ V có Món đặc biệt "Stonks" (manifest chỉ có khóa băm, AC-DAILY-03); thực khách chưa giải V
- **Khi** thực khách ghép bằng nồi lẩu hoặc thả chồng trên bàn (AC-GAME-02/04) một cặp ra đúng phần tử có khóa băm của món đích; kể cả khi "Stonks" đã có sẵn trong Đĩa từ trước (có sẵn mà không ghép lại trong mẻ thì chưa tính là giải - câu hỏi mở 36)
- **Thì** lượt ghép đó được ghi nhận là đã giải V: thẻ Món đặc biệt lộ tên "Stonks" và hiện "Đã giải"; client gửi kết quả (AC-DAILY-06) nếu đã đăng nhập; không có bàn thử thách riêng, không đếm bước, ghép trượt không ảnh hưởng gì tới Món đặc biệt
- Ưu tiên: Bắt buộc

### AC-DAILY-05: Trạng thái đã giải giữ qua tải lại
- **Cho** thực khách đã giải V nhưng kết quả chưa gửi được (chưa đăng nhập, mất mạng hoặc 429)
- **Khi** tải lại trang trong cùng mẻ; và khi mẻ V+1 lên
- **Thì** trong mẻ V thẻ vẫn hiện "Đã giải" kèm cặp đã ghép ra món (lưu cục bộ) và client thử gửi lại khi đã đăng nhập; sang mẻ V+1 thì trạng thái của V bị bỏ, thẻ mới hiện "???"
- Ưu tiên: Bắt buộc

### AC-DAILY-06: Nộp kết quả hợp lệ
- **Cho** thực khách đã đăng nhập (phiên hợp lệ, AC-AUTH-02); cặp (a, b) là công thức có thật trong graph của version hiện hành V và ra đúng món đích
- **Khi** client gửi `POST` kết quả Daily của V kèm a, b
- **Thì** server lấy thời điểm nhận yêu cầu làm `solved_at` (không tin thời gian từ client), thời gian giải = `solved_at` − `batch_at` của V; trả 201 với thời gian giải, hạng hiện tại trong mẻ và streak mới; kết quả lưu một lần cho (tài khoản, V)
- Ưu tiên: Bắt buộc

### AC-DAILY-07: Nộp kết quả không hợp lệ
- **Cho** cặp (a, b) không phải công thức có thật trong V, hoặc có thật nhưng không ra món đích
- **Khi** gửi `POST` kết quả
- **Thì** trả 422 problem+json; không ghi gì; không đổi streak
- Ưu tiên: Bắt buộc

### AC-DAILY-08: Nộp trùng, nộp cho mẻ đã qua, chưa đăng nhập
- **Cho** tài khoản đã nộp cho V; một yêu cầu nộp cho V−1 khi V đã là hiện hành; một yêu cầu không có phiên hoặc phiên hết hạn
- **Khi** gửi các yêu cầu đó
- **Thì** nộp lại trả 409 kèm kết quả đã lưu (không ghi đè, không đổi `solved_at`); nộp cho mẻ đã qua trả 410; không có phiên hợp lệ trả 401; tất cả dạng problem+json
- Ưu tiên: Bắt buộc

### AC-DAILY-09: Bảng xếp hạng mẻ
- **Cho** mẻ V có 30 kết quả, có người không đặt nickname
- **Khi** gọi `GET` bảng xếp hạng của V (có phiên hoặc không)
- **Thì** trả tối đa 20 dòng: hạng, nickname (không có → "Thực khách ẩn danh"), thời gian giải; xếp theo `solved_at` tăng dần (ai nộp trước đứng trước), hòa tới từng ms thì theo thứ tự ghi; không có mã tài khoản hay UUID của người khác trong phản hồi; có phiên thì kèm hạng của mình kể cả ngoài top 20; mẻ chưa có kết quả trả danh sách rỗng. Client hiện thời gian dạng "1 giờ 05 phút 12 giây" (dưới 1 giờ bỏ phần giờ)
- Ưu tiên: Bắt buộc

### AC-DAILY-10: Streak
- **Cho** tài khoản giải ít nhất 1 Món đặc biệt vào các ngày 20, 21, 22/10 (ngày theo GMT+7 của `batch_at`), bỏ ngày 23, rồi giải ngày 24
- **Khi** nộp kết quả mỗi ngày
- **Thì** streak sau ngày 22 là 3; sau ngày 24 là 1; streak dài nhất lưu là 3; giải 2 món trong cùng một ngày chỉ tính 1 ngày. `GET` streak của mình (cần phiên) trả streak hiện tại (về 0 nếu ngày gần nhất giải cách hôm nay quá 1 ngày) và streak dài nhất. Streak theo tài khoản, đăng nhập ở máy khác vẫn thấy cùng streak
- Ưu tiên: Bắt buộc

### AC-DAILY-11: Bảng xếp hạng streak
- **Cho** nhiều tài khoản có streak hiện tại khác nhau
- **Khi** gọi `GET` bảng xếp hạng streak
- **Thì** trả tối đa 20 dòng: hạng, nickname (hoặc "Thực khách ẩn danh"), streak hiện tại; xếp giảm dần, hòa thì ai đạt trước đứng trước; streak 0 không xuất hiện
- Ưu tiên: Bắt buộc

### AC-DAILY-12: Đồng hồ đếm ngược theo manifest thật (cập nhật 2026-10-23)
- **Cho** manifest có `batch_at` = 17:03 UTC (cron trễ 3 phút) và lịch mẻ của môi trường `schedule_hours_utc` = [5, 17] (production); và một manifest staging có `batch_at` = 08:07 UTC, `schedule_hours_utc` = [0, 2, 4, …, 22]
- **Khi** client tính đồng hồ lúc 17:30 UTC; lúc 05:20 UTC hôm sau khi manifest chưa đổi; và với manifest staging lúc 08:30 UTC
- **Thì** mốc mẻ kế tiếp = giờ đầu tiên trong `schedule_hours_utc` sau `batch_at` (không đóng cứng giờ trong client): lúc 17:30 hiện thời gian tới 05:00 UTC; staging hiện thời gian tới 10:00 UTC; khi đã quá mốc mà manifest chưa đổi thì hiện "Mẻ mới sắp lên" (không hiện số âm) và client kiểm manifest lại mỗi 60 s. Pipeline lấy lịch từ biến môi trường `BATCH_HOURS_UTC` (mặc định `5,17`); giá trị không hợp lệ (ngoài 0-23, rỗng, trùng) thì mẻ thất bại theo AC-PIPE-11
- Ưu tiên: Bắt buộc

### AC-DAILY-13: Giới hạn tần suất nộp
- **Cho** cùng tài khoản hoặc cùng IP băm gửi quá 10 yêu cầu nộp/phút (mặc định)
- **Khi** gửi yêu cầu thứ 11 trong phút
- **Thì** trả 429 problem+json có `Retry-After`
- Ưu tiên: Bắt buộc

### AC-DAILY-14: Bảng xếp hạng tuần và tháng (thêm 2026-10-21)
- **Cho** tuần lịch GMT+7 (00:00 thứ Hai → 00:00 thứ Hai sau) có 14 mẻ; A giải 14 mẻ, tổng thời gian 30 giờ; B giải 14 mẻ, tổng 20 giờ; C giải 12 mẻ, tổng 5 giờ; D giải 14 mẻ, tổng 20 giờ nhưng có kết quả cuối nộp sau B
- **Khi** gọi `GET` bảng xếp hạng tuần (hoặc tháng lịch GMT+7, 00:00 ngày 1 → 00:00 ngày 1 tháng sau) của kỳ hiện tại hoặc một kỳ đã qua (tham số kỳ `2026-W43` / `2026-10`, xem lùi tối đa 3 tháng, quá thì 400)
- **Thì** mẻ thuộc kỳ theo `batch_at` (GMT+7); xếp theo số mẻ đã giải giảm dần, rồi tổng thời gian giải tăng dần, rồi ai có kết quả cuối nộp trước đứng trước ⇒ B, D, A, C; mẻ không giải không cộng thời gian; trả tối đa 20 dòng: hạng, nickname, số mẻ đã giải / số mẻ trong kỳ, tổng thời gian; có phiên thì kèm hạng của mình; kỳ chưa có kết quả trả danh sách rỗng; kỳ mới bắt đầu là bảng mới
- Ưu tiên: Bắt buộc

### AC-DAILY-15: Bảng xếp hạng trên giao diện, chưa đăng nhập và bảng rỗng (thêm 2026-10-21)
- **Cho** thực khách giải xong V khi chưa đăng nhập
- **Khi** thẻ Món đặc biệt hiện "Đã giải"; thực khách bấm "Đăng nhập bằng Google" và đăng nhập thành công; rồi mở Bảng xếp hạng
- **Thì** thẻ hiện lời mời "Đăng nhập bằng Google để lên bảng xếp hạng"; đăng nhập xong kết quả tự gửi ngay (không cần bấm thêm), `solved_at` là lúc server nhận (sau khi đăng nhập) và hiện "Hạng #… · Streak …"; Bảng xếp hạng có 3 thẻ "Mẻ này", "Tuần", "Tháng"; bảng rỗng hiện "Chưa có ai giải món này" (thẻ Tuần/Tháng: "Chưa có ai giải món nào trong kỳ"), không để trống; chưa đăng nhập vẫn xem được bảng, kèm dòng nhắc đăng nhập
- Ưu tiên: Bắt buộc

### AC-DAILY-16: Thẻ thử thách nổi bật (thêm 2026-10-22)
- **Cho** mẻ hiện tại có Món đặc biệt, thực khách chưa giải
- **Khi** trang vừa tải xong
- **Thì** thẻ Món đặc biệt có nhãn "Thử thách" nổi bật ở đầu thẻ, câu dẫn "Ghép ra món bí ẩn này trên bàn lẩu" ngay dưới nhãn, emoji và gợi ý mờ của món cỡ chữ lớn hơn chữ thường của trang, nền thẻ dùng màu nhấn khác nền trang; đồng hồ "Mẻ mới sau …" vẫn hiện. Khi đã giải, nhãn đổi thành "Đã giải" như AC-DAILY-05
- Ưu tiên: Bắt buộc

### AC-DAILY-17: Bảng xếp hạng ở tab riêng (thêm 2026-10-22)
- **Cho** thực khách đang chơi, trên bàn có món và một ô nồi đã có món
- **Khi** bấm "Xem bảng xếp hạng" trên thẻ Món đặc biệt (hoặc tab "Bảng xếp hạng" ở đầu trang); rồi bấm tab "Bàn lẩu"
- **Thì** trang có hai tab "Bàn lẩu" và "Bảng xếp hạng"; thẻ Món đặc biệt không còn chứa bảng xếp hạng. Tab "Bảng xếp hạng" giữ 3 thẻ "Mẻ này", "Tuần", "Tháng" và mọi trạng thái của AC-DAILY-15 (bảng rỗng, dòng nhắc đăng nhập); 3 hạng đầu có huy chương 🥇🥈🥉; dòng của chính thực khách (khi đã đăng nhập và có tên trong bảng) được tô nổi. Quay lại tab "Bàn lẩu" thì món trên bàn và ô nồi giữ nguyên
- Ưu tiên: Bắt buộc

### AC-DAILY-18: Pool thử thách từ lõi không lặp trong 30 mẻ (thêm 2026-10-23)
- **Cho** kho chỉ có lõi classic hiện tại (59 phần tử depth 4-8 có `daily_hint`), mọi `trend_peak` = 0, lịch sử Món đặc biệt rỗng
- **Khi** chạy liên tiếp 90 mẻ `core` (version tăng dần)
- **Thì** 59 mẻ đầu chọn 59 món khác nhau; trong mọi chuỗi 30 mẻ liên tiếp không có món nào lặp; không mẻ nào thất bại vì Món đặc biệt; 35 phần tử thêm vào lõi ngày 22/10 có mặt trong kho từ mẻ muộn hơn nên đứng trước phần lõi cũ khi cùng mức mặn; chạy lại cùng chuỗi version ra cùng chuỗi món (tất định)
- Ưu tiên: Bắt buộc

### AC-DAILY-19: Admin chỉ định Món đặc biệt cho mẻ kế tiếp (thêm 2026-10-26, câu hỏi mở 83)
- **Cho** token admin đúng; phần tử P đang hoạt động, chưa bị chặn (P có thể ở bất kỳ depth nào, kể cả đã là Món đặc biệt trong 30 mẻ gần đây); phần tử Q bị chặn
- **Khi** admin chọn P làm Món đặc biệt cho mẻ kế tiếp kèm gợi ý; chọn Q; gửi gợi ý rỗng, dài quá 200 ký tự hoặc chứa tên P; chọn phần tử không tồn tại; chọn lại món khác trước khi mẻ chạy; bỏ chỉ định; rồi mẻ kế tiếp (`core` hoặc `full`) chạy
- **Thì** chọn P với gợi ý hợp lệ trả 200 và ghi 1 dòng audit (trước: chỉ định cũ hoặc trống, sau: P) theo AC-ADMIN-09; chọn Q, gợi ý sai trả 400 problem+json, phần tử không tồn tại trả 404, không đổi gì và không ghi audit; chọn lại thì chỉ định sau thay chỉ định trước; mẻ kế tiếp dùng P làm Món đặc biệt với gợi ý admin nhập, bỏ qua thứ tự độ mặn/mới (AC-DAILY-01) và luật không lặp 30 mẻ (AC-DAILY-18); mẻ đăng thành công thì chỉ định được xóa, các mẻ sau tự chọn lại; mẻ thất bại thì chỉ định giữ cho mẻ sau; lúc mẻ chạy mà P đã bị chặn thì mẻ bỏ chỉ định, tự chọn như thường và báo cáo đợt ghi "Chỉ định Món đặc biệt bị bỏ"; trang quản trị hiện chỉ định đang chờ (tên P, gợi ý) và nút bỏ chỉ định; áp dụng cho cả staging và production
- Ưu tiên: Tùy chọn
