# Tiêu chí nghiệm thu - Tier của meme (TIER)

> Thêm 2026-10-23. Component: pipeline (giữ tier trong kho, đưa vào graph), worker (admin gán tier - AC-ADMIN-12), web (màu nền + hình nhỏ).
> Tier do admin gán tay (câu hỏi mở 45). Cập nhật 2026-10-24: tier **mặc định tính theo độ sâu** (AC-TIER-04), admin vẫn sửa được và giá trị admin gán được giữ (AC-TIER-05); món Vàng/Đỏ phải có ảnh (AC-TIER-04, AC-ART-12). Năm bậc từ thấp tới cao:
>
> | Tier | Tên | Hình | Màu |
> |---|---|---|---|
> | 1 | Xám | Tròn | Xám |
> | 2 | Xanh lá | Tam giác | Xanh lá |
> | 3 | Xanh dương | Thoi | Xanh dương |
> | 4 | Vàng | Ngũ giác | Vàng |
> | 5 | Đỏ | Lục giác | Đỏ |

### AC-TIER-01: Tier mặc định và giữ qua các mẻ
- **Cho** kho lõi vừa nạp (AC-SEED-01); một meme crawl mới; một meme đóng góp vừa duyệt không chọn tier; phần tử P đã được admin gán tier 4
- **Khi** mẻ kế tiếp chạy (`core` hoặc `full`), chạy lại cùng mẻ, và rollback về bản trước (AC-GRAPH)
- **Thì** (cập nhật 2026-10-24) mọi phần tử lõi, meme crawl mới và meme đóng góp không chọn tier có tier tự động theo độ sâu (AC-TIER-04), không còn mặc định Xám cho mọi phần tử; P giữ tier 4 qua mọi mẻ sau, pipeline không tự đổi tier admin đã gán; mỗi phần tử trong graph mang tier 1-5 cùng chỗ với tên/emoji (lộ cùng lúc với tên, không lộ thêm gì về phần tử chưa ghép ra - AC-GRAPH-02); graph thiếu tier hoặc tier ngoài 1-5 thì kiểm tra graph thất bại và mẻ không đăng (AC-PIPE-11); rollback trả về tier của bản cũ
- Ưu tiên: Bắt buộc

### AC-TIER-02: Hiển thị tier trên phần tử
- **Cho** 5 phần tử, mỗi tier một phần tử, ở Đĩa nhúng, trên bàn, trong nồi và ở thẻ kết quả khi ghép ra; giao diện sáng và tối (AC-GAME-13)
- **Khi** trang hiện các phần tử
- **Thì** nền của phần tử dùng màu của tier; hình nhỏ đúng hình của tier (tròn, tam giác, thoi, ngũ giác, lục giác) cùng màu đậm hơn nằm **đè lên đường viền dưới**, căn giữa theo chiều ngang: tâm hình nằm trên đường viền dưới (sai lệch ≤ 2 px theo cả hai chiều), nửa trên trong phần tử, nửa dưới lòi ra ngoài (cập nhật 2026-10-24, góp ý "kéo xuống trung tâm của border bottom"); phần lòi ra không bị khung Đĩa, mặt bàn hay chỗ thả cắt mất; hình nhỏ có viền sáng bao quanh để tách khỏi mặt bàn nhựa và gỗ (AC-GAME-28) ở cả hai chế độ (cập nhật 2026-10-25); (cập nhật 2026-10-25, góp ý "thêm viền để icon và nền không lạc quẻ") phần tử dạng thẻ (`.chip`, ở bàn, Đĩa và món bóng khi kéo) có viền liền **cùng màu** với viền của hình nhỏ của nó; lúc thường màu viền này tối hơn màu viền sáng khi rê (độ sáng tương đối thấp hơn); (cập nhật 2026-10-25, góp ý "border hơi dày, hơi sáng") viền liền dày 1 px (± 0,25 px); màu viền lúc thường (`--color-chip-ring`, dùng chung cho viền thẻ và viền hình nhỏ) là `#a8998a` ở chế độ sáng và `#8a7d72` ở chế độ tối; món trong chỗ thả của nồi cũng có viền này (cùng độ dày, cùng màu) như thẻ ở bàn và Đĩa; khi rê chuột lên phần tử thì viền phần tử và viền hình nhỏ cùng đổi sang màu viền sáng (`--color-badge-ring`: trắng ở chế độ sáng, `#f4eee8` ở chế độ tối); tên phần tử trên nền tier đạt tương phản ≥ 4,5:1 ở cả hai chế độ; hình nhỏ có nhãn cho trình đọc màn hình "Tier <tên>" (vd. "Tier Vàng"); hình nhỏ không che emoji/ảnh và không làm phần tử to hơn (bề rộng ≥ 375 px vẫn như AC-GAME-18); Món đặc biệt chưa giải không lộ tier. Kiểm bằng Vitest browser mode: mỗi tier đúng màu nền và đúng hình (số cạnh của hình SVG)
- Ưu tiên: Bắt buộc

### AC-TIER-03: Graph cũ chưa có tier
- **Cho** client đang giữ graph version cũ (trước khi có TIER) không có trường tier
- **Khi** client hiện phần tử
- **Thì** phần tử hiện như tier 1 (Xám), không lỗi; khi manifest lên version mới có tier thì hiện đúng tier mà không mất tiến độ (AC-GAME-17)
- Ưu tiên: Bắt buộc

### AC-TIER-04: Tier tự động theo độ sâu (thêm 2026-10-24)
- **Cho** phần tử chưa được admin gán tier, độ sâu theo BFS của mẻ (AC-PIPE-07): độ sâu 0, 2, 3, 4, 5, 6, 7, 9; phần tử độ sâu 6 chưa có ảnh (không có `image_key` hoặc ảnh bị chặn); phần tử độ sâu 5 lên độ sâu 3 ở mẻ sau vì có công thức mới ngắn hơn
- **Khi** mẻ chạy (`core` hoặc `full`) và xuất graph
- **Thì** tier tự động: độ sâu 0-2 → 1 Xám; 3 → 2 Xanh lá; 4 → 3 Xanh dương; 5-6 → 4 Vàng; từ 7 trở lên → 5 Đỏ (mặc định - câu hỏi mở 67; với lõi hiện tại: 53 / 62 / 29 / 26 / 4 phần tử); phần tử tính ra Vàng hoặc Đỏ mà chưa có ảnh thì nhận tier 3 Xanh dương cho tới khi có ảnh (luật "Vàng/Đỏ phải có ảnh" - câu hỏi mở 69); tier tự động tính lại mỗi mẻ theo độ sâu và ảnh hiện tại (phần tử lên độ sâu 3 thì về Xanh lá ở mẻ đó); hàm tính tier là hàm thuần của (độ sâu, có ảnh), chạy lại cùng mẻ cho cùng kết quả; báo cáo đợt ghi số phần tử mỗi tier và "Chờ ảnh để lên Vàng/Đỏ: N"
- Ưu tiên: Bắt buộc

### AC-TIER-05: Admin sửa tier và trả về tự động (thêm 2026-10-24)
- **Cho** phần tử P đang ở tier tự động 2; phần tử Q đã được admin gán tier 5
- **Khi** admin gán P = 4 (AC-ADMIN-12), rồi các mẻ sau làm độ sâu của P đổi; admin chọn "Tự động (theo độ sâu)" cho Q
- **Thì** P giữ tier 4 qua mọi mẻ sau dù độ sâu đổi (giá trị admin gán thắng tier tự động); Q quay về tier tự động theo AC-TIER-04 từ mẻ kế tiếp; trang quản trị hiện cho mỗi phần tử: tier hiện tại, nguồn tier ("Tự động" hoặc "Admin gán") và tier tự động sẽ có; mỗi lần đổi ghi audit (trước/sau, kể cả đổi về "Tự động") theo AC-ADMIN-09
- Ưu tiên: Bắt buộc
