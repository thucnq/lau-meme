# 0021 - Phòng mQuiz trên Durable Objects + WebSocket Hibernation, lịch sử trong D1

- Trạng thái: Đề xuất
- Ngày: 2026-10-28
- Nguồn: AC-QUIZ-01..28, BRD 4.7, câu hỏi mở 87-92, `docs/input/mquiz.md`

## Bối cảnh
- mQuiz là tính năng đầu tiên cần thời gian thực: phòng chờ cập nhật trực tiếp, câu hỏi phát cùng lúc cho ≤ 50 người, hạn nộp và điểm theo thời gian trả lời phải đo ở server (AC-QUIZ-04/10/12), bảng điểm sau mỗi câu (AC-QUIZ-14).
- Worker hiện chỉ có HTTP + D1 (ADR 0001, 0003): mỗi yêu cầu là một isolate không giữ trạng thái, không phát được tin tới nhiều trình duyệt, không có đồng hồ chạy giữa các yêu cầu.
- Ràng buộc: vận hành $0 (BRD mục 7), không gửi dữ liệu người chơi cho bên thứ ba, production chỉ do người deploy.

## Quyết định
- **Một Durable Object mỗi phòng**: lớp `QuizRoom` (SQLite-backed - gói Workers Free chỉ cho loại này), `env.QUIZ_ROOM.idFromName(<mã phòng>)`. DO là nơi duy nhất giữ trạng thái phòng (người chơi, chủ phòng, đề, câu trả lời, điểm) trong storage của nó; một luồng xử lý mỗi object nên không cần khóa.
- **WebSocket Hibernation API**: `ctx.acceptWebSocket(ws)`, `webSocketMessage`/`webSocketClose`, `ws.serializeAttachment({ seat })`; DO được ngủ giữa các tin nên không tính thời gian chạy lúc rảnh. Trạng thái cần sống qua lúc ngủ nằm trong `ctx.storage`, không trong biến của lớp.
- **Đồng hồ bằng alarm**: một alarm mỗi lúc (`ctx.storage.setAlarm`) cho mốc kế tiếp: hết giờ câu, hết 4 s nghỉ, chuyển quyền chủ phòng (30 s), hủy phòng (5 phút không ai kết nối). Thời điểm phát câu và nhận bài lấy `Date.now()` trong DO; test giả lập bằng `runDurableObjectAlarm` của `@cloudflare/vitest-plugin`.
- **Sinh đề và chấm điểm là hàm thuần** (`worker/src/features/quiz/questions.ts`, `scoring.ts`): đầu vào là `server_json` của version hiện hành + bảng chặn (đọc từ D1 một lần lúc `start`, ADR 0003), seed = `<mã phòng>:<game_no>`, PRNG có seed; không đọc đồng hồ hay `Math.random` trong logic. DO chỉ gọi hàm và lưu kết quả.
- **Worker vẫn là cửa vào**: `POST /quiz/rooms` sinh mã, ghi `quiz_room` (D1) rồi gọi DO khởi tạo; `GET /quiz/rooms/{code}` và `/ws` kiểm `quiz_room` trước khi đánh thức DO (mã lạ không tạo object). WebSocket đi qua Worker rồi chuyển nguyên `Request` cho DO.
- **Lịch sử trong D1** (`0011_quiz_history.sql`): DO ghi `quiz_game` + `quiz_player` bằng một `DB.batch` lúc `final`, `UNIQUE(room_code, game_no)` làm lần ghi lặp vô hại. Cron dọn hằng ngày sẵn có (AC-PRIV-06) xóa ván quá 90 ngày. Ván một mình không ghi gì (AC-QUIZ-17).
- **Chơi một mình**: DO trả `solo_pack` một lần (đáp án dạng băm có muối = mã phòng, `docs/api/quiz-ws.md`), khóa phòng, rồi không làm gì thêm cho tới khi hủy.
- **Cấu hình** (`worker/wrangler.jsonc`): `durable_objects.bindings` `QUIZ_ROOM` → `QuizRoom`, `migrations: [{ tag: "v1", new_sqlite_classes: ["QuizRoom"] }]`; khai báo lại trong `env.staging` và `previews` vì binding không được kế thừa. Lớp được export từ `src/index.ts`.

## Hệ quả
- Thêm một loại hạ tầng (Durable Objects). Hạn mức gói Free (kiểm ngày 2026-10-28 trên trang giá Cloudflare): 100 000 request/ngày, 13 000 GB-s/ngày, 5 triệu dòng đọc và 100 000 dòng ghi SQLite/ngày; tin WebSocket gửi vào tính 20:1; vượt thì lỗi chứ không tính tiền. Phòng 10 người × 10 câu ≈ 35 request ⇒ ~2 500 phòng/ngày. Hết hạn mức thì chỉ mQuiz lỗi (tạo/vào phòng trả lỗi), phần còn lại của game không ảnh hưởng.
- Deploy production lần đầu có migration lớp DO: người chạy `wrangler deploy` như thường (CLAUDE.md), không có lệnh thêm. Xóa/đổi tên lớp sau này cần migration `deleted_classes`/`renamed_classes` - coi như thay đổi phá vỡ, cần ADR.
- Rollback code về bản không có `QuizRoom` vẫn được khi chưa ai dùng phòng; object đã tạo nằm yên, hết 5 phút tự xóa storage.
- Trạng thái phòng không qua D1 nên không có trong D1 Time Travel; chấp nhận vì phòng sống tối đa vài chục phút.
- Test DO chạy trong Miniflare cùng bộ test worker (chậm trên WSL): đa số test đặt ở hàm thuần (sinh đề, điểm, xếp hạng), test DO chỉ cho luồng và đồng hồ.
- Thời gian phát tin ≤ 1 s (BRD mục 7) phụ thuộc vị trí DO (gần người tạo phòng); người chơi ở xa vẫn chấp nhận được với hạn 10-30 s.

## Phương án đã loại
- **Thăm dò D1 mỗi 1 s**: 50 người × 1 yêu cầu/s ≈ 3 000 request Worker/phút/phòng, đồng hồ không chính xác, ghi D1 tranh chấp khi nhiều người nộp cùng lúc.
- **Dịch vụ thời gian thực bên ngoài (Pusher, Ably, Firebase)**: gói free có trần thấp, thêm bí mật, và gửi UUID/nickname của người chơi ra bên thứ ba (trái BRD 5.2).
- **Server-Sent Events + POST**: vẫn cần nơi giữ trạng thái và đồng hồ (lại là DO hoặc D1), hai kênh thay cho một.
- **DO lớp cũ dùng KV storage**: gói Free không cho; SQLite-backed là mặc định được khuyên dùng.
- **Lưu lịch sử trong storage của DO**: không truy vấn được theo UUID (AC-QUIZ-19) và mất khi phòng hủy.

## Bổ sung 2026-10-28
- Không ghi sự kiện mQuiz vào bảng `event` (AC-QUIZ-27 đã bỏ, câu hỏi mở 93): CHECK của cột `type` chỉ cho 7 loại và migration chỉ được mở rộng. Contract 0.10.1.
- Sau review: `start` từ chối lần gọi thứ hai khi lần đầu còn đang đọc D1; bài nộp sau `deadline` mà alarm chưa chạy vẫn bị `too_late`; nâng cấp WebSocket giới hạn 120 lần/phút/IP băm, socket sai `join` 10 lần bị đóng 1008; người xóa dữ liệu giữa ván được ghi lịch sử ẩn danh. Rút đồng ý giữa ván không đuổi người chơi ra (ván dài tối đa vài phút); lần vào phòng sau mới bị kiểm lại.
