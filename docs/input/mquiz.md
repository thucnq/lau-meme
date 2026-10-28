# Nghiên cứu tính năng mQuiz (đầu vào cho /dk:spec)

> Ngày: 2026-10-28 · Trạng thái: Nghiên cứu, chưa vào phạm vi · Đã chốt Q1-Q14 (2026-10-28)
> Yêu cầu gốc (2026-10-28): "User tạo phòng, gửi link phòng cho các user khác tham gia. Danh sách câu đố là các meme. Người chơi chọn 2 trong 4 đáp án để ghép đúng câu đố. Tính điểm theo thời gian trả lời đúng, có bảng xếp hạng điểm trực tiếp và sau khi hoàn thành danh sách câu hỏi."

## 1. Tóm tắt
- Chế độ chơi nhiều người theo thời gian thực, kiểu quiz phòng: chủ phòng tạo phòng, chia link, mọi người vào cùng lúc, chủ phòng bấm bắt đầu.
- Mỗi câu: hiện một meme C (emoji, ảnh nếu có, tên); 4 lựa chọn là 4 phần tử, trong đó đúng 2 phần tử A, B ghép ra C (công thức có thật trong lõi). Người chơi chọn 2 ô rồi nộp.
- Trả lời đúng càng nhanh càng nhiều điểm; sau mỗi câu hiện đáp án và bảng điểm trực tiếp; hết câu cuối hiện bảng xếp hạng chung cuộc.

## 2. Va chạm với phạm vi đã chốt
1. **BRD mục 1 "Ngoài phạm vi"** đang ghi "chơi với bạn bè thời gian thực" (nguồn `ghi-chu-hop.md` dòng 48). mQuiz là đổi phạm vi: phải đi lại `/dk:spec` (sửa `docs/scope.md`, BRD, thêm `docs/acceptance/quiz.md`) rồi `/dk:approve spec` lại.
2. **Lộ công thức.** Lẩu Meme giấu công thức (graph mã hóa, AC-INV-04; Món đặc biệt giấu tên). Mỗi câu quiz lộ một công thức A + B = C cho cả phòng. Không phạm AC-INV-04 (graph vẫn mã hóa, đề do server giữ) nhưng làm "xì" phần khám phá của trò chính. Cần chủ dự án chốt (câu hỏi Q1).
3. **Hạ tầng mới.** Hiện Worker chỉ có HTTP + D1, không có kết nối thời gian thực. mQuiz cần Durable Objects + WebSocket: thêm binding, migration lớp DO trong `wrangler.jsonc`, ADR mới.

## 3. Số liệu lõi (đo trên `noi-dung-loi.json`, 174 phần tử, 518 công thức)
| Chỉ số | Giá trị | Hệ quả cho quiz |
|---|---|---|
| Phần tử là kết quả của ít nhất 1 công thức | 170 | Đủ cho nhiều phòng mà ít lặp đề |
| Công thức tự ghép (A + A) | 51 | "Chọn 2 trong 4" không biểu diễn được A + A (trừ khi cho 2 ô trùng): đề xuất loại khỏi pool |
| Công thức 2 phần tử khác nhau | 467 | Pool câu hỏi |
| Số công thức theo kết quả | 1: 42 · 2: 28 · 3: 41 · 4: 27 · 5+: 32 | Nhiều kết quả có nhiều cặp: nhiễu phải không tạo thành cặp đúng khác |
| Độ sâu kết quả | 1: 10 · 2: 39 · 3: 62 · 4: 29 · 5: 17 · 6: 9 · 7: 4 | Dùng làm độ khó |
| Công thức mà chọn 2 nhiễu ngẫu nhiên hay trùng cặp đúng (thử 50 lần, < 90% đạt) | 72 / 467 | Bộ sinh đề phải kiểm và chọn lại, không chọn mù |

## 4. Luồng đề xuất
1. **Tạo phòng.** Người chơi bấm "Tạo phòng mQuiz", chọn số câu (mặc định 10) và thời gian mỗi câu (mặc định 20 s). Server trả mã phòng 6 ký tự và link `https://dinoduct.fun/lau-meme/quiz/<mã>`.
2. **Phòng chờ.** Người nhận link mở trang, nhập nickname (lọc từ cấm + bí danh như DISC), vào danh sách người chơi thấy trực tiếp. Chủ phòng thấy nút "Bắt đầu".
3. **Câu hỏi.** Server phát câu i (meme C + 4 lựa chọn đã xáo, giờ bắt đầu, hạn). Người chơi chọn 2 ô, bấm "Chốt" (chỉ 1 lần nộp mỗi câu). Server ghi thời điểm nhận.
4. **Lộ đáp án.** Hết giờ hoặc mọi người đã nộp: server phát đáp án, điểm câu đó của từng người, bảng điểm tổng (top + hạng của mình). Ngắt 3-5 s rồi sang câu tiếp.
5. **Kết thúc.** Server ghi kết quả ván vào D1 (lịch sử, Q7). Bảng xếp hạng chung cuộc (🥇🥈🥉 như AC-DAILY-17), nút "Chơi lại" (chủ phòng, cùng người chơi, đề mới) và thẻ chia sẻ (tùy chọn).
- Ngoại lệ: mất mạng thì vào lại bằng cùng link, server nhận ra người chơi qua mã người chơi lưu cục bộ, giữ điểm; phòng đã bắt đầu thì không nhận người mới, link hiện "Phòng đã bắt đầu" (Q6); chủ phòng rời thì quyền chủ phòng chuyển cho người vào sớm nhất còn lại; phòng không ai kết nối quá 5 phút thì tự hủy (câu hỏi mở 92, chốt 2026-10-28).

### 4.1 Chơi một mình (Q9, chốt 2026-10-28)
1. Tạo phòng như thường (cần mạng). Phòng chờ chỉ có chủ phòng mà bấm "Bắt đầu" thì vào chế độ một mình.
2. Server khóa phòng (không nhận thêm người) và trả **cả gói đề** một lần: các câu, lựa chọn và đáp án (đáp án ở dạng băm hoặc mã hóa theo cặp như graph, để không đọc thẳng được trong DevTools; người cố tình vẫn giải được, chấp nhận vì chơi một mình không có xếp hạng chung).
3. Từ đó client tự chạy: đồng hồ, chấm điểm, lộ đáp án, bảng kết quả, không cần WebSocket, mất mạng giữa ván không sao. Tải lại trang giữa ván thì chơi tiếp từ câu đang dở (gói đề lưu cục bộ).
4. Ván một mình không vào lịch sử (Q14): chỉ hiện bảng kết quả cuối ván, không lưu trên máy hay server.

## 5. Kiến trúc đề xuất
```
Trình duyệt ──HTTP POST /lau-meme/api/quiz/rooms──▶ Worker ──▶ tạo mã, khởi tạo DO "QuizRoom" (idFromName(mã))
Trình duyệt ──WS /lau-meme/api/quiz/rooms/<mã>/ws──▶ Worker ──(chuyển nguyên request)──▶ DO QuizRoom
                                                   DO: trạng thái phòng (SQLite của DO), đồng hồ (alarm), phát tin cho mọi socket
DO ──đọc nội dung version hiện hành (server_json, block) qua D1 một lần lúc bắt đầu──▶ sinh đề
DO ──(tùy chọn) ghi kết quả chung cuộc──▶ D1
```
- **Durable Object mỗi phòng** (`QuizRoom`, SQLite-backed - gói Free chỉ cho loại này). Một DO là một điểm duy nhất giữ trạng thái và đồng hồ: không tranh chấp, không cần khóa trong D1.
- **WebSocket Hibernation API** (`ctx.acceptWebSocket`, `webSocketMessage`, `serializeAttachment` cho mã người chơi): DO ngủ giữa các tin, không tính thời gian chạy lúc rảnh.
- **Đồng hồ ở server:** `ctx.storage.setAlarm(hạn câu)`; giờ bắt đầu/nhận đều lấy theo đồng hồ DO, không tin giờ máy khách. Client chỉ hiện đếm ngược theo `deadline - (giờ server lúc phát)` để bù lệch giờ.
- **Đề sinh phía server, đáp án không gửi trước:** tin "câu hỏi" chỉ có 4 lựa chọn; tin "đáp án" mới có cặp đúng. Hàm sinh đề thuần (seed = mã phòng + số lần chơi), test tất định như quy tắc pipeline.
- **Nội dung:** dùng `server_json` của version đang chạy (ADR 0003) + áp bảng `block`; ảnh dùng lại `/lau-meme/img/*` (ART), thiếu ảnh thì emoji.
- **REST cho contract:** `POST /api/quiz/rooms` (tạo), `GET /api/quiz/rooms/{code}` (phòng có tồn tại, đang ở trạng thái nào). Tin WebSocket không mô tả được trong OpenAPI 3: ghi schema tin nhắn vào `docs/api/quiz-ws.md` (hoặc AsyncAPI) và kiểm bằng hàm `validate` sẵn có.
- **SUBPATH:** thêm màn `/lau-meme/quiz/<mã>` vào SPA fallback (F5 vào thẳng phòng, AC-SUBPATH).
- **Kiểm thử:** `@cloudflare/vitest-plugin` chạy được DO và WebSocket trong Miniflare; đồng hồ test bằng cách gọi alarm trực tiếp (`runDurableObjectAlarm`). Lưu ý bộ test worker chậm trên WSL (~66 ms/truy vấn D1): giữ đa số test ở hàm thuần (sinh đề, tính điểm).

### Sinh câu hỏi (đề xuất mặc định)
- Pool: công thức đang hoạt động, A ≠ B, không phần tử nào trong A, B, C bị chặn; không lặp C trong cùng một lượt chơi.
- Nhiễu X, Y: phần tử đang hoạt động, khác A, B, C, ưu tiên cùng khoảng độ sâu với A/B (khó đoán hơn). Ràng buộc: trong 6 cặp từ 4 lựa chọn, **chỉ đúng cặp (A, B) ra C**; cũng không có cặp tự ghép nào ra C. Không đạt thì chọn lại (giới hạn số lần, hết thì đổi công thức).
- Độ khó tăng dần theo độ sâu của C (câu đầu dễ, câu cuối khó) - hoặc để ngẫu nhiên (Q5).

### Tính điểm (đề xuất mặc định, chưa chốt - Q3)
- Sai hoặc không nộp: 0. Đúng: `điểm = round(1000 × (1 − 0,5 × t / T))`, t = thời gian từ lúc server phát câu tới lúc server nhận bài, T = thời gian mỗi câu. Đúng ngay lập tức ≈ 1000, đúng sát giờ ≈ 500.
- Không có điểm nửa (đúng 1 trong 2 phần tử = sai).
- Hòa điểm: ai có tổng thời gian trả lời đúng ít hơn xếp trên.

## 6. Danh tính, dữ liệu cá nhân, chống lạm dụng
- Người chơi: UUID cục bộ + nickname cho phòng (ẩn danh như DISC) - hay bắt buộc đăng nhập Google như DAILY (Q2). Đề xuất: ai cũng chơi được; tạo phòng thì cần đồng ý chính sách (PRIV) để giới hạn tần suất theo UUID/IP băm.
- Trạng thái phòng đang chơi nằm trong storage của DO, xóa khi phòng hủy (alarm dọn). Kết quả chung cuộc ghi vào D1 làm lịch sử (Q7 đã chốt): cần bảng mới, thời hạn giữ, đưa vào xem/xuất/xóa dữ liệu của PRIV và cập nhật trang chính sách (nickname gắn UUID là dữ liệu cá nhân cơ bản).
- Giới hạn: tạo phòng 5 phòng/giờ/UUID, 20/giờ/IP băm (dùng `ratelimit.ts`); tối đa 50 người/phòng; tin WebSocket > 1 KB hoặc > 10 tin/giây/socket thì đóng socket. Nickname trùng trong phòng thì thêm hậu tố.
- Không gửi gì cho LLM.

## 7. Chi phí (giữ $0)
Gói Workers Free có Durable Objects SQLite: 100 000 request/ngày, 13 000 GB-s/ngày, 5 triệu dòng đọc, 100 000 dòng ghi mỗi ngày; tin WebSocket gửi vào tính 20 tin = 1 request; vượt hạn thì lỗi chứ không tính tiền. Ước tính một phòng 10 người × 10 câu: 10 kết nối + ~100 tin vào (≈ 5 request) + ~20 alarm ⇒ ~35 request. Hạn 100 000/ngày đủ cho khoảng 2 500 phòng/ngày. Nguồn: https://developers.cloudflare.com/durable-objects/platform/pricing/ (kiểm lại lúc lập ADR).

## 8. Câu hỏi cần chủ dự án chốt
| # | Câu hỏi | Mặc định đề xuất | Trả lời |
|---|---|---|---|
| Q1 | Chấp nhận quiz lộ công thức cho người chơi không? Có giới hạn pool không? | Có; chỉ lấy công thức có C độ sâu ≤ 5 và không phải Món đặc biệt của mẻ đang chạy | **Đã chốt 2026-10-28: chấp nhận lộ công thức**; giới hạn pool theo mặc định (chưa phản đối) |
| Q2 | Ai được tạo phòng, ai được chơi: ẩn danh hay bắt buộc đăng nhập Google? | Ẩn danh + nickname cho cả hai; đăng nhập thì dùng nickname tài khoản | **Đã chốt 2026-10-28: chơi ẩn danh** (UUID cục bộ + nickname, không bắt buộc đăng nhập) |
| Q3 | Công thức tính điểm | Mục 5 "Tính điểm" | **Đã chốt 2026-10-28: trả lời đúng càng nhanh điểm càng cao**; công thức cụ thể theo mặc định mục 5 |
| Q4 | Số câu, thời gian mỗi câu: cố định hay chủ phòng chọn? | Chủ phòng chọn 5/10/15 câu, 10/20/30 s; mặc định 10 câu, 20 s | **Đã chốt 2026-10-28: theo mặc định** |
| Q5 | Độ khó: tăng dần theo độ sâu hay ngẫu nhiên? | Tăng dần | **Đã chốt 2026-10-28: theo mặc định** |
| Q6 | Vào muộn khi phòng đang chơi? | Được, chơi từ câu kế tiếp, các câu đã qua 0 điểm | **Đã chốt 2026-10-28: phòng đã bắt đầu thì không nhận thêm người**; mở link lúc đó thấy "Phòng đã bắt đầu". Người đã vào trước mà rớt mạng vẫn vào lại được (cùng mã người chơi) |
| Q7 | Có lưu kết quả / bảng xếp hạng mQuiz toàn cục, có tính vào Daily/streak không? | Không lưu, không tính; chỉ bảng trong phòng | **Đã chốt 2026-10-28: lưu vào lịch sử**; chi tiết xem Q11-Q13 |
| Q8 | Đề chỉ từ meme người chơi đã có trong Đĩa (đỡ lộ) hay từ toàn bộ lõi? | Toàn bộ lõi (phòng nhiều người, Đĩa mỗi người khác nhau) | **Đã chốt 2026-10-28: toàn bộ lõi, không chứa Món đặc biệt (thử thách) của mẻ hiện tại** |
| Q9 | Có chế độ một mình (luyện tập, không phòng) không? | Không ở bản đầu | **Đã chốt 2026-10-28: có** - tạo phòng rồi bắt đầu khi chỉ có 1 người thì ván chạy offline trên máy (xem mục 4.1) |
| Q10 | Thẻ chia sẻ kết quả phòng? | Tùy chọn, sau bản đầu | **Đã chốt 2026-10-28: theo mặc định** |
| Q11 | (từ Q7) Lịch sử lưu những gì? | Mỗi ván: mã phòng, thời điểm bắt đầu/kết thúc, số câu, bảng xếp hạng chung cuộc (nickname, điểm, hạng); không lưu từng câu trả lời | **Đã chốt 2026-10-28: theo mặc định** |
| Q12 | (từ Q7) Ai xem được lịch sử, xem ở đâu? | Mỗi người chơi xem các ván mình đã chơi (theo UUID; đăng nhập Google thì gộp theo tài khoản) ở mục "Lịch sử mQuiz"; link phòng cũ mở ra bảng chung cuộc của ván đó cho ai có link | **Đã chốt 2026-10-28: theo mặc định** |
| Q13 | (từ Q7) Giữ lịch sử bao lâu, có tính vào Daily/streak/bảng xếp hạng chung không? | Giữ 90 ngày rồi xóa (cron dọn hằng ngày, như AC-PRIV-06); không tính vào Daily/streak; người chơi xóa được qua "Xóa dữ liệu của tôi" (PRIV) | **Đã chốt 2026-10-28: theo mặc định** |
| Q14 | (từ Q9) Ván chơi một mình (offline) có vào lịch sử không? Điểm do máy người chơi tính nên không kiểm được | Chỉ lưu lịch sử trên máy (localStorage), không gửi lên server, không hiện cho người khác | **Đã chốt 2026-10-28: không vào lịch sử** (không lưu cả trên máy lẫn server; chỉ hiện bảng kết quả cuối ván) |

## 9. Cỡ và bước tiếp theo
- Cỡ: **L** (DO + WebSocket mới, sinh đề, chế độ một mình offline; 4 màn web: tạo phòng, phòng chờ, câu hỏi, kết quả; contract tin nhắn; ADR; lịch sử). Cần migration D1 cho lịch sử (Q7): bảng ván `quiz_game` + bảng người chơi trong ván `quiz_player` (UUID, nickname, điểm, hạng), expand-only.
- ADR mới: "Phòng mQuiz trên Durable Objects + WebSocket Hibernation" (so với phương án loại: polling D1 mỗi 1 s - tốn request và trễ; dịch vụ ngoài như Pusher/Ably - phá $0 và gửi dữ liệu ra ngoài).
- Trình tự dk: (đã thêm dòng QUIZ vào `docs/scope.md`) → bỏ "chơi với bạn bè thời gian thực" khỏi Ngoài phạm vi → `/dk:spec` → `/dk:approve spec` → `/dk:estimate --no-quote` → `/dk:plan` → `/dk:design` (ADR, `openapi.yaml`, `quiz-ws.md`) → `/dk:approve contract` → `/dk:build quiz`.
