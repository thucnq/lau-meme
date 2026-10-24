# 0014 - Tự gia hạn token Threads bằng workflow riêng và PAT chỉ ghi secret

- Trạng thái: Đề xuất
- Ngày: 2026-10-24
- Nguồn: AC-PIPE-17..20, AC-SUBPATH-13; câu hỏi mở 65, 66

## Bối cảnh
- Nguồn Threads (AC-PIPE-17) dùng token người dùng dài hạn của Meta. Token sống 60 ngày; gia hạn được khi đã cấp ít nhất 24 giờ và chưa hết hạn, mỗi lần gia hạn tính lại 60 ngày. Hết hạn thì phải đăng nhập lại bằng tay (OAuth), không gia hạn được.
- Token nằm trong GitHub Secret `THREADS_ACCESS_TOKEN` của environment `staging` và `production-no-approval`. `GITHUB_TOKEN` của workflow không có quyền ghi secret.
- Pipeline giữ logic thuần, adapter mạng tách riêng và mock trong test. Token không được lộ trong log, báo cáo đợt hay Issue (AC-PIPE-13).
- Meta đã đổi host API sang `graph.threads.com` (AC-PIPE-18).

## Quyết định
- **Lệnh riêng** `python -m lau_meme_pipeline.threads_token` (module `threads_token.py`):
  - Gọi `GET https://graph.threads.com/refresh_access_token?grant_type=th_refresh_token` qua adapter HTTP sẵn có (chỉ HTTPS, timeout như crawl).
  - Thành công: ghi token mới vào file `THREADS_TOKEN_OUT` (quyền 600), stdout chỉ in số ngày còn lại.
  - Lỗi: không tạo file, in mã lỗi, exit 1. Thiếu token: bỏ qua, exit 0.
  - Thông báo lỗi dựng từ mã HTTP/loại lỗi, không chép URL hay thân phản hồi, vì URL chứa token.
- **Workflow riêng** `threads-token.yml` (bản ở `docs/dev/workflows/`, người chép vào `.github/workflows/`), lịch thứ Hai 02:00 UTC + chạy tay, tách khỏi `batch.yml`:
  - Đọc token từ environment `staging`; một token dùng chung cho hai environment (câu hỏi mở 65).
  - Ghi lại bằng `gh secret set THREADS_ACCESS_TOKEN --env <env> < "$THREADS_TOKEN_OUT"` với `GH_TOKEN: ${{ secrets.GH_SECRETS_TOKEN }}`, rồi xóa file.
  - Job lỗi thì `gh issue create` "Threads token: gia hạn lỗi" kèm link run.
  - Mỗi tuần một lần: đủ xa mốc 24 giờ, và token vẫn còn khoảng 7 tuần nếu vài lần liền bị lỗi.
- **`GH_SECRETS_TOKEN`:** fine-grained PAT chỉ cho repo lau-meme, quyền `Secrets: Read and write`, hạn 1 năm. Issue lỗi mở bằng `GITHUB_TOKEN` của workflow (`permissions: issues: write`), không dùng PAT, chủ dự án tạo và giữ. Chỉ workflow `threads-token.yml` đọc secret này.
- **Cảnh báo 0 bài (AC-PIPE-20):** adapter Threads trả thêm cờ "mọi từ khóa 200 nhưng 0 bài". `batch.py` hiện thành một dòng cảnh báo cạnh dòng "thiếu cấu hình". Đây không phải lỗi nguồn.
- **Trang chính sách (AC-SUBPATH-13):** trong `asset()` của Worker, `GET`/`HEAD` có đường dẫn `<base>/chinh-sach` hoặc `<base>/chinh-sach/` luôn nhận `index.html`, không cần `isNavigation`. Mọi đường dẫn khác giữ nguyên.
- Không thêm bảng, endpoint hay dịch vụ trả phí.

## Hệ quả
- Một PAT có quyền ghi secret của repo là bí mật mạnh: ai lấy được nó thì thay được mọi secret. Phạm vi chỉ một repo và hạn 1 năm. Hết hạn thì workflow lỗi và mở Issue, chủ dự án tạo PAT mới (runbook).
- Hai environment dùng chung một token Threads, nên hạn mức 2.200 lượt tìm/24 giờ của tài khoản đó cũng dùng chung.
- Bot của Meta vẫn chỉ thấy HTML có `<div id="root">`, nội dung chính sách do JS vẽ (câu hỏi mở 66). Nếu App Review báo không đọc được thì thêm AC dựng HTML tĩnh.
- Agent không sửa `.github/workflows/`: người chép `threads-token.yml` từ `docs/dev/workflows/` và tạo `GH_SECRETS_TOKEN`.

## Phương án đã loại
- **Gia hạn trong `batch.yml` mỗi mẻ:** mẻ chạy 12 lần/ngày ở staging. Phải đưa quyền ghi secret vào job chạy code crawl và LLM, và lỗi gia hạn làm nhiễu báo cáo đợt.
- **Lưu token trong D1/Worker và để Worker tự gia hạn bằng Cron:** pipeline phải đọc token qua API (token pipeline lại cầm thêm bí mật của bên thứ ba), và phải có thêm cột/bảng cùng đường đọc riêng. Nặng hơn nhu cầu.
- **Chỉ nhắc người gia hạn tay mỗi 50 ngày:** đơn giản, nhưng quên một lần là phải làm lại OAuth. Vẫn ghi trong runbook làm đường dự phòng.
- **GitHub App thay PAT:** quyền chặt hơn, nhưng phải cài app và ký JWT trong workflow. Quá nặng cho dự án một người.
