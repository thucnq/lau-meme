# BRD - Lẩu Meme

> Phiên bản: 0.1 · Ngày: 2026-10-19 · Trạng thái: Nháp
> Nguồn: `docs/input/ghi-chu-hop.md`, `docs/input/noi-dung-loi.md|json`, `docs/scope.md` (đã chốt, kèm trả lời 5 câu hỏi phạm vi), `docs/input/mquiz.md` (QUIZ, 2026-10-28)

## 1. Bối cảnh và mục tiêu
- **Vấn đề**: chưa có trò chơi ghép kiểu Infinite Craft bằng meme Việt; người Việt trên mạng xã hội cần một trò ngắn, hài, có lý do quay lại mỗi ngày và có thứ để khoe.
- **Sản phẩm**: web game "Lẩu Meme" - kéo 2 phần tử thả vào nồi lẩu để ghép ra phần tử mới. Tập phần tử/công thức đóng, sinh sẵn theo lô; không gọi LLM khi người chơi ghép.
- **Mục tiêu đo được** (đo bằng METRIC):
  - D1 retention và D7 retention theo UUID (mốc mục tiêu: chưa đặt - xem `open-questions.md`).
  - Số người chơi Món đặc biệt mỗi ngày; số lượt chia sẻ thẻ Daily và thẻ Công thức gia truyền.
  - Sức khỏe nội dung: ghép trượt khi chơi ngẫu nhiên 20 lượt đầu ≤ 45 %, cả ván 100 lượt ≤ 70 %; tỉ lệ "Nhạt"; số báo cáo.
  - Vận hành $0 (không tính domain).
- **Giai đoạn** (trả lời câu hỏi phạm vi 1–2):
  - **Giai đoạn 1 - go-live**: GAME, GRAPH, SEED, DAILY (kèm streak), DISC, SHARE, REPORT, ADMIN, METRIC, PRIV; nội dung chỉ là lõi classic; mẻ nhúng chạy **chế độ lõi** (chỉ đổi Món đặc biệt + manifest, không crawl, không LLM) - AC-PIPE-01.
  - **Giai đoạn 2**: PIPE đầy đủ (chạy tay trước, sau đó bật cron tự động đăng), MOD, ART (ảnh minh họa; giai đoạn 1 chỉ dùng emoji).
  - Tùy chọn: FEEDBACK.
  - Sau go-live (thêm 2026-10-28): QUIZ (mQuiz - đố meme theo phòng).
- **Ngoài phạm vi**: quảng cáo/kiếm tiền, đăng nhập tài khoản, video meme gốc, app mobile, đa ngôn ngữ, người chơi tự gửi meme, trang giới thiệu/landing riêng (câu hỏi phạm vi 5), scrape Facebook/TikTok. (cập nhật 2026-10-28: bỏ "chơi với bạn bè thời gian thực" khỏi danh sách này - nay là QUIZ.)

## 2. Người dùng và vai trò
| Vai trò | Mô tả | Quyền chính |
|---|---|---|
| Thực khách (người chơi ẩn danh) | Định danh bằng UUID sinh trên trình duyệt; nickname tùy chọn | Chơi ghép, ghép ra Món đặc biệt, gửi Công thức gia truyền, báo cáo, Ngon/Nhạt, xem/xuất/xóa dữ liệu của mình; tạo/vào phòng mQuiz, xem lịch sử mQuiz của mình (thêm 2026-10-28) |
| Thực khách đã đăng nhập Google (thêm 2026-10-21) | Như trên + tài khoản định danh bằng băm HMAC mã `sub` của Google; phiên cookie HttpOnly | Thêm: nộp kết quả Món đặc biệt, có tên trên bảng xếp hạng mẻ/tuần/tháng/streak/cống hiến; đề xuất meme mới (CONTRIB, thêm 2026-10-23); nickname và streak theo tài khoản trên nhiều máy |
| Chủ phòng mQuiz (thêm 2026-10-28) | Thực khách đã tạo phòng, hoặc được chuyển quyền khi chủ phòng rời phòng chờ | Bắt đầu ván, chơi lại; không có quyền gì ngoài phòng đó |
| Quản trị (Thuc) | Một người, xác thực bằng 1 token lưu trong Cloudflare secret | Xem báo cáo, ẩn/hiện/chặn phần tử và công thức, xem nhật ký đợt (kèm thống kê crawl) và audit; gán tier; sửa và duyệt đề xuất meme (cập nhật 2026-10-23) |
| Pipeline (GitHub Actions) | Tác vụ máy, xác thực bằng token trong GitHub Secrets | Đọc nội dung, ghi nội dung + graph + manifest mới; không đọc dữ liệu người chơi |

## 3. Danh sách tính năng
| Mã | Tính năng | Mô tả ngắn | Ưu tiên (Bắt buộc/Tùy chọn) | File tiêu chí |
|---|---|---|---|---|
| GAME | Chơi ghép (Nhúng lẩu) | Nồi lẩu 2 chỗ thả + thả chồng; Đĩa nhúng (tìm không dấu, sắp xếp); Nồi trào cố định theo cặp + gợi ý; nhãn "MỚI"; lưu cục bộ; chế độ tối; hướng dẫn lần đầu; ghép < 50 ms; (cập nhật 2026-10-24) bàn cao hơn, Đĩa cao bằng bàn, vùng cấm đặt món, bấm là vào nồi, hiệu ứng Vàng/Đỏ, giao diện mới; (cập nhật 2026-10-25) món bóng theo con trỏ, mang nền/viền/hình nhỏ tier | Bắt buộc | `docs/acceptance/game.md` |
| GRAPH | Graph mã hóa + manifest + rollback | Khóa = băm cặp tên chuẩn hóa, kết quả mã hóa bằng khóa dẫn xuất từ 2 tên; manifest có version + giờ mẻ thật; giữ 14 bản; rollback bằng workflow chạy tay | Bắt buộc | `docs/acceptance/graph.md` |
| SEED | Nạp lõi nội dung classic | Nạp `noi-dung-loi.json` (174 phần tử, 518 công thức, 40 câu Nồi trào, 4 khởi đầu); kiểm tới được, không trùng | Bắt buộc | `docs/acceptance/seed.md` |
| PIPE | Pipeline Mẻ nhúng mới | Chế độ lõi (giai đoạn 1); crawl theo adapter, khử trùng, liên kết ngược + BFS, hàng chờ, công thức bổ sung, giám khảo, deploy; idempotent; gom lô Gemini; báo cáo đợt qua GitHub Issue (giai đoạn 2); nguồn Tuổi Trẻ và Threads, mức trending `trend_peak`, staging mỗi 2 tiếng (cập nhật 2026-10-23); lô Gemini 10, chia đôi khi lỗi; khái niệm được bỏ chặn đi tiếp không kiểm duyệt lại (cập nhật 2026-10-30) | Bắt buộc | `docs/acceptance/pipe.md` |
| MOD | Kiểm duyệt nội dung tự động | Từ cấm + LLM theo danh mục cấm; luật người thật dựa trên ngữ cảnh nguồn; danh sách chặn bí danh; không chắc thì loại; hoãn nội dung nóng 30 ngày (giai đoạn 2); bị chặn thì lưu lại kèm mọi lý do, không bỏ đi; chặn "không phải meme" ở cả hai lớp (livestream, lịch thi đấu, tên người/đội/bài hát đứng một mình; AC-MOD-12, AC-MOD-13) (cập nhật 2026-10-30) | Bắt buộc | `docs/acceptance/mod.md` |
| ART | Ảnh minh họa tự tạo | Workers AI vẽ khái niệm phong cách vẽ tay, Gemini kiểm duyệt ảnh, phóng lớn ảnh khi ghép ra món lần đầu, R2 + Cache API immutable, emoji dự phòng (giai đoạn 2); vẽ bù phần tử lõi (cập nhật 2026-10-23); (cập nhật 2026-10-24) ưu tiên vẽ món Vàng/Đỏ, admin tải tranh vẽ tay (tùy chọn); (cập nhật 2026-10-25) admin tải tranh vẽ tay thay ảnh (AC-ART-13), dùng link của đề xuất làm ảnh món khi duyệt (AC-ART-14); (cập nhật 2026-10-30) job chạy tay tìm ảnh trên web cho meme chưa có ảnh, không lọc mặt người thật hay bản quyền (AC-ART-15) | Bắt buộc | `docs/acceptance/art.md` |
| DAILY | Món đặc biệt hôm nay | 1 món/mẻ (độ sâu [4, 8]); ưu tiên mặn (trending) rồi mới, không trùng 30 mẻ gần nhất, lịch mẻ trong manifest (cập nhật 2026-10-23); emoji + gợi ý mờ; nút "Xem đáp án" lộ tên món, không ảnh hưởng xếp hạng (cập nhật 2026-10-27); ghép ra món ngay trên bàn lẩu là giải (không bàn thử thách, không đếm bước); thời gian giải = lúc server nhận − `batch_at`; bảng xếp hạng mẻ (ai nộp trước), tuần và tháng (số mẻ giải, rồi tổng thời gian); **streak**; chỉ tài khoản Google mới nộp; đồng hồ theo manifest thật | Bắt buộc | `docs/acceptance/daily.md` |
| AUTH | Đăng nhập bằng Google (thêm 2026-10-21) | Google Identity Services, Worker kiểm ID token (JWKS); chỉ lưu băm HMAC của `sub`, không email/tên; phiên cookie HttpOnly 90 ngày không dùng thì hết hạn; đăng xuất; xóa tài khoản; cùng tài khoản trên nhiều máy (không đồng bộ Đĩa) | Bắt buộc | `docs/acceptance/auth.md` |
| SYNC | Đĩa nhúng theo tài khoản (thêm 2026-10-24) | Gộp Đĩa của mọi phiên cùng tài khoản; server kiểm công thức trước khi ghi; không có nút xóa Đĩa ("Chơi lại từ đầu" bỏ 2026-10-24); (cập nhật 2026-10-26) tự tìm cặp cho món cũ không lưu cặp để gửi lên, kéo lại Đĩa khi quay lại tab | Bắt buộc | `docs/acceptance/sync.md` |
| DISC | Công thức gia truyền | UUID cục bộ + nickname tùy chọn (lọc từ cấm + bí danh); server kiểm công thức rồi ghi người đầu tiên; giới hạn tần suất theo UUID và IP băm | Bắt buộc | `docs/acceptance/disc.md` |
| SHARE | Thẻ chia sẻ | Thẻ Daily kiểu Wordle (chữ + PNG) và thẻ Công thức gia truyền; sao chép / chia sẻ hệ thống; không lộ đáp án | Bắt buộc | `docs/acceptance/share.md` |
| REPORT | Báo cáo + chặn nóng | Báo cáo phần tử và ảnh; 3 UUID khác nhau ⇒ tự ẩn; ảnh bị báo cáo về emoji; danh sách chặn nóng tải khi khởi động | Bắt buộc | `docs/acceptance/report.md` |
| ADMIN | Trang quản trị tối giản | Token; xem báo cáo, ẩn/hiện/chặn phần tử và công thức, nhật ký đợt + thống kê crawl; gán tier; duyệt đề xuất meme; audit mọi thao tác; danh sách "Bị chặn" (sửa tay, Bỏ chặn, Duyệt luôn, giữ 90 ngày); sửa mọi thuộc tính của meme trong "Nội dung" (cập nhật 2026-10-30) | Bắt buộc | `docs/acceptance/admin.md` |
| CONTRIB | Đóng góp meme (thêm 2026-10-23) | Đề xuất meme từ cặp có sẵn (chỉ tên bắt buộc); (cập nhật 2026-10-25) hai ô chọn phần tử trong Đĩa của người chơi, hoặc kéo món từ bàn/Đĩa vào ô; từ cấm + admin duyệt, không gửi LLM; hiện nickname người tạo; "Top cống hiến"; (cập nhật 2026-10-26) admin thấy "Chờ mẻ kế tiếp" trên meme đã duyệt chưa lên danh mục | Bắt buộc | `docs/acceptance/contrib.md` |
| TIER | Tier của meme (thêm 2026-10-23) | 5 bậc admin gán; màu nền + hình nhỏ giữa mép dưới; (cập nhật 2026-10-26) viền 1 px cùng màu cho thẻ và hình nhỏ, lúc thường không sáng; mặc định Xám; (cập nhật 2026-10-24) mặc định theo độ sâu, admin sửa được; Vàng/Đỏ phải có ảnh | Bắt buộc | `docs/acceptance/tier.md` |
| FEEDBACK | Ngon / Nhạt | 1 phiếu/UUID/công thức; pipeline hạ/ẩn công thức nhiều "Nhạt" | Tùy chọn | `docs/acceptance/feedback.md` |
| METRIC | Đo chỉ số thành công | Cloudflare Web Analytics + bảng sự kiện ẩn danh D1 (câu hỏi phạm vi 3: cần bảng sự kiện); tổng hợp D1/D7, Daily/ngày, chia sẻ, ghép trượt, "Nhạt", báo cáo | Bắt buộc | `docs/acceptance/metric.md` |
| PRIV | Chính sách quyền riêng tư | Trang chính sách; đồng ý trước khi gửi dữ liệu; IP chỉ lưu băm, xóa sau thời hạn ngắn; xem/xuất/xóa dữ liệu qua UUID | Bắt buộc | `docs/acceptance/priv.md` |
| QUIZ | mQuiz - đố meme theo phòng (thêm 2026-10-28) | Tạo phòng, chia link, phòng chờ trực tiếp, chủ phòng bắt đầu, đã bắt đầu thì không nhận thêm; mỗi câu chọn 2 trong 4 phần tử ghép ra meme đề (độ sâu 1-5, trừ Món đặc biệt mẻ hiện tại, khó dần); 5/10/15 câu, 10/20/30 s; đúng càng nhanh điểm càng cao; bảng điểm trực tiếp và chung cuộc; Durable Object + WebSocket; một người thì chơi offline; lịch sử ván nhiều người 90 ngày; giao diện kiểu game quiz: ô màu kèm ký hiệu, đồng hồ dạng thanh, phản hồi đúng/sai và chuỗi đúng, bảng điểm động, bục nhận giải, đếm người đã chốt, mã QR, âm thanh (cập nhật 2026-10-30) | Bắt buộc | `docs/acceptance/quiz.md` |
| INV | Bất biến nội dung và trò chơi | 12 thuộc tính phải đúng với mọi dữ liệu (ghép đối xứng, tới được, graph không lộ, idempotent…) | Bắt buộc | `docs/acceptance/inv.md` |

## 4. Luồng nghiệp vụ chính

### 4.1 Chơi ghép (GAME)
1. Thực khách mở trang. Client tải manifest (`version`, `batch_at`, Daily), graph phiên bản đó và danh sách chặn nóng.
2. Lần đầu: hiện hướng dẫn 1 màn hình; Đĩa nhúng có 4 phần tử khởi đầu (🌶️ Cay, 😂 Cười, 💀 Toang, ⏰ Deadline).
3. Thực khách thả 2 phần tử vào nồi (hoặc thả chồng lên nhau trên bàn).
4. Client tính khóa băm của cặp, tra graph trong bộ nhớ (< 50 ms), giải mã bằng 2 tên.
5. Có kết quả: hiệu ứng nồi sôi ≤ 1,2 s (chạm để bỏ qua), phần tử mới vào Đĩa, lưu cục bộ. Nếu chưa ai khám phá và người chơi đã đồng ý gửi dữ liệu → luồng 4.3.
6. Không có kết quả: hiện câu "Nồi trào" cố định theo cặp; trượt 3 lần liên tiếp thì lần thứ 3 hiện gợi ý một cặp nên thử "Thử A + B xem" thay cho câu Nồi trào, thẻ A và B nháy sáng tới khi ghép cặp kế tiếp, đổi màn hình hoặc tải lại trang (AC-GAME-06, cập nhật 2026-10-30).
- Ngoại lệ: phần tử/công thức trong danh sách chặn → coi như không có; graph tải lỗi → thông báo `role="alert"` và nút thử lại, tiến độ cục bộ không mất.

### 4.2 Món đặc biệt hôm nay (DAILY)
1. Mỗi mẻ (00:00 và 12:00 GMT+7, theo giờ chạy thật) pipeline chọn 1 món, ghi vào manifest: emoji, gợi ý mờ, khóa băm của tên và tên món; thẻ hiện "???" cho tới khi giải hoặc thực khách bấm "Xem đáp án" (AC-DAILY-20, cập nhật 2026-10-27). Nếu admin đã chỉ định món cho mẻ kế tiếp (AC-DAILY-19, ADR 0019) thì mẻ dùng món và gợi ý đó thay cho lựa chọn tự động; chỉ áp cho một mẻ.
2. Thực khách ghép trên bàn lẩu như thường (cập nhật 2026-10-21: bỏ bàn thử thách và đếm bước). Lượt ghép ra đúng món đích là giải: tên lộ ra.
3. Đã đăng nhập Google thì client gửi cặp vừa ghép lên server; chưa đăng nhập thì thẻ mời đăng nhập, đăng nhập xong tự gửi.
4. Server kiểm cặp là công thức có thật ra món đích → ghi kết quả với `solved_at` = lúc nhận, cập nhật streak, trả hạng.
5. Thực khách xem bảng xếp hạng mẻ, tuần, tháng, streak ở tab "Bảng xếp hạng" riêng (AC-DAILY-17), tạo thẻ chia sẻ (SHARE).
- Ngoại lệ: mẻ đã qua → không nhận kết quả; cron trễ → đồng hồ hiện "Mẻ mới sắp lên" thay vì số âm.

### 4.3 Công thức gia truyền (DISC)
1. Thực khách ghép ra phần tử chưa có người khám phá (client biết qua `GET` khám phá của phần tử).
2. Client gửi `(uuid, a, b, result)`.
3. Server kiểm công thức có trong nội dung đang hoạt động; ghi người đầu tiên (ràng buộc duy nhất theo phần tử).
4. Mọi người thấy "Công thức gia truyền của <nickname>" trên phần tử đó; người đầu tiên được mời tạo thẻ chia sẻ.
- Ngoại lệ: công thức giả → 422; đã có người → trả người hiện có; vượt tần suất → 429.

### 4.4 Mẻ nhúng mới (PIPE + MOD + ART)
- Giai đoạn 1 (chế độ lõi): chọn Món đặc biệt → xuất graph + manifest → deploy → báo cáo đợt.
- Giai đoạn 2 (đầy đủ): crawl → khử trùng → kiểm duyệt 2 lớp → liên kết ngược → công thức bổ sung → giám khảo → vẽ minh họa (tối đa 20 ảnh/đợt, tải lên R2 qua Worker trước khi đăng; lỗi vẽ không làm hỏng mẻ, phần tử chờ vẽ đợt sau - AC-ART-09/10, cập nhật 2026-10-21) → chọn Món đặc biệt → xuất graph + manifest (giữ 14 bản) → deploy → báo cáo đợt qua GitHub Issue.
- Ngoại lệ: lỗi ở bất kỳ bước nào trước deploy → không đăng gì, bản cũ giữ nguyên; hết quota Gemini → dừng êm, đăng phần đã xong và qua kiểm duyệt, phần còn lại vào hàng chờ.
- (cập nhật 2026-10-30) Gọi Gemini theo lô 10 khái niệm (giữ như cũ, đính chính 2026-10-30), câu trả lời lỗi thì chia đôi lô. Khái niệm bị kiểm duyệt chặn được lưu vào danh sách "Bị chặn" (mọi lý do, giữ 90 ngày); admin sửa tay rồi "Bỏ chặn" (mẻ sau đi tiếp ghép/chấm, không kiểm duyệt lại) hoặc "Duyệt luôn" (như duyệt đề xuất meme, không gọi Gemini). Admin sửa được mọi thuộc tính của meme đang có, hiệu lực từ mẻ kế tiếp, pipeline không ghi đè.

### 4.5 Phanh khẩn cấp (REPORT + ADMIN + GRAPH)
1. Thực khách báo cáo phần tử (chọn lý do) hoặc ảnh.
2. Ảnh: 1 báo cáo → ảnh vào danh sách chặn, client về emoji. Phần tử: đủ 3 UUID khác nhau → tự ẩn ngay.
3. Quản trị xem báo cáo trên trang admin, ẩn/hiện/chặn phần tử hoặc công thức; có hiệu lực ≤ 60 s, không cần deploy.
4. Lỗi toàn đợt → quản trị chạy workflow rollback về bản graph trước.
- Mục tiêu: khôi phục trong 5 phút.

### 4.6 Đóng góp meme (CONTRIB + ADMIN + TIER) (thêm 2026-10-23)
1. Thực khách đã đăng nhập chọn 2 phần tử có sẵn trong Đĩa của mình (gõ để lọc hoặc kéo thả vào ô), nhập tên (bắt buộc), biểu tượng, mô tả, link ảnh rồi gửi; Worker lọc từ cấm + bí danh, lưu "Chờ duyệt".
2. Quản trị xem đề xuất, sửa thông tin, viết gợi ý ảnh, chọn tier, rồi duyệt hoặc từ chối (có lý do); mọi thao tác vào audit. (cập nhật 2026-10-26) Duyệt xong trang báo meme lên danh mục ở mẻ kế tiếp; dòng đã duyệt ghi "Chờ mẻ kế tiếp" tới khi phần tử có trong danh mục (AC-CONTRIB-14).
3. Mẻ kế tiếp đưa phần tử đã duyệt và công thức của nó vào graph; mẻ `full` vẽ ảnh từ gợi ý của quản trị.
4. Người chơi ghép ra phần tử thấy "Meme của <nickname>" khi rê chuột/chạm giữ; người tạo lên "Top cống hiến".

### 4.7 mQuiz - đố meme theo phòng (QUIZ) (thêm 2026-10-28)
1. Thực khách (đã đồng ý gửi dữ liệu) mở tab "mQuiz", chọn số câu và số giây, bấm "Tạo phòng"; server trả mã 6 ký tự và link `/lau-meme/quiz/<mã>`; thực khách sao chép/chia sẻ link.
2. Người nhận link nhập nickname, vào phòng chờ; mọi người thấy danh sách người chơi cập nhật trực tiếp (WebSocket tới Durable Object của phòng).
3. Chủ phòng bấm "Bắt đầu". Server sinh đề từ nội dung đang chạy (hàm thuần, có seed), phát từng câu: meme đề + 4 lựa chọn, hạn nộp theo đồng hồ server. Phòng không nhận thêm người.
4. Người chơi chọn 2 ô, bấm "Chốt" (1 lần/câu). Hết giờ hoặc mọi người đã nộp: server lộ cặp đúng, điểm câu, bảng điểm tổng; nghỉ 4 s rồi sang câu sau.
5. Hết câu cuối: bảng xếp hạng chung cuộc; server ghi lịch sử ván vào D1; chủ phòng có thể "Chơi lại" (về phòng chờ, đề mới).
6. Chỉ một người bấm "Bắt đầu": nhận cả gói đề (đáp án dạng băm), chơi offline trên máy, không vào lịch sử.
- Ngoại lệ: rớt mạng thì vào lại bằng cùng UUID, giữ điểm, câu bỏ lỡ 0 điểm; người mới vào khi đang chơi bị từ chối; phòng không ai kết nối 5 phút thì hủy, ván dở không lưu; pool không đủ 5 câu thì không bắt đầu.
- (cập nhật 2026-10-30) Giao diện kiểu game quiz: ô màu kèm ký hiệu ▲ ◆ ● ■, đồng hồ dạng thanh (5 s cuối gấp, rung), "3/5 người đã chốt", dải "Chuẩn! +750" và chuỗi 🔥, bảng điểm có mũi tên đổi hạng, bục nhận giải, mã QR phòng chờ, âm thanh Web Audio có nút tắt; tôn trọng giảm chuyển động (AC-QUIZ-29..39).

## 5. Dữ liệu

### 5.1 Thực thể chính
| Thực thể | Thuộc tính quan trọng | Ghi chú |
|---|---|---|
| Phần tử (element) | id, tên, tên chuẩn hóa (`fold`), emoji, nguồn (Việt/Quốc tế; lõi/crawl/đóng góp), depth, gợi ý ảnh, khóa ảnh, mẻ thêm vào, trạng thái (hoạt động/ẩn/chặn), cờ hoãn nóng đến ngày; tier 1-5, `trend_peak`, tài khoản người tạo (đóng góp) - cập nhật 2026-10-23 | Tên chuẩn hóa duy nhất; emoji duy nhất |
| Công thức (recipe) | cặp (a, b) không thứ tự, kết quả, điểm hài, mẻ thêm vào, trạng thái | Mỗi cặp tối đa 1 kết quả |
| Câu Nồi trào (miss line) | id, nội dung | 40 câu lõi |
| Mẻ (batch) | version, `batch_at` thật, chế độ (lõi/đầy đủ), trạng thái, số thêm/chặn/lỗi nguồn, quota dùng | Manifest + graph theo version; giữ 14 bản |
| Món đặc biệt (daily) | version mẻ, phần tử đích, gợi ý | Mỗi mẻ 1 món |
| Kết quả Daily | version mẻ, tài khoản, cặp đã ghép, `solved_at` (thời điểm server nhận), thời gian giải | 1 kết quả/tài khoản/mẻ |
| Tài khoản (account) | băm HMAC của `sub` Google, nickname, thời điểm tạo; các UUID đã gắn | Không email, không tên Google |
| Phiên (session) | băm mã phiên, tài khoản, thời điểm tạo/dùng gần nhất/hết hạn | Thu hồi khi đăng xuất hoặc xóa tài khoản |
| Đĩa của tài khoản (thêm 2026-10-24) | tài khoản, phần tử, cặp đã dùng để ghép ra, thời điểm server nhận lần đầu | 1 dòng/tài khoản/phần tử; xóa cùng tài khoản (AC-SYNC-10) |
| Thực khách (player) | UUID, nickname (tùy chọn), thời điểm tạo | Không có email/mật khẩu |
| Khám phá (discovery) | phần tử, player, công thức đã dùng, thời điểm | Duy nhất theo phần tử |
| Báo cáo (report) | đích (phần tử/ảnh), player, lý do, thời điểm, trạng thái xử lý | Duy nhất theo (đích, player) |
| Danh sách chặn | loại (phần tử/công thức/ảnh), định danh, lý do (tự ẩn/admin), thời điểm | Client tải khi khởi động |
| Bí danh bị chặn (alias) | chuỗi chuẩn hóa, nguồn (MOD/admin) | Áp cho phần tử mới và nickname |
| Phiếu Ngon/Nhạt | công thức, player, giá trị | Tùy chọn (FEEDBACK) |
| Sự kiện (event) | loại, player, thời điểm, thuộc tính nhỏ (loại thẻ…) | Không có IP, không có user agent đầy đủ |
| Đồng ý (consent) | player, mục đích, version chính sách, thời điểm, IP băm, kênh | Append-only |
| Đề xuất meme (contribution) (thêm 2026-10-23) | cặp phần tử cha, tên, biểu tượng, mô tả, link ảnh, tài khoản, trạng thái (chờ/duyệt/từ chối), lý do, gợi ý ảnh của admin, thời điểm | Tối đa 1 đề xuất chờ duyệt/tài khoản/cặp |
| Phòng mQuiz (thêm 2026-10-28) | mã, cấu hình (số câu, số giây), chủ phòng, người chơi (UUID, nickname), trạng thái, đề và câu trả lời của ván đang chơi | Chỉ nằm trong storage của Durable Object; xóa khi phòng hủy |
| Ván mQuiz (thêm 2026-10-28) | mã phòng, số thứ tự ván, version nội dung, số câu, số giây, bắt đầu, kết thúc | Chỉ ván nhiều người đã xong; giữ 90 ngày |
| Người chơi trong ván mQuiz (thêm 2026-10-28) | ván, UUID, nickname lúc chơi, tổng điểm, số câu đúng, hạng | Không lưu từng câu trả lời; xóa dữ liệu thì bỏ UUID, đổi tên "Thực khách ẩn danh" |
| Audit quản trị | thao tác, đích, trước/sau, thời điểm, dấu vân token | Append-only |
| Hàng chờ meme (pipeline) | khái niệm, nguồn, số lần thử, lần thử gần nhất | Nằm ở kho pipeline |

### 5.2 Dữ liệu cá nhân
Phân loại theo Luật BVDLCN 2025 + NĐ 356/2025: chỉ có **dữ liệu cá nhân cơ bản** (định danh trực tuyến). Không thu dữ liệu nhạy cảm; trò chơi không thu tuổi (vấn đề trẻ em: câu hỏi mở).

| Trường | Loại (cơ bản/nhạy cảm) | Mục đích xử lý | Thời gian lưu | Biện pháp bảo vệ |
|---|---|---|---|---|
| UUID thực khách | Cơ bản (định danh trực tuyến) | Ghi khám phá, kết quả Daily, streak, báo cáo, phiếu, đo chỉ số | Đến khi thực khách xóa | Không hiển thị công khai; mask trong log; xóa theo yêu cầu (AC-PRIV) |
| Mã tài khoản Google (băm HMAC của `sub`) | Cơ bản (định danh trực tuyến) | Định danh trên bảng xếp hạng, gộp kết quả/streak qua nhiều máy | Đến khi thực khách xóa tài khoản | Không lưu `sub` thô, email, tên; khóa HMAC trong secret; không ghi vào log |
| Đĩa nhúng của tài khoản (thêm 2026-10-24) | Cơ bản (gắn tài khoản) | Chơi tiếp trên nhiều máy | Đến khi xóa tài khoản |
| Nickname | Cơ bản | Hiển thị trên bảng xếp hạng và Công thức gia truyền | Đến khi thực khách đổi/xóa | Lọc từ cấm + bí danh; đồng ý trước khi lưu |
| IP | Cơ bản | Giới hạn tần suất, chống gian lận | Chỉ lưu dạng băm HMAC (khóa trong secret); xóa sau 7 ngày | Không lưu IP thô; không ghi IP vào log |
| Sự kiện chơi | Cơ bản (gắn UUID) | Đo D1/D7, chia sẻ, ghép trượt | 90 ngày | Không IP, không user agent; xóa theo UUID khi thực khách xóa dữ liệu |
| Đề xuất meme (thêm 2026-10-23) | Cơ bản (gắn tài khoản) | Duyệt meme, ghi công người tạo, "Top cống hiến" | Chờ duyệt: đến khi duyệt/từ chối hoặc xóa tài khoản; đã duyệt: phần tử ở lại game, bỏ gắn tài khoản khi xóa tài khoản | Không gửi LLM; admin không thấy mã tài khoản; có trong xuất dữ liệu |
| Lịch sử mQuiz (thêm 2026-10-28) | Cơ bản (gắn UUID) | Xem lại kết quả ván, bảng chung cuộc cho người có link phòng | 90 ngày | Không trả UUID qua link phòng; có trong xem/xuất; xóa dữ liệu thì ẩn danh hóa (AC-QUIZ-22) |
| Bằng chứng đồng ý | Cơ bản | Chứng minh đồng ý | Theo vòng đời player + 1 năm sau khi xóa (mặc định - câu hỏi mở) | Append-only |

- **Không gửi dữ liệu người chơi cho LLM** hay bất kỳ dịch vụ bên thứ ba nào. Gemini và Workers AI chỉ nhận dữ liệu meme công khai ⇒ không phát sinh chuyển dữ liệu cá nhân ra nước ngoài.
- Không dùng cookie theo dõi; Cloudflare Web Analytics không cookie. Cookie phiên đăng nhập (AUTH) là cookie cần thiết, chỉ đặt sau khi thực khách bấm đăng nhập.
- Đăng nhập Google: Google biết tài khoản đã đăng nhập vào game (bản chất của đăng nhập bên thứ ba); game không nhận email/tên từ Google ngoài ID token dùng một lần để kiểm. Trang chính sách phải nêu điều này (AC-AUTH-06).

## 6. Tích hợp bên ngoài
| Hệ thống | Chiều | Phương thức | Tần suất | Xử lý khi lỗi |
|---|---|---|---|---|
| Reddit API | Vào (pipeline) | REST, OAuth app token | Mỗi mẻ (giai đoạn 2) | Bỏ nguồn đó, ghi lỗi nguồn vào báo cáo đợt |
| Know Your Meme | Vào | HTTP, tôn trọng robots.txt | Mỗi mẻ | Như trên |
| Google Trends VN | Vào | RSS/HTTP | Mỗi mẻ | Như trên |
| YouTube trending | Vào | YouTube Data API (key) | Mỗi mẻ | Như trên |
| Threads (thêm 2026-10-23, cập nhật 2026-10-24) | Vào | API chính thức của Meta `graph.threads.com`, tìm theo từ khóa (token trong GitHub Secret, cần Meta duyệt app); token 60 ngày tự gia hạn mỗi tuần (AC-PIPE-19) | Mỗi mẻ; gia hạn token mỗi thứ Hai | Như trên; không lưu tên người đăng; trả 0 bài thì cảnh báo trong báo cáo đợt (AC-PIPE-20); gia hạn lỗi thì mở Issue |
| Tuổi Trẻ `tuoitre.vn/meme.html` (thêm 2026-10-23) | Vào | Đọc HTML trang chuyên mục, theo robots.txt | Mỗi mẻ | Như trên |
| RSS trang giải trí Việt | Vào | RSS | Mỗi mẻ | Như trên |
| Gemini API (free tier) | Ra (dữ liệu meme công khai) | REST, gom lô | Mỗi mẻ | Retry backoff; hết quota → dừng êm, phần còn lại vào hàng chờ |
| Cloudflare Workers AI (FLUX.1 schnell) | Ra | Binding/REST | Mỗi mẻ (giai đoạn 2) | Hết hạn mức → emoji, vẽ bù đợt sau |
| Cloudflare R2 | Ra | Binding/S3 API | Mỗi mẻ (ghi), mỗi lượt xem (đọc) | Không đọc được → client giữ emoji |
| Cloudflare D1 + deploy | Ra | Wrangler/REST (token trong GitHub Secrets) | Mỗi mẻ | Deploy lỗi → bản cũ giữ nguyên |
| GitHub Issues | Ra | REST (`GITHUB_TOKEN`) | Mỗi mẻ | Ghi log workflow, không làm hỏng đợt |
| Cloudflare Web Analytics | Ra (beacon, không cookie) | Script | Mỗi lượt tải trang | Bỏ qua |
| Cloudflare Durable Objects (thêm 2026-10-28) | Nội bộ (Worker → DO phòng mQuiz) | Binding + WebSocket Hibernation, SQLite storage, alarm | Mỗi phòng mQuiz | Hết hạn mức gói Free ⇒ tạo/vào phòng báo lỗi, phần còn lại của game không ảnh hưởng |

## 7. Yêu cầu phi chức năng
Stack là Cloudflare Worker + D1 + Python pipeline (không Docker/Postgres), nên các dòng mặc định về container, `pg_dump`, JWT, RLS không áp dụng. Chỉ ghi khác biệt:

| Nhóm | Yêu cầu | Kiểm chứng bằng |
|---|---|---|
| Hiệu năng | Ghép < 50 ms (tra trong bộ nhớ, không gọi mạng); API đọc p95 < 300 ms, API ghi p95 < 800 ms; tải trang đầu < 2 s trên 4G | AC-GAME-14 (benchmark); smoke `/dk:ship`; Lighthouse thủ công trước go-live |
| Tải | ≤ 50 người đồng thời lúc thường; đột biến khi viral do Cloudflare biên gánh (manifest/graph/ảnh cache được) | Thiết kế: graph và ảnh là file tĩnh bất biến |
| Thời gian thực (thêm 2026-10-28) | mQuiz: ≤ 50 người/phòng; tin phát tới mọi người trong phòng ≤ 1 s; thời gian trả lời đo bằng đồng hồ server | AC-QUIZ-04/10/12; thử tay 2-3 điện thoại trên staging |
| Nội dung | Ghép trượt khi chơi ngẫu nhiên (mô phỏng): 20 lượt đầu ≤ 45 %, cả ván 100 lượt ≤ 70 % | AC-INV-12 (mô phỏng có seed cố định) |
| Pipeline | Một đợt < 15 phút; nằm trong quota Gemini free | `timeout-minutes: 15` trong workflow; báo cáo đợt ghi quota |
| Khả dụng | Best-effort 99 %; health check `/api/health` | `/dk:ship` |
| Sao lưu / khôi phục | Nội dung tái tạo được từ kho pipeline + 14 bản graph; D1 dùng Time Travel (quyết định của người); khôi phục ≤ 5 phút bằng ẩn nóng hoặc rollback | AC-GRAPH-05/06, AC-REPORT-04, AC-ADMIN-03 |
| Bảo mật | Giới hạn tần suất mọi endpoint ghi; validate đầu vào; lỗi RFC 9457 problem+json; CORS chỉ domain game; token admin chỉ trong Cloudflare secret, so sánh hằng thời gian; bí mật chỉ ở GitHub Secrets / Cloudflare secrets (repo public); SQL chỉ qua `prepare().bind()` | Test AC; gitleaks + lint trong CI |
| Phân quyền | Không RBAC/tenant; 3 chủ thể: thực khách (UUID), quản trị (token), pipeline (token) | AC-ADMIN-01 |
| Audit | Ghi mọi thao tác quản trị (trước/sau); lưu 12 tháng | AC-ADMIN-09 |
| Dữ liệu cá nhân | Như 5.2: IP băm 7 ngày, sự kiện 90 ngày, xem/xuất/xóa theo UUID, đồng ý trước khi gửi dữ liệu | AC-PRIV |
| Quan sát | Log JSON không chứa UUID thô, IP, nickname; báo cáo đợt qua GitHub Issue | AC-PRIV-07, AC-PIPE-14 |
| Khả năng bảo trì | Pipeline: logic thuần (không mạng/đồng hồ/ngẫu nhiên), adapter mạng tách riêng và mock trong test; độ phủ theo cấu hình CI | `pytest`, `vitest` coverage trong CI |
| Tương thích | Màn hình ≥ 375 px; Chrome/Safari di động và Chrome/Edge/Safari máy tính 2 bản gần nhất; chuột + cảm ứng (Pointer Events) | Kiểm thủ công trên 2–3 điện thoại trước go-live; Playwright đo bố cục ở 5 khung nhìn (AC-GAME-18) |
| Ngôn ngữ | Chỉ tiếng Việt; tìm kiếm không dấu | AC-GAME-07 |
| Chi phí | Vận hành $0 (không tính domain) | Chỉ dùng gói free: Workers, D1, R2, Workers AI, Durable Objects SQLite (100 000 request/ngày, tin WebSocket tính 20:1 - thêm 2026-10-28), Gemini free, GitHub Actions (repo public) |

## 8. Giả định và ràng buộc
- Một người làm (Thuc), ~20 giờ/tuần; không báo giá; go-live sớm nhất, không beta kín. Giảm rủi ro bằng chạy mẻ thật trên staging vài ngày và kiểm thủ công trên 2–3 điện thoại.
- Repo public ⇒ mọi bí mật (token admin, khóa HMAC IP, khóa Gemini, Reddit, YouTube, Cloudflare API) chỉ ở GitHub Secrets / Cloudflare secrets.
- Nội dung lõi: `noi-dung-loi.json` là nguồn chuẩn; sửa qua `noi_dung.py` rồi sinh lại, không sửa tay.
- Lõi có 40 phần tử độ sâu 4–8 ⇒ ở nhịp 2 món/ngày, giai đoạn 1 dùng hết món chưa lặp sau ~20 ngày (cách lặp: câu hỏi mở).
- Cron GitHub Actions có thể trễ ⇒ mọi thứ phụ thuộc giờ mẻ dùng `batch_at` thật trong manifest.
- Hạn mức Workers AI **cần kiểm tra** trước giai đoạn 2. R2 đã bật ngày 2026-10-21, không bị đòi thẻ thanh toán (câu hỏi mở 13, `docs/dev/huong-dan-tai-khoan.md` mục 6).
- Graph mã hóa chống đọc trộm cả cây, **không** chống dò thử từng cặp - chấp nhận.
- mQuiz (thêm 2026-10-28): chấp nhận mỗi câu lộ một công thức cho cả phòng (AC-INV-04 vẫn giữ: graph không đổi); ván một mình có đáp án băm trên máy nên người cố tình vẫn dò được - chấp nhận vì không vào lịch sử hay bảng xếp hạng nào. Ước tính một phòng 10 người × 10 câu ≈ 35 request Durable Objects ⇒ gói Free đủ ~2 500 phòng/ngày (kiểm lại khi viết ADR).
- Bảng xếp hạng chỉ nhận tài khoản Google ⇒ khó tạo nhiều danh tính hơn; vẫn chấp nhận gian lận kiểu chia sẻ đáp án (ai biết cặp ra món thì nộp được ngay). Công thức gia truyền vẫn theo UUID ẩn danh.

## 9. Lịch sử thay đổi
| Ngày | Phiên bản | Nội dung | Người duyệt |
|---|---|---|---|
| 2026-10-19 | 0.1 | Bản đầu từ phạm vi đã chốt (14 tính năng + bất biến); chia giai đoạn 1/2; thêm streak, bảng sự kiện D1 | - |
| 2026-10-20 | 0.2 | AC-PIPE-08: thêm hạn mức 150 cặp/đợt chọn theo mức hay cùng nằm trên Đĩa (giảm ghép trượt, mô phỏng: +200 cặp đúng chỗ kéo 20 lượt đầu từ 41,5 % xuống 28 %); AC-ART-01 đổi phong cách sticker sang vẽ tay; thêm AC-ART-08 phóng lớn ảnh khi ghép ra món lần đầu | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-21 | 0.4 | Thêm AC-DAILY-14: bấm món trên bàn thử thách thì đặt vào nồi lẩu, nồi sôi và câu Nồi trào như bàn lẩu (lần trượt liên tiếp vẫn thấy rõ); món thử thách không ghép lẫn với món Đĩa. (0.3 nằm ở PR #24) | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-21 | 0.5 | DAILY: bỏ bàn thử thách và đếm bước, ghép ra món trên bàn lẩu là giải; xếp hạng mẻ theo thời điểm server nhận; thêm bảng tuần/tháng lịch GMT+7 (số mẻ giải, rồi tổng thời gian); chỉ tài khoản Google nộp được. Thêm AUTH (đăng nhập Google, chỉ băm `sub`). SHARE thẻ Daily hiện thời gian giải thay số bước. INV-11 theo cặp đã ghép. AC-GAME-18 nồi lẩu trong màn hình đầu tiên | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-21 | 0.6 | ART: thêm AC-ART-09 (mẻ full vẽ ảnh: 20 ảnh/đợt, kiểm đúng byte WebP, tải lên trước khi đăng, ngân sách 8 phút, báo cáo đợt) và AC-ART-10 (thiếu cấu hình, lỗi 401/403/404, lỗi tạm thời 3 đợt thì về emoji) theo ADR 0012 đã chấp nhận; không đổi hành vi đã làm | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-22 | 0.7 | Góp ý giao diện sau staging: AC-GAME-19 (Dọn bàn, Chơi lại từ đầu, ? vào khu bàn lẩu; đăng nhập lên đầu trang), AC-GAME-20 (lửa không bị cắt, quai ngang thân nồi), AC-GAME-21 (vuốt chỗ trống để cuộn trên điện thoại, gợi ý lần đầu), AC-DAILY-16 (thẻ thử thách nổi bật), AC-DAILY-17 (bảng xếp hạng ở tab riêng, huy chương top 3, tô dòng của mình) | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-22 | 0.8 | AC-GAME-20 làm rõ: lỗi lửa là ngọn ngoài cùng bên phải bị cắt ngang, không phải bị cắt chiều cao; hàng lửa chỉ vẽ ngọn trọn vẹn | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-22 | 0.9 | SEED: lõi classic tăng lên 174 phần tử / 518 công thức (thêm 35 meme, PR #58; câu hỏi mở 40); cập nhật con số trong AC-SEED-01 và AC-GAME | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-23 | 1.0 | Câu hỏi mở 41-48: DAILY chọn món theo mặn (trending, `trend_peak`) rồi mới, không trùng 30 mẻ gần nhất, pool gồm 59 món lõi có `daily_hint` (AC-DAILY-01, 12, 18); PIPE: staging mỗi 2 tiếng, lịch mẻ trong manifest, nguồn Tuổi Trẻ, ghi mức trending (AC-PIPE-02, 15, 16), nguồn Threads qua API chính thức (AC-PIPE-17; câu hỏi mở 47, 49, 55 đã chốt); ART vẽ bù lõi (AC-ART-11); ADMIN thống kê crawl, gán tier (AC-ADMIN-11, 12); thêm CONTRIB (đóng góp meme, Top cống hiến) và TIER | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-24 | 1.1 | Threads sau khi lấy token: AC-PIPE-18 (host `graph.threads.com`), AC-PIPE-19 (tự gia hạn token mỗi tuần, ghi lại GitHub Secret), AC-PIPE-20 (cảnh báo 0 bài khi app chưa được duyệt); AC-SUBPATH-13 (trang `/chinh-sach` trả về cho mọi GET để Meta duyệt URL chính sách); câu hỏi mở 65-66 | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-24 | 1.2 | Góp ý UI/gameplay: tính năng mới SYNC (Đĩa nhúng theo tài khoản, AC-SYNC-01..10; AC-AUTH-04/06 cập nhật); TIER mặc định theo độ sâu, admin sửa được, Vàng/Đỏ phải có ảnh, hình nhỏ đè lên viền dưới (AC-TIER-01/02 cập nhật, AC-TIER-04/05, AC-ADMIN-12 cập nhật); GAME: bàn cao hơn (AC-GAME-18 cập nhật), vùng cấm đặt món, Đĩa cao bằng bàn, bấm là vào nồi, hiệu ứng và âm thanh Vàng/Đỏ, giao diện mới (AC-GAME-22..27); ART ưu tiên vẽ món Vàng/Đỏ, admin tải tranh vẽ tay (AC-ART-12/13); câu hỏi mở 67-74 | nguyenquythuc (chưa duyệt) |
| 2026-10-24 | 1.3 | Câu hỏi mở 67-70, 72-75 chốt theo mặc định (ngưỡng tier, Vàng/Đỏ chưa có ảnh, giới hạn ghi Đĩa, tranh vẽ tay, chiều cao bàn, âm thanh, hiệu ứng lặp lại, chỉ gộp Đĩa khi đăng nhập Google); câu 71: bỏ hẳn nút "Chơi lại từ đầu" (AC-GAME-11, AC-GAME-19, AC-GAME-22, AC-SYNC-07 cập nhật) | nguyenquythuc (chưa duyệt) |
| 2026-10-25 | 1.4 | ART: AC-ART-13 (admin tải PNG/WebP ≤ 1 MB cho phần tử, chuẩn hóa WebP 256×256 trên trình duyệt, mẻ sau không vẽ đè, audit `set_image`); AC-ART-14 (khi duyệt đề xuất, admin chọn "Dùng link làm ảnh"; mẻ `full` tải link có chặn SSRF, không vẽ bằng Workers AI; báo cáo "Link ảnh lỗi: N"); câu hỏi mở 46 đổi theo chủ dự án; ADR 0016, 0018; contract 0.6.0; triển khai staging ngày 2026-10-25 | nguyenquythuc (chưa duyệt) |
| 2026-10-26 | 1.5 | Góp ý giao diện 2026-10-25: viền thẻ 1 px `--color-chip-ring` dùng chung, lúc thường không sáng (AC-TIER-02 cập nhật); món bóng theo con trỏ (AC-GAME-02 cập nhật); chọn hai phần tử bằng ô chọn trong Đĩa hoặc kéo thả (AC-CONTRIB-13); câu hỏi mở 79-82 đã chốt | nguyenquythuc (chưa duyệt) |
| 2026-10-26 | 1.6 | Chỉ định Món đặc biệt (AC-DAILY-19, ADR 0019): admin chọn một món đang hoạt động và gợi ý cho đúng một mẻ kế tiếp (tab "Món đặc biệt"); mẻ không thành công thì chỉ định còn nguyên. AC-INV-10 miễn điều kiện độ sâu 4-8 cho món được chỉ định. Dọn dữ liệu hằng ngày giữ 12 tháng cho `admin_change`, `admin_image_change` và `daily_pin_change` (cùng `admin_audit`) | - |
| 2026-10-26 | 1.7 | Góp ý "chưa thấy đĩa được đồng bộ giữa các phiên": AC-SYNC-03 cập nhật (món cục bộ ghép trước khi có SYNC, không lưu cặp, được client tự tìm cặp từ Đĩa cục bộ rồi gửi lên mỗi lần tải trang); AC-SYNC-11 mới (tab hiện lại sau ≥ 30 s từ lần kéo trước thì kéo và gộp Đĩa của tài khoản, không tải lại trang); không đổi contract | - |
| 2026-10-26 | 1.8 | Góp ý "duyệt meme 'chia hành lý' xong không thấy hiển thị trong mục nội dung": AC-CONTRIB-14 mới (thông báo sau khi duyệt, nhãn "Chờ mẻ kế tiếp" tới khi phần tử có trong danh mục; duyệt vẫn chỉ ghi D1 theo ADR 0013); contract thêm trường `in_catalog` vào `AdminContribution`; câu hỏi mở 84 | - |
| 2026-10-27 | 1.9 | Góp ý "game khó, bắt đầu từ gợi ý càng khó": AC-DAILY-20 mới (nút "Xem đáp án" trên thẻ Món đặc biệt, có hộp xác nhận, chỉ lộ tên món; xem rồi ghép ra vẫn tính giải, xếp hạng, streak); AC-DAILY-03 cập nhật (manifest có tên món, thẻ vẫn hiện "???" tới khi giải hoặc bấm xem); câu hỏi mở 86 | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-28 | 2.0 | (cập nhật: câu hỏi mở 88, 89, 90, 91 theo mặc định; 92 hủy phòng sau 5 phút không ai kết nối) Thêm QUIZ (mQuiz - đố meme theo phòng, AC-QUIZ-01..28): phòng qua link, phòng chờ trực tiếp, chọn 2 trong 4 phần tử ghép ra meme đề, điểm theo thời gian trả lời đúng đo ở server, bảng điểm trực tiếp và chung cuộc, chơi một mình offline, lịch sử ván nhiều người 90 ngày; bỏ "chơi với bạn bè thời gian thực" khỏi Ngoài phạm vi; Durable Objects vào tích hợp và chi phí; câu hỏi mở 87-92 | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-28 | 2.1 | Bỏ AC-QUIZ-27 (đo chỉ số mQuiz qua bảng `event`): CHECK của bảng chỉ nhận 7 loại sự kiện, đổi phải dựng lại bảng; câu hỏi mở 93; contract 0.10.1 | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-30 | 2.2 | Góp ý 2026-10-30: PIPE lô Gemini 10 → 30, chia đôi khi lỗi (AC-PIPE-12 cập nhật) để đỡ hết quota; khái niệm bị chặn được lưu kèm mọi lý do (AC-MOD-11); admin có danh sách "Bị chặn", sửa tay, Bỏ chặn (mẻ sau không kiểm duyệt lại, AC-PIPE-21), Duyệt luôn, giữ 90 ngày (AC-ADMIN-13..15, 17); sửa mọi thuộc tính của meme trong "Nội dung" (AC-ADMIN-16). QUIZ giao diện kiểu game quiz (AC-QUIZ-29..39). Câu hỏi mở 94-101 | - |
| 2026-10-30 | 2.3 | Góp ý 2026-10-30 "những nội dung lọt qua kiểm duyệt nhưng không phải meme": chặn "không phải meme" ở lớp 1 theo dấu hiệu tiêu đề (AC-MOD-12: livestream, ngày tháng, giải đấu, hơn 10 từ) và lớp 2 bằng danh mục LLM `not_meme` (AC-MOD-13: tên người/đội/bài hát/sự kiện đứng một mình); vào danh sách "Bị chặn", Bỏ chặn được; không đổi contract; câu hỏi mở 102 | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-30 | 2.4 | Góp ý 2026-10-30 "tỉ lệ ghép không ra meme cao quá": AC-GAME-06 cập nhật - trượt 3 lần liên tiếp thì gợi ý cả cặp "Thử A + B xem" (không lộ kết quả), thẻ A và B nháy sáng nhẹ, chậm trên bàn và trong Đĩa tới khi ghép cặp bất kỳ, sang màn hình khác hoặc tải lại trang; giảm chuyển động thì viền tĩnh; chỉ bàn lẩu chính; câu hỏi mở 103 | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-30 | 2.5 | Chốt khi build: lần trượt thứ 1, 2 hiện câu Nồi trào; lần thứ 3 hiện gợi ý cặp ngay chỗ đó thay cho câu Nồi trào (không có cặp hợp lệ thì vẫn hiện câu); gợi ý không tự ẩn theo thời gian (AC-GAME-05, AC-GAME-06, câu hỏi mở 103) | nguyenquythuc (chờ /dk:approve spec) |
| 2026-10-30 | 2.6 | Đính chính: lô Gemini mặc định vẫn là 10 như code (`batch_size=10`, `LLM_SLICE = 10`), không đổi lên 30; 30 chỉ là kích thước cấu hình trong ví dụ của AC-PIPE-12; chia đôi khi lỗi giữ nguyên (câu hỏi mở 97). Contract 0.11.1: mã lý do `not_meme` trong `RejectReason`, `layer1` gồm dấu hiệu "không phải meme" (AC-MOD-12, AC-MOD-13) | - |
| 2026-10-30 | 2.7 | Yêu cầu 2026-10-30 "job thêm ảnh cho meme đang có, không cần quan tâm bản quyền hay mặt người thật": AC-ART-15 mới (workflow chạy tay `art-search`, chỉ meme chưa có ảnh, tìm ảnh trên web, gắn như ảnh admin qua `PUT /admin/elements/{id}/image`, không kiểm duyệt LLM); bỏ "ảnh meme gốc" khỏi Ngoài phạm vi (video vẫn ngoài); ADR 0024; không đổi contract; câu hỏi mở 104 | nguyenquythuc (chờ /dk:approve spec) |
