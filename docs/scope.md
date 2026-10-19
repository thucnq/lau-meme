# Phạm vi đề xuất — Lẩu Meme

> Trạng thái: Đã chốt
> Nguồn: docs/input/ghi-chu-hop.md, docs/input/noi-dung-loi.md, docs/input/noi-dung-loi.json, docs/input/noi_dung.py, docs/input/tong-hop-plugin-dk-qldn.md (mục 6), docs/input/README.md

| Mã | Tính năng | Mô tả ngắn | Nguồn | Ưu tiên | Cỡ | Hạng mục báo giá |
|---|---|---|---|---|---|---|
| GAME | Chơi ghép (Nhúng lẩu) | Nồi lẩu 2 chỗ thả + thả chồng trên bàn; hiệu ứng ≤ 1,2 s bỏ qua được; Đĩa nhúng (tìm không dấu, sắp xếp thời gian/tên/độ sâu); ghép trượt ra câu "Nồi trào" cố định theo cặp, thỉnh thoảng gợi ý một phần tử nên thử; nhãn "MỚI"; lưu tiến độ cục bộ, "Dọn bàn", "Chơi lại từ đầu"; chuột + cảm ứng, ≥ 375 px, chế độ tối, hướng dẫn lần đầu; ghép tra trong bộ nhớ < 50 ms | ghi-chu-hop.md 5.1: "nồi lẩu ở giữa có 2 chỗ thả"; Q13: "gợi ý một phần tử nên thử" | Bắt buộc | L | — |
| GRAPH | Graph mã hóa + manifest + rollback | Xuất graph công khai: khóa = băm cặp tên chuẩn hóa, kết quả mã hóa bằng khóa dẫn xuất từ 2 tên đầu vào; manifest có version và giờ mẻ thật; giữ 14 bản; workflow chạy tay rollback về đợt trước; client giải mã khi ghép | ghi-chu-hop.md 6.1: "graph công khai không được chứa công thức dạng đọc được"; 5.4 bước 8; 5.5: "Rollback graph … bằng một lệnh" | Bắt buộc | M | — |
| SEED | Nạp lõi nội dung classic | Nạp `noi-dung-loi.json` (139 phần tử, 363 công thức, 40 câu Nồi trào, 4 phần tử khởi đầu) vào kho nội dung; kiểm tới được, không trùng cặp/tên/emoji. Cho phép go-live với lõi trước khi crawl ổn định | noi-dung-loi.md: "pipeline nạp làm lõi classic" | Bắt buộc | S | — |
| PIPE | Pipeline Mẻ nhúng mới | Python trên GitHub Actions cron 17:00/05:00 UTC + chạy tay: crawl theo adapter (Reddit API, Know Your Meme, Google Trends VN, YouTube trending, RSS; không Facebook/TikTok, không tải ảnh), khử trùng, liên kết ngược 2–3 cặp + BFS độ sâu, hàng chờ meme chưa nối được, công thức bổ sung (≥ 3 công thức đi ra/phần tử), giám khảo hài ≥ 3/5, chọn Món đặc biệt, deploy; idempotent, lỗi giữa chừng không đăng; gom lô Gemini, backoff, hết quota dừng êm; < 15 phút; báo cáo đợt qua GitHub Issue | ghi-chu-hop.md 5.4; Q2, Q3, Q4, Q5, Q7 | Bắt buộc | L | — |
| MOD | Kiểm duyệt nội dung tự động | Lớp 1 từ cấm, lớp 2 LLM theo danh mục cấm mục 7; luật người thật 7.1 dựa trên ngữ cảnh nguồn (LLM trả lời có trỏ tới người cụ thể không, các tên gọi khác) → danh sách chặn bí danh (áp cả nickname); không chắc thì loại; kiểm cả phần tử lẫn tên kết quả công thức; hoãn chọn Daily/nhãn "MỚI" cho hiện tượng đang nóng vì một người (~30 ngày) | ghi-chu-hop.md 5.4 bước 3; mục 7, 7.1 | Bắt buộc | L | — |
| ART | Ảnh minh họa tự tạo | Vẽ khái niệm bằng Workers AI (FLUX.1 schnell) từ gợi ý ảnh + phong cách sticker chung; kiểm duyệt ảnh bằng Gemini (mặt người giống thật, logo, nhân vật có bản quyền, chữ); vẽ lại 1 lần rồi về emoji; hết hạn mức vẽ bù đợt sau; lưu R2 `/img/<sha256-12>.webp` 256×256, Worker + Cache API `immutable`; client hiện emoji trước, ảnh lỗi/bị chặn giữ emoji | ghi-chu-hop.md Q9, Q14, 5.4 bước 6b | Bắt buộc | M | — |
| DAILY | Món đặc biệt hôm nay | Mỗi mẻ 1 món (độ sâu [4, 8]); công bố emoji + gợi ý mờ, lộ tên khi ghép được; đếm mọi lượt ghép kể cả trượt; bảng xếp hạng ít bước nhất trong đợt theo nickname (server kiểm đường ghép hợp lệ); đồng hồ đếm ngược theo manifest thật | ghi-chu-hop.md 5.2; Q6; rủi ro: "đồng hồ đếm ngược dựa trên manifest thật" | Bắt buộc | M | — |
| DISC | Công thức gia truyền | Người chơi ẩn danh: UUID cục bộ + nickname tùy chọn (lọc từ cấm + danh sách bí danh, giới hạn độ dài); gửi khám phá đầu tiên, server kiểm công thức có thật rồi ghi người đầu tiên; hiện "Công thức gia truyền của <nickname>" cho mọi người; giới hạn tần suất theo UUID và IP băm. Dữ liệu cá nhân cơ bản (định danh trực tuyến, IP) | ghi-chu-hop.md 5.3; Q6 | Bắt buộc | M | — |
| SHARE | Thẻ chia sẻ | Thẻ Daily kiểu Wordle (chữ dán được lên Facebook/Zalo/Messenger + ảnh PNG hình nồi lẩu: số bước, chuỗi emoji, link, không lộ đáp án) và thẻ Công thức gia truyền; nút sao chép / chia sẻ hệ thống | ghi-chu-hop.md 5.2: "Thẻ chia sẻ kiểu Wordle"; 5.3: "+ thẻ chia sẻ" | Bắt buộc | M | — |
| REPORT | Báo cáo + chặn nóng | Nút "Báo cáo" (chọn lý do) cho phần tử và ảnh; 3 báo cáo từ 3 UUID khác nhau ⇒ tự ẩn ngay; ảnh bị báo cáo về emoji; danh sách chặn nóng client tải khi khởi động, có hiệu lực không cần deploy | ghi-chu-hop.md 5.5; rủi ro: "nút báo cáo áp cho cả ảnh" | Bắt buộc | M | — |
| ADMIN | Trang quản trị tối giản | Bảo vệ bằng token (Cloudflare secret): xem báo cáo, ẩn/hiện/chặn phần tử và công thức, xem nhật ký các đợt; ghi audit mọi thao tác admin | ghi-chu-hop.md 5.5: "Trang admin (bảo vệ bằng token)"; audit: suy luận: cần biết ai/khi nào ẩn gì khi khôi phục trong 5 phút | Bắt buộc | M | — |
| FEEDBACK | Ngon / Nhạt | Nút "Ngon"/"Nhạt" trên công thức vừa ghép (1 phiếu/UUID/công thức); pipeline đọc tỉ lệ "Nhạt" để hạ điểm hoặc ẩn công thức ở đợt sau | ghi-chu-hop.md 5.6 (không có trong danh sách MVP mục 3) | Tùy chọn | S | — |
| METRIC | Đo chỉ số thành công | Cloudflare Web Analytics (không cookie) + bảng sự kiện ẩn danh tối giản trong D1: người chơi Daily/ngày, D1/D7 retention theo UUID, lượt chia sẻ 2 loại thẻ, tỉ lệ ghép trượt, tỉ lệ "Nhạt", số báo cáo; tổng hợp vào báo cáo đợt | ghi-chu-hop.md 1 "Chỉ số thành công"; câu hỏi mở 2 | Bắt buộc | S | — |
| PRIV | Chính sách quyền riêng tư | Trang chính sách ngắn (dữ liệu thu, mục đích, thời hạn giữ, không gửi dữ liệu người chơi cho LLM); IP chỉ lưu dạng băm, xóa sau thời hạn ngắn; người chơi tự xóa nickname/dữ liệu của mình qua UUID. Dữ liệu cá nhân cơ bản, không có dữ liệu nhạy cảm | ghi-chu-hop.md mục 3 "trang chính sách quyền riêng tư"; NFR "Dữ liệu cá nhân"; quyền xóa: suy luận: Luật BVDLCN 2025 cho chủ thể quyền yêu cầu xóa | Bắt buộc | S | — |

## Có sẵn trong golden path (không tính điểm)
- Worker TypeScript phục vụ cả web tĩnh lẫn `/api/*`, D1 với migration tuần tự, môi trường staging/production (`worker/wrangler.jsonc`).
- `GET /api/health` và lỗi `application/problem+json` (AC-HEALTH-01/02).
- Hàm chuẩn hóa không dấu `fold` trong pipeline (AC-HEALTH-03) — dùng lại cho khử trùng và tìm kiếm.
- CI GitHub Actions (lint, typecheck, coverage, build, secret scan, OpenAPI lint), workflow deploy, git hooks, `.gitignore` chặn `.dev.vars`/`.env`.
- Không dùng: đăng nhập email/Google, phân quyền vai trò, cách ly tenant (ngoài phạm vi — người chơi ẩn danh, admin dùng 1 token).

## Đối chiếu báo giá
Chưa có báo giá — dự án cá nhân, không báo giá (ghi-chu-hop.md mục 1). Chạy `/dk:estimate --no-quote` sau khi chốt phạm vi để có điểm và lịch theo 20 giờ/tuần.
Ước lượng thô từ cột Cỡ (S=2, M=7, L=15 ngày công): bắt buộc ≈ 3×15 + 7×7 + 3×2 = **100 ngày công ≈ 800 giờ ≈ 40 tuần** ở 20 giờ/tuần — xa với "go-live sớm nhất có thể". Nếu cần ra mắt sớm, ứng viên để sau: ART (dùng emoji), METRIC dạng bảng sự kiện (chỉ giữ Web Analytics), bước công thức bổ sung + giám khảo của PIPE (đã đạt NFR ghép trượt với lõi), bảng xếp hạng DAILY. Đây chỉ là kiểm tra thô.

## Cần hỏi trước khi chốt phạm vi
1. Có chấp nhận **go-live giai đoạn 1 chỉ với lõi classic (SEED) + chạy pipeline tay**, rồi bật cron tự động đăng ở giai đoạn 2 không? (Quyết định PIPE/MOD có nằm trong mốc ra mắt hay không.)
có chấp nhận
2. Ảnh minh họa (ART) có bắt buộc cho ngày ra mắt không, hay emoji trước, ảnh bổ sung sau?
emoji trước, ảnh bổ sung sau
3. Đo chỉ số: Cloudflare Web Analytics có đủ, hay cần bảng sự kiện riêng trong D1 (bắt buộc nếu muốn đo D1/D7 retention và lượt chia sẻ)? (câu hỏi mở 2)
cần bảng sự kiện
4. Bảng xếp hạng Daily: chỉ đợt hiện tại, hay thêm chuỗi ngày liên tiếp (streak)? (câu hỏi mở 3)
thêm streak
5. Có cần trang giới thiệu/landing riêng cho kênh ra mắt (Facebook group, TikTok) không? (câu hỏi mở 5)
không