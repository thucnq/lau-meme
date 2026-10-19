# Runbook vận hành — lau-meme

## Bí mật
Không bí mật nào nằm trong repo (repo có thể public).

| Bí mật | Nơi lưu | Đặt bằng |
|---|---|---|
| `ADMIN_TOKEN` | Cloudflare secret của Worker | `openssl rand -base64 32 \| npx wrangler secret put ADMIN_TOKEN --env staging` (production: người tự chạy, bỏ `--env`) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Secrets | Settings → Secrets and variables → Actions |
| Khóa API của pipeline (LLM, nguồn dữ liệu) | GitHub Secrets | như trên |
| Biến chạy cục bộ | `worker/.dev.vars` (gitignore) | chép từ `worker/.dev.vars.example` |

## Môi trường
- `staging`: `wrangler.jsonc` → `env.staging`. Agent được deploy bằng `/dk:ship staging`.
- Production: cấu hình top-level. **Chỉ người làm**: `npx wrangler d1 migrations apply DB --remote` rồi `npx wrangler deploy` (trong `worker/`, sau khi `npm --prefix web run build`), hoặc workflow `deploy` với environment `production` có người duyệt.

## Triển khai và quay lại
- Staging: `/dk:ship staging` (build web, migrate D1, deploy, kiểm tra `/api/health`, tự rollback khi lỗi).
- Quay lại bản trước (chỉ code): `bash <plugin>/scripts/deploy-cf.sh staging --rollback [version-id]`; production: `npx wrangler rollback [version-id]`.
- Rollback **không** quay lại dữ liệu D1. Khôi phục dữ liệu bằng D1 Time Travel — việc của người, kiểm tra cú pháp hiện hành của `wrangler d1 time-travel` trước khi chạy.

## Vận hành
- Log thời gian thực: `npx wrangler tail --env staging` (production: bỏ `--env`).
- Xem dữ liệu: `npx wrangler d1 execute DB --env staging --remote --command "select count(*) from app_meta"`.

## Sự cố thường gặp
| Triệu chứng | Nguyên nhân thường gặp | Xử lý |
|---|---|---|
| `/api/*` trả 500, log `no such table` | Chưa chạy migration trên môi trường đó | `npx wrangler d1 migrations apply DB --env <env> --remote` |
| Trang trắng sau deploy | Quên build web trước khi deploy | `npm --prefix web run build` rồi deploy lại |
| Workflow cron chạy trễ | GitHub Actions không bảo đảm đúng giờ | Bình thường; giao diện dựa vào thời điểm trong dữ liệu, không vào giờ lý thuyết |
