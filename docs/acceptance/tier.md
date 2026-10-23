# Tiêu chí nghiệm thu - Tier của meme (TIER)

> Thêm 2026-10-23. Component: pipeline (giữ tier trong kho, đưa vào graph), worker (admin gán tier - AC-ADMIN-12), web (màu nền + hình nhỏ).
> Tier do admin gán tay (câu hỏi mở 45). Năm bậc từ thấp tới cao:
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
- **Thì** mọi phần tử lõi, meme crawl mới và meme đóng góp không chọn tier có tier 1 (Xám); P giữ tier 4 qua mọi mẻ sau, pipeline không tự đổi tier; mỗi phần tử trong graph mang tier 1-5 cùng chỗ với tên/emoji (lộ cùng lúc với tên, không lộ thêm gì về phần tử chưa ghép ra - AC-GRAPH-02); graph thiếu tier hoặc tier ngoài 1-5 thì kiểm tra graph thất bại và mẻ không đăng (AC-PIPE-11); rollback trả về tier của bản cũ
- Ưu tiên: Bắt buộc

### AC-TIER-02: Hiển thị tier trên phần tử
- **Cho** 5 phần tử, mỗi tier một phần tử, ở Đĩa nhúng, trên bàn, trong nồi và ở thẻ kết quả khi ghép ra; giao diện sáng và tối (AC-GAME-13)
- **Khi** trang hiện các phần tử
- **Thì** nền của phần tử dùng màu của tier; ở chính giữa mép dưới phần tử có một hình nhỏ đúng hình của tier (tròn, tam giác, thoi, ngũ giác, lục giác) cùng màu đậm hơn; tên phần tử trên nền tier đạt tương phản ≥ 4,5:1 ở cả hai chế độ; hình nhỏ có nhãn cho trình đọc màn hình "Tier <tên>" (vd. "Tier Vàng"); hình nhỏ không che emoji/ảnh và không làm phần tử to hơn (bề rộng ≥ 375 px vẫn như AC-GAME-18); Món đặc biệt chưa giải không lộ tier. Kiểm bằng Vitest browser mode: mỗi tier đúng màu nền và đúng hình (số cạnh của hình SVG)
- Ưu tiên: Bắt buộc

### AC-TIER-03: Graph cũ chưa có tier
- **Cho** client đang giữ graph version cũ (trước khi có TIER) không có trường tier
- **Khi** client hiện phần tử
- **Thì** phần tử hiện như tier 1 (Xám), không lỗi; khi manifest lên version mới có tier thì hiện đúng tier mà không mất tiến độ (AC-GAME-17)
- Ưu tiên: Bắt buộc
