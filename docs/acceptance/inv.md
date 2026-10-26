# Bất biến nội dung và trò chơi (INV)

> Thuộc tính phải đúng với **mọi** dữ liệu, không chỉ một ví dụ. Kiểm trên **bộ dữ liệu vàng** của pipeline (`pipeline/tests/golden/`): lõi classic `noi-dung-loi.json` + đồ thị tổng hợp sinh từ generator có seed cố định, kèm `expected.yaml` tính độc lập với code sản phẩm. Không dùng dữ liệu người chơi thật.
> Pipeline chạy các kiểm tra AC-INV-01..07, 10 trước khi deploy mỗi đợt; vi phạm ⇒ đợt thất bại (AC-PIPE-11). AC-INV-12 cũng chạy mỗi đợt nhưng chỉ cảnh báo.

### AC-INV-01: Ghép đối xứng
- **Cho** mọi cặp phần tử (A, B) trong graph
- **Khi** tra A + B và B + A
- **Thì** hai kết quả giống nhau (cùng có hoặc cùng không có)
- Ưu tiên: Bắt buộc

### AC-INV-02: Mỗi cặp tối đa một kết quả
- **Cho** mọi tập công thức đang hoạt động
- **Khi** gom theo cặp không thứ tự đã `fold`
- **Thì** mỗi cặp có tối đa 1 công thức
- Ưu tiên: Bắt buộc

### AC-INV-03: Mọi phần tử hoạt động đều tới được, depth = BFS
- **Cho** mọi graph sắp deploy
- **Khi** chạy BFS từ 4 phần tử khởi đầu chỉ qua công thức và phần tử đang hoạt động
- **Thì** mọi phần tử đang hoạt động đều tới được và `depth` lưu = độ dài đường ngắn nhất; phần tử mất đường tới (do ẩn/chặn) bị đánh dấu không hoạt động trong graph đó và vào hàng chờ nối lại
- Ưu tiên: Bắt buộc

### AC-INV-04: Graph không lộ, không giải mã được khi thiếu đầu vào
- **Cho** mọi graph đã xuất và mọi công thức A + B = C
- **Khi** quét file graph và thử giải mã mục (A, B) bằng (A, X) với mọi X ≠ B trong tập phần tử
- **Thì** file không chứa tên/emoji của phần tử depth ≥ 1 dạng đọc được; mọi lần giải mã thiếu đúng cặp đều thất bại
- Ưu tiên: Bắt buộc

### AC-INV-05: Pipeline idempotent
- **Cho** mọi đầu vào đợt (ảnh chụp kho, kết quả crawl, phản hồi LLM đã lưu, `batch_at`)
- **Khi** chạy đợt 2 lần
- **Thì** graph và manifest giống hệt từng byte
- Ưu tiên: Bắt buộc

### AC-INV-06: Đợt lỗi không đổi bản đang chạy
- **Cho** lỗi được chèn vào từng bước của đợt (mỗi bước một lần chạy)
- **Khi** đợt kết thúc
- **Thì** ở mọi trường hợp, manifest hiện hành và nội dung phục vụ người chơi giữ nguyên
- Ưu tiên: Bắt buộc

### AC-INV-07: Không nội dung hoạt động nào vi phạm danh mục cấm
- **Cho** mọi phần tử và công thức đang hoạt động sau đợt
- **Khi** chạy lại lớp 1 (từ cấm + bí danh bị chặn + tên bị quản trị chặn) trên tên, emoji, gợi ý
- **Thì** không có phần tử/công thức nào khớp
- Ưu tiên: Bắt buộc

### AC-INV-08: First Discovery chỉ cho công thức có thật
- **Cho** mọi bộ (a, b, result) không phải công thức đang hoạt động (sinh ngẫu nhiên có seed từ tập phần tử)
- **Khi** gửi khám phá
- **Thì** server luôn trả 422 và không ghi gì
- Ưu tiên: Bắt buộc

### AC-INV-09: Đủ 3 báo cáo từ 3 UUID khác nhau ⇒ không còn hiện
- **Cho** mọi chuỗi báo cáo (thứ tự bất kỳ, có trùng UUID) cho phần tử P
- **Khi** số UUID khác nhau báo cáo `target: element` cho P (chưa được bỏ qua) đạt 3
- **Thì** P nằm trong danh sách chặn; P không hiện cho người chơi; dưới 3 thì P không bị tự ẩn
- Ưu tiên: Bắt buộc

### AC-INV-10: Món đặc biệt luôn hợp lệ
- **Cho** mọi manifest đã xuất
- **Khi** kiểm Món đặc biệt
- **Thì** món có depth trong [4, 8], tới được, đang hoạt động; món admin chỉ định (AC-DAILY-19) được miễn điều kiện depth nhưng vẫn phải tới được và đang hoạt động (chốt 2026-10-26)
- Ưu tiên: Bắt buộc

### AC-INV-11: Bảng xếp hạng chỉ có kết quả hợp lệ (cập nhật 2026-10-21)
- **Cho** mọi kết quả Daily đã lưu
- **Khi** kiểm lại cặp đã ghép với graph của version đó
- **Thì** mọi cặp (a, b) đều là công thức có thật ra đúng món đích theo AC-DAILY-06; mọi `solved_at` ≥ `batch_at` của mẻ và mỗi kết quả thuộc một tài khoản còn tồn tại
- Ưu tiên: Bắt buộc

### AC-INV-12: Tỉ lệ ghép trượt khi chơi ngẫu nhiên
- **Cho** graph sắp deploy và bộ mô phỏng chơi ngẫu nhiên (1 000 ván, seed cố định, mỗi ván 100 lượt chọn ngẫu nhiên 2 phần tử từ Đĩa hiện có)
- **Khi** chạy mô phỏng
- **Thì** tỉ lệ trượt trung bình 20 lượt đầu ≤ 45 % và cả ván ≤ 70 %; không đạt thì đợt vẫn đăng nhưng báo cáo đợt cảnh báo (mặc định - lõi hiện tại ≈ 41 % / ≈ 67 %)
- Ưu tiên: Bắt buộc
