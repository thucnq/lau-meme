# Tin nhắn WebSocket của phòng mQuiz

> Contract 0.11.0 (thêm `progress`, 2026-10-30) · ADR 0021 · Tiêu chí: `docs/acceptance/quiz.md`. OpenAPI chỉ mô tả bước nâng cấp
> (`GET /quiz/rooms/{code}/ws`, operationId `connectQuizRoom`); file này là phần contract của mọi tin nhắn sau đó.
> Đổi tên tin hoặc trường ở đây là đổi contract: cần `/dk:design` và `/dk:approve contract`.

## Quy ước chung
- Mỗi tin là một khung text JSON, có trường `type`. Tối đa 1 KB mỗi tin client gửi, tối đa 10 tin/giây/socket; vượt thì server đóng socket mã **1008** (AC-QUIZ-25).
- Server kiểm mọi tin client bằng `validate.ts`; trường lạ, thiếu hoặc sai kiểu là `bad_request`.
- Thời gian là số nguyên **epoch ms UTC theo đồng hồ của Durable Object**. Client tính lệch giờ `skew = server_now - Date.now()` ở mỗi tin có `server_now` và chỉ dùng `deadline - skew` để đếm ngược (AC-QUIZ-10).
- Id phần tử là `ElementId` (băm, ADR 0002). Ảnh là `image_key` như manifest (null khi không có ảnh hoặc ảnh bị ẩn: client hiện emoji).
- Không tin nào gửi UUID của người khác. Người chơi được nhận diện trong tin bằng `seat` (thứ tự vào phòng, từ 1).

## Client → server
| `type` | Trường | Khi nào | Ghi chú |
|---|---|---|---|
| `join` | `uuid` (UUID v4), `nickname` (string ≤ 100) | Tin đầu tiên của socket | Kiểm UUID, đồng ý `play` (D1), nickname theo luật AC-DISC-02/03 trên dạng `fold`. Cùng UUID đã có trong phòng = vào lại (AC-QUIZ-16), nickname cũ được giữ |
| `start` | - | Chủ phòng, ở phòng chờ | 1 người đang kết nối ⇒ chơi một mình (`solo_pack`); ≥ 2 ⇒ ván nhiều người |
| `answer` | `q` (int), `picks` ([ElementId, ElementId]) | Câu `q` đang mở | Lần hợp lệ đầu tiên được ghi; thứ tự `picks` không quan trọng |
| `replay` | - | Chủ phòng, sau `final` | Về phòng chờ, nhận người mới (AC-QUIZ-24) |
| `leave` | - | Người chơi bấm "Rời phòng" | Như đóng socket; ở phòng chờ thì bỏ khỏi danh sách ngay |

## Server → client
| `type` | Trường | Gửi cho | Ghi chú |
|---|---|---|---|
| `lobby` | `code`, `questions`, `seconds`, `host_seat`, `you` (seat của mình), `players` ([{`seat`, `nickname`, `connected`}]), `last_game` (`QuizGameSummary` hoặc null), `server_now` | Mọi socket khi có người vào/rời, đổi chủ phòng, sau `replay` | Danh sách theo thứ tự vào (AC-QUIZ-04/07) |
| `started` | `game_no`, `total` (số câu thật), `seconds`, `server_now` | Mọi socket | `total` < số câu đã chọn khi pool thiếu (AC-QUIZ-09) |
| `question` | `q`, `total`, `target` ({`name`, `emoji`, `image_key`}), `options` ([{`id`, `name`, `emoji`, `image_key`}] × 4), `server_now`, `deadline` | Mọi socket; gửi lại cho người vừa vào lại | Không có trường nào về đáp án, độ sâu hay công thức (AC-QUIZ-10) |
| `answered` | `q` | Riêng người vừa nộp; gửi lại khi vào lại nếu đã nộp | Chưa lộ đúng/sai |
| `progress` | `q`, `answered` (số người đã nộp hợp lệ câu `q`), `total` (số người đang kết nối) | Mọi socket, sau mỗi lần nộp hợp lệ và mỗi lần có người rớt mạng/vào lại khi câu `q` đang mở | Không có seat, nickname hay đáp án (AC-QUIZ-37, câu hỏi mở 101); lần nộp không hợp lệ không phát; client bỏ qua tin có `q` khác câu đang mở. Chơi một mình không có tin này |
| `reveal` | `q`, `correct` ([ElementId, ElementId]), `results` ([{`seat`, `picks` (hoặc null), `ok`, `points`}]), `board` (`QuizBoard`), `next_at` | Mọi socket | `next_at` = lúc đóng câu + 4 000 ms (AC-QUIZ-13) |
| `final` | `game_no`, `standings` ([{`seat`, `nickname`, `score`, `correct`, `rank`}] đủ mọi người), `saved` (bool) | Mọi socket | `saved` = đã ghi lịch sử D1 (AC-QUIZ-15/18) |
| `solo_pack` | `game_no`, `total`, `seconds`, `salt`, `items` ([{`target`, `options`, `answer_hash`}]) | Riêng chủ phòng khi chơi một mình | `answer_hash` = base64url(SHA-256(`"lmq1|" + salt + "|" + q + "|" + idNhỏ + "|" + idLớn`)), `salt` = `<mã phòng>:<game_no>`; idNhỏ/idLớn là 2 id sắp xếp theo thứ tự chuỗi (AC-QUIZ-17) |
| `error` | `code`, `message` (tiếng Việt) | Riêng người gây lỗi | Xem bảng mã dưới |

`QuizBoard` = `{ top: [{seat, nickname, score, rank}] (tối đa 10), me: {seat, score, rank} }` - mỗi socket nhận `me` của riêng mình (AC-QUIZ-14). Xếp hạng: điểm giảm dần, rồi `correct_ms` tăng dần, rồi `seat` tăng dần.

## Mã lỗi trong tin `error`
| `code` | Khi | Socket |
|---|---|---|
| `bad_request` | JSON hỏng, `type` lạ, trường sai/thiếu/lạ, UUID sai định dạng | Giữ (UUID sai ở `join`: đóng 1008) |
| `not_joined` | Tin khác trước `join` | Đóng 1008 |
| `consent_required` | UUID chưa đồng ý `play` cho version chính sách hiện hành | Đóng 1008 |
| `nickname_rejected` | Nickname sai luật hoặc trúng từ cấm/bí danh | Giữ, nhập lại |
| `room_full` | Đã có 50 người | Đóng 1008 |
| `already_started` | UUID mới vào khi phòng đang chơi hoặc đã khóa chơi một mình | Đóng 1008 |
| `not_host` | `start`/`replay` từ người không phải chủ phòng | Giữ |
| `not_enough_questions` | Pool < 5 meme đề (AC-QUIZ-09) | Giữ, phòng vẫn chờ |
| `already_answered`, `bad_answer`, `wrong_question`, `too_late` | Nộp bài không hợp lệ (AC-QUIZ-11) | Giữ |

## Mã đóng socket
| Mã | Nghĩa |
|---|---|
| 1000 | Bình thường (`leave`, phòng hủy sau 5 phút không ai kết nối) |
| 1008 | Vi phạm (quá lớn, quá nhanh, các lỗi đóng ở bảng trên) |
| 4001 | Socket bị thay bởi socket mới của cùng UUID (AC-QUIZ-16) |

## Hằng số (câu hỏi mở 92, chốt 2026-10-28)
Tối đa 50 người/phòng · nghỉ 4 000 ms giữa các câu · chủ phòng rời phòng chờ 30 000 ms thì chuyển quyền · không ai kết nối 300 000 ms (5 phút) thì hủy phòng · tin ≤ 1 KB, ≤ 10 tin/giây.

## Điểm (AC-QUIZ-12)
`points = round(1000 × (1 − 0,5 × t / T))`, `t = received_at − question_sent_at` (ms, đồng hồ DO, kẹp trong [0, T]), `T = seconds × 1000`; sai, đúng một nửa hoặc không nộp: 0.
