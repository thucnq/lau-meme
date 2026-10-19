# Ghi chú họp — Lẩu Meme

> Nguồn: các buổi trao đổi ngày 2026-10-19 giữa Thuc (chủ dự án, người duy nhất làm) và Claude.
> Dùng làm đầu vào cho `/dk:spec docs/input/`. Đây là ghi chú, **không phải** BRD hay AC.

## 1. Sản phẩm

- **Tên**: Lẩu Meme. (Đã cân nhắc và bỏ: Meme Craft, mememories — khó gõ, không nói cách chơi.)
- **Là gì**: web game kiểu Infinite Craft (neal.fun/infinite-craft). Người chơi kéo 2 phần tử thả vào **nồi lẩu** để ghép ra phần tử mới. Nội dung là meme.
- **Đối tượng**: người Việt dùng mạng xã hội. Nội dung = meme Việt + meme quốc tế mà người Việt biết.
- **Mục tiêu**: viral công khai. Quảng cáo/kiếm tiền tính sau, **không** làm ở bản đầu.
- **Nguồn lực**: dự án cá nhân, chỉ Thuc làm, khoảng **20 giờ/tuần**. Không báo giá.
- **Mốc**: go-live **sớm nhất có thể**, ra mắt công khai luôn — **không làm beta kín**.

### Chỉ số thành công
- Tỉ lệ người chơi quay lại ngày hôm sau (D1 retention) và sau 7 ngày (D7).
- Số lượt chia sẻ thẻ "Món đặc biệt hôm nay" và thẻ "Công thức gia truyền".
- Số người chơi Daily mỗi ngày.
- Chỉ số sức khỏe nội dung: tỉ lệ ghép trượt, tỉ lệ công thức bị bấm "nhạt", số báo cáo vi phạm.
- Đo bằng dữ liệu ẩn danh tự thu (bảng sự kiện tối giản trong D1 hoặc Cloudflare Web Analytics). Không dùng công cụ theo dõi bên thứ ba có cookie.

## 2. Quyết định đã chốt (kèm lý do)

| # | Quyết định | Lý do |
|---|---|---|
| Q1 | Tập meme **đóng**: phần tử và công thức sinh sẵn theo lô; **không gọi LLM khi người chơi ghép** | Chi phí $0, ghép tức thì (< 50 ms), kiểm duyệt được trước khi lên mạng |
| Q2 | Hệ thống **tự tìm liên kết** giữa các meme (sinh công thức ghép) | Không thể viết tay hết; mỗi meme mới phải ghép ra được từ các phần tử đã có |
| Q3 | **Crawl 2 lần/ngày lúc 00:00 và 12:00 GMT+7** | Nhịp "Mẻ nhúng mới" cho người chơi lý do quay lại |
| Q4 | Mỗi đợt **tự động đăng**, không duyệt tay | Một người không thể duyệt tay 2 lần/ngày; bù lại bằng kiểm duyệt 2 lớp + phanh khẩn cấp sau khi đăng (mục 5.5) |
| Q5 | LLM chạy lô: **Gemini free tier** | Chi phí $0. Chấp nhận giới hạn quota và chất lượng hài tiếng Việt không đều ⇒ cần bước "giám khảo" |
| Q6 | **Daily Meme** ("Món đặc biệt hôm nay") **và First Discovery** ("Công thức gia truyền") ngay từ bản đầu | Hai động cơ viral: thẻ chia sẻ kiểu Wordle và cảm giác "người đầu tiên trên thế giới" |
| Q7 | Pipeline viết bằng **Python** | Thư viện crawl và Gemini SDK sẵn, chạy nhẹ trên GitHub Actions |
| Q8 | Hạ tầng: Cloudflare (Worker TypeScript phục vụ cả web tĩnh lẫn API, D1), GitHub Actions cron, repo **public** | Chi phí vận hành $0, không tính domain. Repo public để Actions miễn phí — vì vậy **không bí mật nào được nằm trong repo** |
| Q9 | Mỗi phần tử có **ảnh minh họa tự tạo** (cập nhật 19/10 14:28). **Không dùng ảnh meme gốc**: ảnh gốc có bản quyền và thường có mặt người thật (quyền hình ảnh, Luật BVDLCN 2025). Ảnh do AI vẽ lại **khái niệm**, một phong cách thống nhất (sticker, có nồi lẩu khi hợp), không người thật, không chép bố cục/nhân vật có bản quyền. Emoji luôn hiện trước, ảnh tải sau; ảnh lỗi hoặc bị chặn thì giữ emoji | Người chơi muốn có hình; vẽ lại khái niệm là cách duy nhất vừa có hình vừa không vi phạm. Vẽ bằng Workers AI (FLUX.1 schnell) — gói free có hạn mức neuron/ngày đủ cho vài trăm ảnh nhỏ/ngày (**cần kiểm tra** con số hiện hành); Gemini free không có tạo ảnh |
| Q12 | Giọng hài **càng mặn càng tốt** trong giới hạn danh mục cấm; tỉ lệ meme **Việt / quốc tế = 7 / 3** | Chốt 19/10 14:28 |
| Q13 | NFR ghép trượt đổi thành **20 lượt đầu ≤ 45%, cả ván ≤ 70%** (chơi ngẫu nhiên, mô phỏng); pipeline sinh công thức bổ sung hàng loạt mỗi đợt; khi trượt thỉnh thoảng **gợi ý một phần tử nên thử** (lấy từ công thức có thật, không lộ kết quả) | Chốt 19/10 15:23. Tập đóng không dày được như Infinite Craft |
| Q14 | Ảnh lưu ở **R2**, tên file theo băm nội dung (`/img/<sha256-12>.webp`), phục vụ qua Worker với Cache API + `Cache-Control: public, max-age=31536000, immutable`; WebP 256×256 (~10–20 KB). Dự phòng nếu không mở được R2: kho ảnh trong repo riêng, đóng gói làm static assets mỗi lần deploy | Rẻ nhất + nhanh nhất: R2 free 10 GB, 10 triệu lượt đọc/tháng, không phí băng thông; file bất biến nên gần như mọi lượt đọc trúng cache biên. **Cần kiểm tra** R2 có bắt khai báo thẻ thanh toán không. Chốt 19/10 15:23 (ADR ở /dk:design) |
| Q10 | Phát triển bằng plugin `dk` (cần bản 0.7.0 hỗ trợ Python/TS) | Giữ cổng spec / contract / merge; test viết trước code |
| Q11 | Chủ đề "lẩu" xuyên suốt UI và từ vựng (mục 4) | Khác biệt rõ với bản gốc, dễ nhận ra trên thẻ chia sẻ |

## 3. Phạm vi

### Trong bản đầu (MVP)
Chơi ghép trên web (điện thoại + máy tính), Daily, First Discovery, pipeline tự động 2 lần/ngày, kiểm duyệt, báo cáo, phanh khẩn cấp, trang admin tối giản, trang chính sách quyền riêng tư.

### Ngoài phạm vi bản đầu
Quảng cáo, đăng nhập tài khoản, ảnh/video meme, app mobile, đa ngôn ngữ (chỉ tiếng Việt), chế độ chơi với bạn bè theo thời gian thực, người chơi tự gửi meme.

## 4. Từ vựng "lẩu" (dùng thống nhất trong UI và tài liệu)

| Khái niệm | Tên trong game |
|---|---|
| Hành động ghép | Nhúng lẩu |
| Ghép trượt (cặp không có công thức) | Nồi trào / Khét rồi |
| Kho phần tử của người chơi | Đĩa nhúng |
| Daily Meme | Món đặc biệt hôm nay |
| First Discovery | Công thức gia truyền của <nickname> |
| Mỗi đợt crawl | Mẻ nhúng mới (lúc 0h và 12h) |
| Phần tử mới của đợt gần nhất | Nhãn "MỚI" |

## 5. Yêu cầu chức năng

### 5.1 GAME — chơi ghép
- Màn hình chính: **nồi lẩu ở giữa** có 2 chỗ thả. Thả đủ 2 phần tử ⇒ nồi sôi, bốc hơi, món mới "trồi lên". Hiệu ứng tối đa ~1,2 giây và **bỏ qua được** (chạm để bỏ qua).
- Vẫn cho **thả chồng trực tiếp** 2 phần tử lên nhau trên mặt bàn để ghép nhanh (hiệu ứng hơi lẩu nhỏ).
- Đĩa nhúng: danh sách phần tử đã có, ô tìm kiếm (gõ không dấu vẫn tìm được), sắp xếp theo thời gian khám phá / tên / độ sâu.
- Ghép trượt: hiện 1 câu "Nồi trào / Khét rồi" vui; **cùng một cặp luôn ra cùng một câu**.
- Phần tử khởi đầu: 4 phần tử (đề xuất ở `noi-dung-loi.md`).
- Tiến độ (phần tử đã có, vị trí trên bàn) lưu cục bộ trên trình duyệt. Có nút "Dọn bàn" và "Chơi lại từ đầu" (xác nhận trước khi xóa).
- Thao tác chuột và cảm ứng đều mượt; chơi được trên màn hình rộng 375 px.
- Giao diện tiếng Việt, có chế độ tối. Hướng dẫn 1 màn hình ở lần đầu.

### 5.2 DAILY — Món đặc biệt hôm nay
- Mỗi đợt (0h, 12h) chọn **1 món** làm thử thách: ghép ra nó trong ít bước nhất.
- Công bố trước: emoji + 1 gợi ý mờ. Tên chỉ lộ ra khi người chơi ghép được.
- Đếm số bước ghép (mọi lượt ghép kể từ khi bắt đầu thử thách, kể cả trượt).
- Thẻ chia sẻ kiểu Wordle: dạng chữ (dán được lên Facebook/Zalo/Messenger) + ảnh PNG hình nồi lẩu; ghi số bước, chuỗi emoji các bước, link; **không lộ đáp án**.
- Bảng xếp hạng ít bước nhất trong đợt (theo nickname).
- Đồng hồ đếm ngược tới mẻ nhúng tiếp theo.

### 5.3 DISCOVERY — Công thức gia truyền
- Người chơi ẩn danh: UUID sinh và lưu cục bộ + nickname tùy chọn (lọc từ cấm, giới hạn độ dài).
- Khi ghép ra phần tử **chưa ai báo về**, client gửi lên server; server **kiểm tra công thức có thật** rồi ghi nhận người đầu tiên.
- Hiển thị "Công thức gia truyền của <nickname>" trên phần tử đó cho mọi người + thẻ chia sẻ.
- Giới hạn tần suất theo UUID và IP để giảm gian lận. Chấp nhận còn chút gian lận vì không có đăng nhập.

### 5.4 PIPELINE — mẻ nhúng 2 lần/ngày (Python, GitHub Actions cron 17:00 và 05:00 UTC)
Thứ tự bước:
1. **Crawl** khái niệm meme (tên, câu nói, ngữ cảnh, link nguồn). **Không tải ảnh.** Nguồn hợp lệ, tôn trọng robots.txt và điều khoản: Reddit API, Know Your Meme, Google Trends VN, YouTube trending, RSS trang giải trí Việt. **Không scrape Facebook/TikTok.** Mỗi nguồn một adapter; một nguồn lỗi không làm hỏng cả đợt.
2. **Khử trùng**: so khớp chuỗi (bỏ dấu, chữ thường) trước, rồi mới hỏi LLM cho các ca gần giống; bỏ meme đã có.
3. **Kiểm duyệt 2 lớp**: danh sách từ cấm, rồi LLM phân loại theo danh mục cấm (mục 7). Không chắc thì loại. Kiểm duyệt cả phần tử lẫn tên kết quả của mọi công thức.
4. **Liên kết ngược**: với mỗi meme mới, LLM đề xuất 2–3 cặp phần tử **đã có** ghép ra nó. Code kiểm tra: cặp chưa có công thức khác, không tự tham chiếu; tính lại độ sâu (depth) bằng BFS. Meme không nối được vào hàng chờ, thử lại đợt sau.
5. **Công thức bổ sung**: tăng mật độ ghép, mục tiêu mỗi phần tử đang hoạt động có ≥ 3 công thức đi ra.
6. **Giám khảo**: LLM chấm độ hài 1–5 theo rubric cho mỗi công thức mới; chỉ giữ ≥ 3.
6b. **Vẽ minh họa** cho phần tử mới: prompt từ gợi ý ảnh của phần tử + phong cách chung; vẽ bằng Workers AI; **kiểm duyệt ảnh** bằng Gemini (đọc ảnh, đối chiếu danh mục cấm, phát hiện mặt người giống thật/chữ lạ/logo); không đạt thì vẽ lại 1 lần, vẫn không đạt thì để emoji. Hết hạn mức thì để emoji, vẽ bù ở đợt sau.
7. **Chọn Món đặc biệt**: meme trend mới nhất có depth trong [4, 8], chưa từng được chọn; không có thì lấy meme kinh điển chưa dùng.
8. **Xuất** `graph` đã mã hóa (mục 6.1) + manifest có version; giữ 14 bản gần nhất để rollback; deploy.
9. **Báo cáo đợt** qua GitHub Issue: số meme thêm, bị chặn, lỗi nguồn, quota Gemini đã dùng.

Yêu cầu chung: idempotent (chạy lại cùng đợt cho cùng kết quả); **lỗi giữa chừng không đăng gì, giữ nguyên bản cũ**; có lệnh chạy tay; gom nhiều meme vào một lời gọi Gemini, retry có backoff, hết quota thì dừng êm và để phần còn lại cho đợt sau; chỉ gửi dữ liệu meme công khai cho Gemini.

### 5.5 AN TOÀN — vì tự động đăng
- Nút "Báo cáo" trên mỗi phần tử (chọn lý do).
- Đủ **3 báo cáo từ 3 UUID khác nhau** ⇒ phần tử tự ẩn ngay, không chờ người.
- **Danh sách chặn nóng** trên server: client tải khi khởi động; ẩn/chặn một phần tử có hiệu lực ngay, không cần deploy.
- **Rollback** graph về đợt trước bằng một lệnh (workflow chạy tay).
- **Trang admin** (bảo vệ bằng token): xem báo cáo, ẩn/hiện/chặn phần tử và công thức, xem nhật ký các đợt.

### 5.6 Phản hồi nội dung
- Trên mỗi công thức vừa ghép ra: nút "Ngon" / "Nhạt". Dữ liệu này đưa vào bước giám khảo các đợt sau (ví dụ hạ điểm hoặc ẩn công thức nhiều "Nhạt").

## 6. Yêu cầu phi chức năng

| Nhóm | Yêu cầu |
|---|---|
| Hiệu năng | Ghép phản hồi < 50 ms (tra trong bộ nhớ, không gọi mạng); tải trang đầu < 2 s trên 4G |
| Nội dung | Ghép trượt khi chơi ngẫu nhiên (mô phỏng): **20 lượt đầu ≤ 45%, cả ván 100 lượt ≤ 70%** (Q13). Lõi hiện tại: ≈ 41% / ≈ 67% — đạt |
| Pipeline | Một đợt < 15 phút và nằm trong quota Gemini free |
| Thiết bị | Màn hình 375 px trở lên; Chrome/Safari di động 2 bản gần nhất |
| Ngôn ngữ | Tiếng Việt; tìm kiếm không dấu |
| Chi phí | Vận hành $0, không tính domain |
| Bảo mật | Giới hạn tần suất mọi endpoint ghi; validate đầu vào; CORS chỉ cho domain game; token admin chỉ nằm trong secret; bí mật chỉ ở GitHub Secrets / Cloudflare secrets (repo public) |
| Dữ liệu cá nhân | Chỉ lưu UUID ẩn danh + nickname (+ IP băm để giới hạn tần suất, giữ ngắn hạn). **Không gửi dữ liệu người chơi cho LLM.** Có trang chính sách ngắn. Tuân thủ Luật BVDLCN 2025 và NĐ 356/2025 |
| Vận hành | Báo cáo mỗi đợt; khôi phục được trong 5 phút (ẩn nóng hoặc rollback) |

### 6.1 Chống lộ đáp án
`graph` công khai không được chứa công thức dạng đọc được: khóa tra cứu là băm của cặp tên đã chuẩn hóa; kết quả mã hóa bằng khóa dẫn xuất từ chính 2 tên đầu vào ⇒ chỉ ai đang có cả 2 phần tử mới mở được. Cơ chế này chống đọc trộm cả cây, **không** chống người dò thử từng cặp — chấp nhận.

## 7. Danh mục nội dung cấm
- Tên hoặc hình ảnh **người thật** bị chế giễu (kể cả người nổi tiếng).
- Chính trị; tôn giáo; tình dục.
- Phân biệt vùng miền, sắc tộc, giới tính; body shaming.
- Bạo lực; ma túy; tự hại.
- Nickname người chơi áp cùng danh mục.

### 7.1 Người thật — luật nhận diện (chốt 19/10 15:23)
- **Phép thử**: nếu người chơi Việt bình thường đọc phần tử (tên, emoji, ảnh, mô tả, gợi ý Daily) mà **nhận ra một người cụ thể**, thì coi như đã nêu tên — dù chỉ là viết tắt (vd "TG"), biệt danh, tên vai diễn, nghệ danh, câu cửa miệng gắn với họ, hay ảnh "na ná". Viết tắt/biệt danh **không** làm giảm rủi ro pháp lý; nó còn cho thấy cố ý ám chỉ.
- **Không bao giờ**: phần tử nhận ra được người thật gắn với cáo buộc (ứng xử, quấy rối, tình dục, pháp lý, nợ nần, đời tư), kể cả khi báo chí đang đưa tin; đùa về quấy rối/xâm hại dưới mọi hình thức (cả dạng chung chung).
- **Được phép**: câu nói đã thành tiếng lóng chung, tách khỏi người gốc và không chế giễu ai ("ét o ét", "còn cái nịt"); **hiện tượng** chung không chỉ vào ai ("Đào Mả Phốt", "Fan Quay Xe", "Tâm Thư Xin Lỗi"). Mô tả, gợi ý Daily và ảnh của các phần tử này **không** nhắc vụ việc hay người đang là tâm điểm.
- **Thời điểm**: khi một hiện tượng chung đang nóng vì **một** vụ của **một** người (nhất là vụ có yếu tố quấy rối), không chọn phần tử đó làm Món đặc biệt và không gắn nhãn "MỚI" nổi bật cho tới khi tin nguội (đề xuất 30 ngày) — tránh để cả game thành "câu chuyện về người đó".
- **Pipeline**: kiểm duyệt dựa trên **ngữ cảnh nguồn**, không chỉ tiêu đề: adapter crawl gửi kèm đoạn nguồn; LLM trả lời "khái niệm này có trỏ tới một người cụ thể trong nguồn không, là ai, các tên gọi khác là gì"; mọi tên gọi khác đó vào danh sách chặn bí danh (áp cho cả nickname người chơi). Không chắc thì loại.
- Ảnh minh họa: thêm cấm mặt người giống người thật, logo/thương hiệu, nhân vật có bản quyền (vd không vẽ lại ảnh Doge gốc, truyện "This is fine" gốc, Pepe), chữ trong ảnh.

## 8. Bất biến (để `/dk:spec` viết `docs/acceptance/inv.md`, AC-INV)
1. Ghép đối xứng: A + B và B + A cho cùng kết quả.
2. Mỗi cặp có **tối đa một** kết quả.
3. Mọi phần tử đang hoạt động đều **tới được** từ 4 phần tử khởi đầu; `depth` = độ dài đường ngắn nhất (BFS).
4. `graph` công khai không chứa tên kết quả dạng đọc được; **không giải mã được khi thiếu một trong hai đầu vào**.
5. Pipeline idempotent: cùng đầu vào đợt ⇒ cùng `graph`.
6. Đợt lỗi giữa chừng ⇒ bản đang chạy không đổi.
7. Không phần tử hay công thức đang hoạt động nào vi phạm mục 7.
8. Server từ chối ghi nhận First Discovery cho công thức không có thật.
9. Phần tử đủ 3 báo cáo từ 3 UUID khác nhau ⇒ không còn hiện cho người chơi.
10. Món đặc biệt luôn có depth trong [4, 8] và tới được.

## 9. Gợi ý nhóm tính năng (để `/dk:spec` tham khảo khi đặt Mã)
`GAME` chơi ghép · `DAILY` món đặc biệt · `DISC` công thức gia truyền · `PIPE` pipeline · `MOD` kiểm duyệt + báo cáo + chặn nóng · `ADMIN` trang quản trị · `SHARE` thẻ chia sẻ · `PRIV` chính sách và dữ liệu cá nhân.

## 10. Rủi ro đã biết
- **Không có beta**: làn sóng đầu tiên gặp nội dung nhạt hoặc lỗi trên điện thoại sẽ khó quay lại. Giảm bằng: chạy pipeline thật vài ngày trên môi trường staging trước go-live (kiểm nội dung, không phải beta người dùng) và kiểm thủ công trên 2–3 điện thoại.
- Quota Gemini free có thể thay đổi bất kỳ lúc nào ⇒ pipeline phải dừng êm, không làm hỏng bản đang chạy.
- Nội dung nhạy cảm lọt qua kiểm duyệt tự động ⇒ phanh khẩn cấp mục 5.5.
- Cron của GitHub Actions có thể trễ vài phút đến vài chục phút ⇒ đồng hồ đếm ngược dựa trên manifest thật, không dựa trên giờ lý thuyết.
- Ảnh AI có thể vô tình giống người thật hoặc nhân vật có bản quyền ⇒ kiểm duyệt ảnh tự động + nút báo cáo áp cho cả ảnh; ảnh bị báo cáo thì về emoji ngay.

## 11. Câu hỏi mở
1. Domain: mua domain riêng (vd `laumeme.vn`) hay tạm dùng tên miền miễn phí của Cloudflare (`*.workers.dev`)?
2. Đo chỉ số: Cloudflare Web Analytics (không cookie) có đủ, hay cần bảng sự kiện riêng trong D1?
3. Bảng xếp hạng Daily: chỉ đợt hiện tại, hay có thêm bảng "chuỗi ngày liên tiếp" (streak)?
4. Khi một meme trend bị ẩn do báo cáo, các công thức đi ra từ nó xử lý thế nào: ẩn theo, hay giữ nhưng không gợi ý?
5. Kênh ra mắt: Facebook group, TikTok, hay cả hai — có cần trang giới thiệu riêng không?
6. ~~NFR ghép trượt~~ — đã chốt Q13.
7. ~~Lưu ảnh ở đâu~~ — đã chốt Q14 (R2 + cache biên); còn kiểm tra R2 có cần thẻ thanh toán.
