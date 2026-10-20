# 0001 - Golden path py-ts-cloudflare cho dự án tải thấp, chi phí $0

- Trạng thái: Đã chấp nhận
- Ngày: (ngày khởi tạo dự án)

## Bối cảnh
Dự án cá nhân hoặc sản phẩm thử nghiệm: một người làm, cần lên mạng nhanh, chi phí vận hành gần 0, có xử lý theo lô (crawl, LLM) chạy định kỳ.

## Quyết định
- Một Cloudflare Worker (TypeScript) phục vụ cả web tĩnh (Workers static assets, thư mục `web/dist`) lẫn API `/api/*`: một lần deploy, một lệnh rollback, cùng origin nên không cần CORS cho web của mình.
- Dữ liệu trong D1 (SQLite). Migration đánh số `NNNN_*.sql`, chỉ thêm (expand-only) để rollback code luôn an toàn.
- Việc theo lô viết bằng Python, chạy trên GitHub Actions (cron), đẩy kết quả qua API hoặc `wrangler` với token chỉ có quyền cần thiết.
- Không có đăng nhập ở golden path; trang quản trị bảo vệ bằng token trong secret.

## Hệ quả
- Production là cấu hình top-level của `wrangler.jsonc`: `wrangler deploy` không có `--env` là deploy production. Plugin dk chặn agent làm việc đó.
- Giới hạn free tier (số request, CPU, dung lượng D1, số file static) phải kiểm tra lại khi lập kế hoạch tải.
- D1 không có RLS: cách ly dữ liệu (nếu có) bằng truy vấn; mọi SQL dùng `prepare(...).bind(...)`.

## Phương án đã loại
- Cloudflare Pages + Functions: tách 2 nơi deploy và rollback; Cloudflare hướng dự án mới sang Workers.
- VM + Docker Compose (golden path Java): tốn công vận hành và tiền máy chủ cho một sản phẩm thử nghiệm.
