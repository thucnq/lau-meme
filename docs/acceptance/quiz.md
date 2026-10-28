# Tiêu chí nghiệm thu - mQuiz, đố meme theo phòng (QUIZ)

> Thêm 2026-10-28. Nguồn: `docs/input/mquiz.md` (yêu cầu và trả lời Q1-Q14 ngày 2026-10-28), `docs/scope.md` dòng QUIZ.
> Component: worker (tạo phòng, Durable Object phòng + WebSocket, sinh đề, chấm điểm, lịch sử), web (màn tạo phòng, phòng chờ, câu hỏi, kết quả, chơi một mình, lịch sử).
> Tên tin WebSocket (`join`, `lobby`, `question`, `answer`, `reveal`, `final`, `error`…) là mặc định để viết test; tên và trường chính xác chốt ở `/dk:design` (`docs/api/quiz-ws.md`).
> Thời gian trong test lấy theo đồng hồ của Durable Object (giả lập được), không theo giờ máy khách.

### AC-QUIZ-01: Tạo phòng
- **Cho** thực khách có UUID U đã đồng ý gửi dữ liệu (AC-PRIV-02/03)
- **Khi** gửi `POST /api/quiz/rooms` với `{ uuid: U, nickname: "Bếp Trưởng", questions: 10, seconds: 20 }`; và gửi lại không có `questions`, `seconds`
- **Thì** trả 201 với mã phòng 6 ký tự lấy từ bảng chữ không gây nhầm (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`), link tuyệt đối `https://<host>/lau-meme/quiz/<mã>` và trạng thái `lobby`; U là chủ phòng; thiếu `questions`/`seconds` thì dùng 10 câu, 20 giây. Hai phòng tạo liên tiếp có mã khác nhau; mã đã tồn tại (phòng chưa hủy hoặc còn trong lịch sử) không bao giờ được cấp lại
- Ưu tiên: Bắt buộc

### AC-QUIZ-02: Tạo phòng không hợp lệ
- **Cho** thực khách U
- **Khi** gửi `questions` ngoài {5, 10, 15}, `seconds` ngoài {10, 20, 30}, UUID sai định dạng, nickname sai luật; hoặc U chưa có bản ghi đồng ý; hoặc vượt giới hạn tần suất
- **Thì** lần lượt trả 400 problem+json (chỉ rõ trường sai), 422 với nickname trúng từ cấm/bí danh (như AC-DISC-03), 403 khi chưa đồng ý, 429 kèm `Retry-After` khi vượt 5 phòng/giờ/UUID hoặc 20 phòng/giờ/IP băm (mặc định, câu hỏi mở 92); không phòng nào được tạo
- Ưu tiên: Bắt buộc

### AC-QUIZ-03: Mở link phòng
- **Cho** phòng P1 đang ở phòng chờ, P2 đang chơi, P3 đã kết thúc (có lịch sử), mã P4 không tồn tại
- **Khi** gửi `GET /api/quiz/rooms/{mã}` cho từng mã; và mở `/lau-meme/quiz/<mã>` trên trình duyệt, kể cả F5
- **Thì** P1 trả 200 `state: "lobby"` kèm số câu, số giây, danh sách nickname đang trong phòng; P2 trả 200 `state: "playing"` (không có đề); P3 trả 200 `state: "finished"` kèm bảng xếp hạng chung cuộc (AC-QUIZ-20); P4 trả 404 problem+json. Trang web vào thẳng màn tương ứng (AC-SUBPATH-05); P4 hiện "Không tìm thấy phòng" và nút "Tạo phòng mới"
- Ưu tiên: Bắt buộc

### AC-QUIZ-04: Vào phòng chờ
- **Cho** phòng P ở phòng chờ có chủ phòng U1
- **Khi** U2, U3 mở link, nhập nickname rồi kết nối WebSocket và gửi `join { uuid, nickname }`
- **Thì** mỗi người nhận `lobby` gồm danh sách người chơi theo thứ tự vào, ai là chủ phòng, số câu, số giây; mọi socket trong phòng nhận danh sách mới trong ≤ 1 s sau mỗi lần có người vào hoặc rời; ô nickname điền sẵn nickname đã lưu của thực khách (nếu có), sửa được cho riêng phòng này. Nickname trùng (so sau `fold`) với người đã trong phòng thì được thêm hậu tố " 2", " 3"…; người thứ 51 nhận `error { code: "room_full" }` rồi socket đóng (tối đa 50 người, mặc định câu hỏi mở 92)
- Ưu tiên: Bắt buộc

### AC-QUIZ-05: Vào phòng không hợp lệ
- **Cho** phòng P ở phòng chờ
- **Khi** gửi `join` với nickname trúng từ cấm/bí danh hoặc sai luật độ dài/ký tự (AC-DISC-02/03); UUID sai định dạng; UUID chưa đồng ý; hoặc gửi tin khác trước `join`
- **Thì** nhận `error` với mã tương ứng (`nickname_rejected`, `bad_request`, `consent_required`, `not_joined`); nickname sai thì socket giữ để nhập lại, các lỗi khác đóng socket; danh sách người chơi không đổi
- Ưu tiên: Bắt buộc

### AC-QUIZ-06: Phòng đã bắt đầu không nhận người mới (Q6)
- **Cho** phòng P đang chơi câu 3 với U1, U2; U2 rớt mạng; U9 chưa từng vào P
- **Khi** U9 mở link hoặc gửi `join`; U2 kết nối lại với cùng UUID
- **Thì** U9 thấy "Phòng đã bắt đầu" (trang) hoặc nhận `error { code: "already_started" }` rồi socket đóng, P không đổi; U2 vào lại được (AC-QUIZ-16)
- Ưu tiên: Bắt buộc

### AC-QUIZ-07: Chủ phòng bắt đầu, chuyển quyền chủ phòng
- **Cho** phòng P ở phòng chờ có U1 (chủ), U2, U3
- **Khi** U2 gửi `start`; U1 gửi `start`; và (ván khác) U1 đóng socket ở phòng chờ hơn 30 s
- **Thì** `start` của U2 nhận `error { code: "not_host" }`, P vẫn chờ; `start` của U1 chuyển P sang `playing` và phát câu 1 cho mọi người (AC-QUIZ-10); khi U1 rời quá 30 s thì quyền chủ phòng chuyển cho người vào sớm nhất còn kết nối (U2), mọi socket nhận `lobby` mới; U1 quay lại thì là người chơi thường. Chỉ chủ phòng thấy nút "Bắt đầu" và "Chơi lại"
- Ưu tiên: Bắt buộc

### AC-QUIZ-08: Sinh đề
- **Cho** nội dung version V đang chạy (ADR 0003) với bảng chặn hiện hành; Món đặc biệt của V là D; ván N câu với seed S
- **Khi** phòng bắt đầu và sinh đề
- **Thì** mỗi câu là một công thức A + B = C thỏa: A ≠ B (bỏ công thức tự ghép); A, B, C và công thức đều đang hoạt động, không bị chặn; C có độ sâu 1 đến 5 (Q1); C ≠ D (Q8); không có hai câu cùng C trong ván. Mỗi câu có 4 lựa chọn {A, B, X, Y} đôi một khác nhau và khác C; trong 6 cặp hai lựa chọn khác nhau và 4 cặp tự ghép, **chỉ đúng cặp (A, B)** là công thức ra C. Các câu xếp theo độ sâu của C không giảm (khó dần, Q5); thứ tự 4 lựa chọn được xáo. Cùng (V, bảng chặn, S, N) thì sinh ra đúng cùng một đề (hàm thuần, tất định); seed gồm mã phòng và số thứ tự ván trong phòng
- Ưu tiên: Bắt buộc

### AC-QUIZ-09: Không đủ câu hỏi
- **Cho** pool hợp lệ (AC-QUIZ-08) có K công thức ứng với K' kết quả C khác nhau
- **Khi** phòng 15 câu bắt đầu với K' = 12; và với K' = 3
- **Thì** K' = 12: ván có 12 câu, mọi người được báo "Ván này có 12 câu" trong tin bắt đầu; K' < 5: không bắt đầu, chủ phòng nhận `error { code: "not_enough_questions" }`, phòng vẫn chờ (mặc định, câu hỏi mở 90)
- Ưu tiên: Bắt buộc

### AC-QUIZ-10: Phát câu hỏi không lộ đáp án
- **Cho** phòng P bắt đầu câu i lúc server T0, mỗi câu `seconds` = 20
- **Khi** server phát `question`
- **Thì** mọi socket nhận cùng tin gồm: số câu i / tổng, meme C (tên, emoji, khóa ảnh nếu có và không bị ẩn), 4 lựa chọn (id, tên, emoji, khóa ảnh), `server_now` = T0, `deadline` = T0 + 20 s; tin không chứa trường nào cho biết lựa chọn nào đúng, độ sâu hay id công thức. Client đếm ngược theo `deadline - server_now` (không theo giờ máy); ảnh lỗi hoặc bị ẩn thì hiện emoji (AC-ART)
- Ưu tiên: Bắt buộc

### AC-QUIZ-11: Nộp câu trả lời
- **Cho** câu i đang mở, lựa chọn đúng là {A, B}
- **Khi** người chơi chọn 2 ô rồi bấm "Chốt", client gửi `answer { q: i, picks: [a, b] }`; gửi lần hai cho cùng câu; gửi `picks` 1 hoặc 3 phần tử, trùng nhau, id không thuộc 4 lựa chọn, `q` khác câu đang mở; gửi sau `deadline`
- **Thì** lần hợp lệ đầu tiên được ghi kèm thời điểm server nhận và trả `answered { q: i }` cho riêng người đó (chưa lộ đúng/sai); các trường hợp còn lại nhận `error` (`already_answered`, `bad_answer`, `wrong_question`, `too_late`) và không đổi điểm. Thứ tự hai lựa chọn không quan trọng. Trên giao diện chưa chọn đủ 2 ô thì nút "Chốt" bị khóa; đã chốt thì không đổi được
- Ưu tiên: Bắt buộc

### AC-QUIZ-12: Tính điểm (Q3)
- **Cho** câu i phát lúc T0, `seconds` = T = 20
- **Khi** người chơi nộp đúng {A, B} lúc server nhận T0 + 0 s, T0 + 10 s, T0 + 20 s; nộp đúng 1 trong 2 (ví dụ {A, X}); nộp sai cả hai; không nộp
- **Thì** điểm câu = `round(1000 × (1 − 0,5 × t / T))` với t = thời điểm server nhận − T0: lần lượt 1000, 750, 500; đúng một nửa, sai, không nộp đều 0 điểm. Điểm chỉ tính ở server; client không gửi điểm hay thời gian
- Ưu tiên: Bắt buộc

### AC-QUIZ-13: Kết thúc câu và lộ đáp án
- **Cho** câu i đang mở với 3 người chơi đang kết nối
- **Khi** cả 3 đã nộp trước `deadline`; và (câu khác) chỉ 2 người nộp
- **Thì** câu đóng ngay khi người kết nối cuối cùng nộp, hoặc đúng lúc `deadline` nếu còn người chưa nộp; mọi socket nhận `reveal` gồm cặp đúng, đúng/sai và điểm câu i của từng người, bảng điểm tổng (AC-QUIZ-14); sau 4 s (mặc định, câu hỏi mở 92) phát câu i + 1, hết câu cuối thì sang AC-QUIZ-15. Giao diện tô xanh 2 ô đúng, tô đỏ ô sai người chơi đã chọn
- Ưu tiên: Bắt buộc

### AC-QUIZ-14: Bảng điểm trực tiếp
- **Cho** phòng có 12 người chơi sau câu i
- **Khi** nhận `reveal`
- **Thì** bảng điểm xếp theo tổng điểm giảm dần, rồi tổng thời gian của các câu trả lời đúng tăng dần, rồi thứ tự vào phòng; mỗi người thấy 10 hạng đầu và dòng của chính mình (tô nổi, kèm hạng) dù ngoài top 10; người đang rớt mạng vẫn có tên trong bảng
- Ưu tiên: Bắt buộc

### AC-QUIZ-15: Bảng xếp hạng chung cuộc
- **Cho** câu cuối đã lộ đáp án
- **Khi** ván kết thúc
- **Thì** mọi socket nhận `final` với toàn bộ bảng xếp hạng (cách xếp như AC-QUIZ-14), số câu đúng và tổng điểm từng người; giao diện hiện 🥇🥈🥉 cho 3 hạng đầu, tô dòng của mình, nút "Chơi lại" cho chủ phòng; kết quả được ghi vào lịch sử (AC-QUIZ-18)
- Ưu tiên: Bắt buộc

### AC-QUIZ-16: Rớt mạng và vào lại
- **Cho** U2 đang chơi, đã nộp câu 2, rớt mạng ở câu 3 và kết nối lại ở câu 4 lúc còn 8 s
- **Khi** U2 gửi `join` với cùng UUID
- **Thì** U2 nhận trạng thái hiện tại: câu 4 với `deadline` gốc (còn 8 s), điểm tổng đã có; câu 3 không nộp tính 0; nickname và hạng giữ nguyên; nếu U2 đã nộp câu đang mở thì nhận lại `answered`. Cùng UUID mở socket thứ hai thì socket cũ bị đóng, chỉ socket mới nhận tin
- Ưu tiên: Bắt buộc

### AC-QUIZ-17: Chơi một mình offline (Q9, Q14)
- **Cho** phòng P ở phòng chờ chỉ có chủ phòng U1
- **Khi** U1 bấm "Bắt đầu"; rồi mất mạng giữa ván; rồi tải lại trang ở câu 3; rồi chơi hết
- **Thì** server khóa P (từ đó `join` của người khác nhận `already_started`) và trả gói đề một lần (cùng luật AC-QUIZ-08/09); trong gói, đáp án mỗi câu không đọc thẳng được (không có trường nào chứa id hay tên của cặp đúng ở dạng rõ; đáp án là băm của cặp id đã sắp xếp kèm mã phòng, client kiểm bằng cách băm lựa chọn của người chơi). Client tự chạy đồng hồ, chấm điểm theo AC-QUIZ-12 với giờ máy, lộ đáp án và bảng kết quả, không cần WebSocket hay mạng; tải lại trang thì chơi tiếp từ câu 3 với điểm đã có (gói đề và tiến độ lưu khóa `laumeme:` - AC-SUBPATH-08). Hết ván: hiện bảng kết quả một người; không ghi lịch sử trên server lẫn trên máy, gói đề và tiến độ cục bộ bị xóa khi rời màn kết quả
- Ưu tiên: Bắt buộc

### AC-QUIZ-18: Lưu lịch sử ván nhiều người (Q7, Q11)
- **Cho** ván nhiều người (≥ 2 người lúc bắt đầu) của phòng P vừa kết thúc
- **Khi** server ghi lịch sử
- **Thì** D1 có đúng 1 dòng ván (mã phòng, số thứ tự ván, version nội dung, số câu, số giây, thời điểm bắt đầu, kết thúc) và 1 dòng mỗi người chơi (UUID, nickname lúc chơi, tổng điểm, số câu đúng, hạng), ghi trong một `DB.batch`; ghi lại lần hai (alarm chạy lại, lỗi mạng) không tạo dòng trùng; ván bị hủy giữa chừng (mọi người rời, AC-QUIZ-23) không ghi. Không lưu từng câu trả lời. Lịch sử không tính vào Daily, streak, Công thức gia truyền hay bảng xếp hạng nào khác
- Ưu tiên: Bắt buộc

### AC-QUIZ-19: Xem lịch sử của mình (Q12)
- **Cho** UUID U đã chơi 3 ván nhiều người, UUID U' chưa chơi ván nào
- **Khi** gửi `GET /api/quiz/history?uuid=U`; với U'; và mở mục "Lịch sử mQuiz"
- **Thì** U nhận 200 với 3 ván mới nhất trước: thời điểm, số người chơi, điểm và hạng của U, link phòng; tối đa 20 ván mỗi trang, có con trỏ trang sau; U' nhận 200 danh sách rỗng và giao diện hiện "Bạn chưa chơi ván mQuiz nào"; UUID sai định dạng trả 400. Bấm một ván mở bảng chung cuộc (AC-QUIZ-20)
- Ưu tiên: Bắt buộc

### AC-QUIZ-20: Xem bảng chung cuộc qua link phòng cũ (Q12)
- **Cho** phòng P đã kết thúc ván 1 và ván 2 (chơi lại), ai cũng có link
- **Khi** gửi `GET /api/quiz/rooms/{P}` (hoặc mở link) không kèm UUID
- **Thì** trả 200 `state: "finished"` với bảng chung cuộc của ván mới nhất (nickname, điểm, số câu đúng, hạng), và danh sách các ván trước để xem; không trả UUID của ai; phòng mà phòng chờ đã mở lại để chơi tiếp (AC-QUIZ-24) thì trả `lobby` kèm ván gần nhất
- Ưu tiên: Bắt buộc

### AC-QUIZ-21: Dọn lịch sử sau 90 ngày (Q13)
- **Cho** ván kết thúc ngày D
- **Khi** tác vụ dọn hằng ngày (cùng cron AC-PRIV-06) chạy ngày D + 90 và D + 91
- **Thì** ván còn ở D + 90, bị xóa (cả dòng ván lẫn dòng người chơi) ở lần chạy đầu tiên sau D + 90 ngày; sau đó `GET` link phòng trả 404 và ván không còn trong lịch sử của ai
- Ưu tiên: Bắt buộc

### AC-QUIZ-22: Lịch sử trong xem/xuất/xóa dữ liệu (PRIV)
- **Cho** UUID U có 2 ván trong lịch sử cùng U2
- **Khi** U xem/xuất dữ liệu (AC-PRIV-08); U xóa dữ liệu (AC-PRIV-05)
- **Thì** bản xuất có các ván của U (mã phòng, thời điểm, nickname lúc chơi, điểm, hạng); xóa dữ liệu thì dòng của U trong các ván bị bỏ UUID và đổi nickname thành "Thực khách ẩn danh", điểm và hạng giữ nguyên để bảng của U2 không đổi (câu hỏi mở 88, chốt 2026-10-28); `GET /api/quiz/history?uuid=U` sau đó trả rỗng. Trang chính sách (AC-PRIV-01) nêu lịch sử mQuiz: dữ liệu (nickname, điểm), ai xem được (người có link phòng), giữ 90 ngày
- Ưu tiên: Bắt buộc

### AC-QUIZ-23: Hủy phòng không ai dùng
- **Cho** phòng P không còn socket nào kết nối
- **Khi** đã 5 phút (câu hỏi mở 92, chốt 2026-10-28) ở phòng chờ, đang chơi, hoặc sau khi kết thúc
- **Thì** Durable Object xóa toàn bộ trạng thái của P (alarm dọn); ván đang chơi dở bị bỏ, không ghi lịch sử; sau đó `GET` link phòng trả 404 nếu P chưa có ván nào trong lịch sử, hoặc `finished` với lịch sử còn lại (AC-QUIZ-20); khi mọi người rời giữa ván, đồng hồ câu vẫn chạy tới hết rồi dừng ở câu kế tiếp chờ người quay lại
- Ưu tiên: Bắt buộc

### AC-QUIZ-24: Chơi lại
- **Cho** phòng P đã kết thúc ván 1, U1 là chủ phòng, U2 còn kết nối
- **Khi** U1 bấm "Chơi lại"; U2 bấm (không phải chủ phòng)
- **Thì** P về phòng chờ với người đang kết nối, nhận người mới qua link như AC-QUIZ-04 (mặc định, câu hỏi mở 91), điểm về 0; bắt đầu lại thì ván 2 dùng seed mới (đề khác ván 1 khi pool đủ); `GET` link phòng vẫn xem được bảng ván 1 (AC-QUIZ-20); U2 nhận `error { code: "not_host" }`
- Ưu tiên: Bắt buộc

### AC-QUIZ-25: Chống lạm dụng WebSocket
- **Cho** socket đã `join`
- **Khi** gửi tin lớn hơn 1 KB; gửi hơn 10 tin trong 1 giây; gửi JSON hỏng hoặc `type` lạ; mở WebSocket tới phòng không tồn tại
- **Thì** tin quá lớn hoặc quá nhanh: socket bị đóng mã 1008, người chơi coi như rớt mạng (vào lại được, AC-QUIZ-16); JSON hỏng hoặc `type` lạ: nhận `error { code: "bad_request" }`, socket giữ; phòng không tồn tại: nâng cấp WebSocket bị từ chối với 404 problem+json. Log không chứa UUID thô, IP hay nickname (AC-PRIV-07)
- Ưu tiên: Bắt buộc

### AC-QUIZ-26: Lối vào và màn hình
- **Cho** thực khách ở trang game
- **Khi** mở tab "mQuiz" (cạnh "Bàn lẩu" và "Bảng xếp hạng", AC-DAILY-17); chưa đồng ý gửi dữ liệu thì bấm "Tạo phòng"; bấm "Sao chép link" ở phòng chờ; xem trên khung nhìn 375 px
- **Thì** tab có nút "Tạo phòng" (chọn số câu 5/10/15, số giây 10/20/30, mặc định 10 và 20) và mục "Lịch sử mQuiz"; chưa đồng ý thì hiện lời mời đồng ý (AC-PRIV-02), không gửi gì; "Sao chép link" chép link tuyệt đối của phòng và báo "Đã chép" (dùng chia sẻ hệ thống nếu có, như SHARE); màn câu hỏi hiện meme đề, 4 ô lựa chọn, đồng hồ, số câu, nút "Chốt" vừa trong khung nhìn 375 px không cuộn ngang; chuyển tab khi đang ở phòng không làm rời phòng (socket giữ)
- Ưu tiên: Bắt buộc

### AC-QUIZ-27: Đo chỉ số mQuiz
- **Cho** thực khách đã đồng ý đo chỉ số
- **Khi** tạo phòng; một ván nhiều người hoặc một mình kết thúc
- **Thì** hàng đợi sự kiện (AC-METRIC-02) gửi `quiz_room_created` và `quiz_game_finished { players, questions, solo }`; tổng hợp chỉ số có số phòng tạo và số ván xong mỗi ngày
- Ưu tiên: Tùy chọn

### AC-QUIZ-28: Thẻ chia sẻ kết quả ván (Q10)
- **Cho** ván đã kết thúc
- **Khi** bấm "Chia sẻ kết quả"
- **Thì** tạo thẻ chữ (dán được lên Facebook/Zalo/Messenger) gồm hạng, điểm, số câu đúng / tổng và link phòng; không có đề hay đáp án
- Ưu tiên: Tùy chọn
