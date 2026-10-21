# Tiêu chí nghiệm thu - Món đặc biệt hôm nay (DAILY)

> Giai đoạn 1. Component: pipeline (chọn món - logic thuần), worker (nhận kết quả, bảng xếp hạng, streak), web (thử thách, đếm bước, đồng hồ).
> Thực khách gửi kèm UUID của mình (header) ở mọi yêu cầu ghi; chỉ người đã đồng ý gửi dữ liệu (AC-PRIV-02) mới nộp được kết quả.

### AC-DAILY-01: Chọn Món đặc biệt
- **Cho** kho có phần tử trend mới (giai đoạn 2) và phần tử classic, cùng danh sách món đã từng chọn
- **Khi** pipeline chọn món cho mẻ mới
- **Thì** món được chọn có depth trong [4, 8], tới được từ khởi đầu, đang hoạt động, chưa từng được chọn, không bị hoãn nóng (AC-MOD-08), có gợi ý đạt kiểm duyệt; ưu tiên phần tử trend mới nhất, không có thì phần tử classic (thứ tự tất định theo seed = version mẻ). Hết ứng viên chưa dùng thì chọn món đã dùng **lâu nhất** thỏa các điều kiện còn lại (mặc định - câu hỏi mở)
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

### AC-DAILY-04: Bàn thử thách và đếm bước
- **Cho** thực khách chưa chơi Daily của mẻ hiện tại
- **Khi** bấm "Thử thách", ghép 7 lượt trong đó 2 lượt trượt, và lượt thứ 7 ra món đích
- **Thì** bàn thử thách bắt đầu từ 4 phần tử khởi đầu, tách khỏi Đĩa chính (mặc định - câu hỏi mở); bộ đếm hiện 7 bước; tên món lộ ra khi ghép được (so khóa băm); phần tử khám phá trên bàn thử thách cũng được thêm vào Đĩa chính
- Ưu tiên: Bắt buộc

### AC-DAILY-05: Tiếp tục thử thách sau khi tải lại
- **Cho** thực khách đang thử thách ở bước 4
- **Khi** tải lại trang trong cùng mẻ
- **Thì** bàn thử thách, các phần tử đã có trên bàn và bộ đếm 4 bước được khôi phục từ lưu trữ cục bộ; sang mẻ mới thì thử thách cũ đóng, bàn mới bắt đầu
- Ưu tiên: Bắt buộc

### AC-DAILY-06: Nộp kết quả hợp lệ
- **Cho** đường ghép gồm các bước (a, b, kết quả), mỗi bước là công thức có thật trong version hiện hành, mỗi đầu vào là phần tử khởi đầu hoặc kết quả của bước trước, bước cuối ra món đích; số bước khai báo ≥ số bước của đường
- **Khi** client gửi `POST` kết quả Daily cho version hiện hành
- **Thì** trả 201 với số bước, hạng hiện tại trong đợt và streak mới; kết quả được lưu một lần cho (UUID, version)
- Ưu tiên: Bắt buộc

### AC-DAILY-07: Nộp kết quả không hợp lệ
- **Cho** đường ghép có một bước không phải công thức có thật, hoặc dùng phần tử chưa có ở thời điểm đó, hoặc không kết thúc ở món đích, hoặc số bước khai báo nhỏ hơn số bước của đường, hoặc quá 200 bước
- **Khi** gửi `POST` kết quả
- **Thì** trả 422 problem+json nêu lỗi đầu tiên; không ghi gì; không đổi streak
- Ưu tiên: Bắt buộc

### AC-DAILY-08: Nộp trùng và nộp cho mẻ đã qua
- **Cho** UUID đã nộp cho version V; và một yêu cầu nộp cho version V−1 khi V đã là hiện hành
- **Khi** gửi lại kết quả cho V; gửi kết quả cho V−1
- **Thì** nộp lại trả 409 kèm kết quả đã lưu (không ghi đè); nộp cho mẻ đã qua trả 410; thiếu UUID hoặc UUID sai định dạng trả 400
- Ưu tiên: Bắt buộc

### AC-DAILY-09: Bảng xếp hạng đợt
- **Cho** đợt V có 30 kết quả, có người hòa số bước, có người không đặt nickname
- **Khi** gọi `GET` bảng xếp hạng của V (kèm UUID của mình hoặc không)
- **Thì** trả tối đa 20 dòng: hạng, nickname (không có nickname → "Thực khách ẩn danh"), số bước; xếp theo số bước tăng dần, hòa thì ai nộp trước đứng trước; không có UUID của người khác trong phản hồi; nếu có UUID của mình thì kèm hạng của mình kể cả khi ngoài top 20; đợt chưa có kết quả trả danh sách rỗng
- Ưu tiên: Bắt buộc

### AC-DAILY-10: Streak
- **Cho** thực khách hoàn thành ít nhất 1 Món đặc biệt vào các ngày 20, 21, 22/10 (ngày theo GMT+7 của `batch_at`), bỏ ngày 23, rồi hoàn thành ngày 24
- **Khi** nộp kết quả mỗi ngày
- **Thì** streak sau ngày 22 là 3; sau ngày 24 là 1; streak dài nhất lưu là 3; hoàn thành 2 món trong cùng một ngày chỉ tính 1 ngày (định nghĩa theo ngày - câu hỏi mở). `GET` streak của mình trả streak hiện tại (về 0 nếu ngày gần nhất hoàn thành cách hôm nay quá 1 ngày) và streak dài nhất
- Ưu tiên: Bắt buộc

### AC-DAILY-11: Bảng xếp hạng streak
- **Cho** nhiều thực khách có streak hiện tại khác nhau
- **Khi** gọi `GET` bảng xếp hạng streak
- **Thì** trả tối đa 20 dòng: hạng, nickname (hoặc "Thực khách ẩn danh"), streak hiện tại; xếp giảm dần, hòa thì ai đạt trước đứng trước; streak 0 không xuất hiện
- Ưu tiên: Bắt buộc

### AC-DAILY-12: Đồng hồ đếm ngược theo manifest thật
- **Cho** manifest có `batch_at` = 17:03 UTC (cron trễ 3 phút)
- **Khi** client tính đồng hồ lúc 17:30 UTC; và lúc 05:20 UTC hôm sau khi manifest chưa đổi
- **Thì** lúc 17:30 hiện thời gian tới mốc mẻ kế tiếp tính từ `batch_at` (mốc 05:00 UTC kế tiếp sau `batch_at`); khi đã quá mốc mà manifest chưa đổi thì hiện "Mẻ mới sắp lên" (không hiện số âm) và client kiểm manifest lại mỗi 60 s
- Ưu tiên: Bắt buộc

### AC-DAILY-13: Giới hạn tần suất nộp
- **Cho** cùng UUID hoặc cùng IP băm gửi quá 10 yêu cầu nộp/phút (mặc định)
- **Khi** gửi yêu cầu thứ 11 trong phút
- **Thì** trả 429 problem+json có `Retry-After`
- Ưu tiên: Bắt buộc

### AC-DAILY-14: Ghép thử thách qua nồi lẩu
- **Cho** bàn thử thách đang mở với 4 phần tử khởi đầu; graph có Cay + Deadline = Tới Công Chuyện và không có công thức Cay + Cười
- **Khi** bấm Cay rồi Cười trên bàn thử thách; bấm Cay rồi Cười lần nữa; rồi bấm Cay rồi Deadline
- **Thì** mỗi món bấm được đặt vào chỗ thả trống tiếp theo của nồi lẩu trên mặt bàn (món đầu chỗ 1, món sau chỗ 2; nồi đang ngoài màn hình thì được cuộn vào tầm nhìn); đủ 2 món thì nồi sôi như AC-GAME-02 (tối đa 1,2 s, bấm trong lúc sôi bị bỏ qua) rồi 2 chỗ thả trống lại; trượt thì hiện câu Nồi trào theo cặp (AC-GAME-05) ở nồi, không kèm gợi ý; câu bị ẩn trong lúc nồi sôi nên lần trượt liên tiếp thứ 2 cũng hiện lại câu (kèm hiệu ứng như bàn lẩu); ghép được thì món mới hiện trên bàn thử thách và vào Đĩa chính (AC-DAILY-04); bộ đếm hiện 3 bước. Mặt bàn chính, Đĩa (ngoài món mới) và bộ đếm trượt của AC-GAME-06 không đổi
- **Và** (cập nhật 2026-10-21) bấm món thử thách hay thả món từ Đĩa nhúng/mặt bàn đều chỉ điền vào chỗ thả trống của nồi, không bỏ món đang chờ ở chỗ kia (kể cả khi khác loại). Nồi có 1 món thử thách + 1 món Đĩa (cặp trộn) thì sôi và ghép như bàn lẩu (AC-GAME-02/05): ghép được thì món mới vào Đĩa chính, trượt thì hiện câu Nồi trào như bàn lẩu; cặp trộn tính +1 bước thử thách nhưng không thêm món vào bàn thử thách và không vào đường ghép gửi lên server (AC-DAILY-06 cho phép số bước khai báo lớn hơn số bước của đường), nên món ghép ngoài bàn thử thách không dùng được để giải thử thách
- Ưu tiên: Bắt buộc

### AC-DAILY-15: Đồng ý sau khi giải xong thì kết quả vẫn lên bảng xếp hạng (thêm 2026-10-21)
- **Cho** thực khách chưa đồng ý gửi dữ liệu (AC-PRIV-02) giải xong thử thách của version hiện hành, bàn thử thách hiện lời mời đồng ý
- **Khi** thực khách bấm đồng ý; rồi mở Bảng xếp hạng
- **Thì** kết quả tự được gửi ngay sau khi đồng ý (không cần bấm "Gửi lại kết quả") và hiện "Hạng #… · Streak …"; bảng xếp hạng có dòng của thực khách. Bảng xếp hạng rỗng thì hiện "Chưa có ai hoàn thành món này", không để trống; thực khách chưa đồng ý mở bảng xếp hạng thì thấy thêm dòng nhắc "Đồng ý gửi dữ liệu để kết quả của bạn lên bảng"
- Ưu tiên: Bắt buộc
