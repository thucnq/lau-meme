# Runbook vận hành - lau-meme

## Bí mật
Không bí mật nào nằm trong repo (repo có thể public).

| Bí mật | Nơi lưu | Đặt bằng |
|---|---|---|
| `ADMIN_TOKEN` | Cloudflare secret của Worker (mỗi môi trường một giá trị) + trình quản lý mật khẩu của người quản trị | `docs/dev/huong-dan-tai-khoan.md` mục 4.2 |
| `PIPELINE_TOKEN` | Cloudflare secret của Worker **và** GitHub Environment secret (`staging`, `production`, `production-no-approval`) - hai nơi phải cùng giá trị | `docs/dev/huong-dan-tai-khoan.md` mục 4.2 |
| `IP_HASH_KEY` | Cloudflare secret của Worker (mỗi môi trường một giá trị) | `docs/dev/huong-dan-tai-khoan.md` mục 4.2 |
| `ACCOUNT_HASH_KEY` | Cloudflare secret của Worker (mỗi môi trường một giá trị), băm `sub` Google thành `account.sub_hash` (ADR 0010) | `docs/dev/huong-dan-tai-khoan.md` mục 4.2 |
| `API_BASE_URL`, `BANNED_WORDS` | GitHub Environment secret | `docs/dev/huong-dan-tai-khoan.md` mục 4.3 |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Secrets | Settings → Secrets and variables → Actions |
| Khóa API của pipeline (LLM, nguồn dữ liệu) | GitHub Secrets | như trên |
| Biến chạy cục bộ | `worker/.dev.vars` (gitignore) | chép từ `worker/.dev.vars.example` |

`GOOGLE_CLIENT_ID` không phải bí mật: là biến thường trong `worker/wrangler.jsonc` (`vars`), mỗi môi trường một Client ID. Worker dùng Client ID này để kiểm `aud` của ID token.

Web không đọc Client ID từ Worker. `web/src/auth/config.ts` giữ hai Client ID và chọn theo tên miền: `staging.dinoduct.fun` dùng Client ID staging, mọi tên miền khác dùng Client ID production. Biến build `VITE_GOOGLE_CLIENT_ID` (nếu đặt khi build) ghi đè cả hai. Đổi Client ID thì phải sửa đồng thời `wrangler.jsonc` và `web/src/auth/config.ts`.
> TODO(doc): `localhost` (origin đã khai trên client staging theo `docs/dev/huong-dan-tai-khoan.md` mục 7.3) rơi vào nhánh production của `clientIdFor`. Cần xác nhận cách chạy đăng nhập Google trên máy local (đặt `VITE_GOOGLE_CLIENT_ID` khi build?).

## Môi trường
Game chạy dưới đường dẫn con (ADR 0007). Tiền tố nằm ở `base-path.json`.

| Môi trường | Địa chỉ | Route Worker | Kiểm tra sức khỏe |
|---|---|---|---|
| Production | https://dinoduct.fun/lau-meme/ | `dinoduct.fun/lau-meme*` | `/lau-meme/api/health` |
| Staging | https://staging.dinoduct.fun/lau-meme/ | `staging.dinoduct.fun/lau-meme*` | `/lau-meme/api/health` |
| Quản trị (production) | https://laumeme-admin.dinoduct.fun/ | `laumeme-admin.dinoduct.fun/*` | không có; `/api/admin/batches` trả 401 khi không token |
| Quản trị (staging) | https://laumeme-admin-staging.dinoduct.fun/ | `laumeme-admin-staging.dinoduct.fun/*` | không có; `/api/admin/batches` trả 401 khi không token |

Trang quản trị chạy trên host riêng (ADR 0008), cùng Worker, phân biệt bằng biến `ADMIN_HOST` trong `wrangler.jsonc` (mỗi môi trường một giá trị). Trên host game, `/lau-meme/admin*` và `/lau-meme/api/admin/*` trả 404. Bản ghi DNS của hai host quản trị nằm trong `docs/dev/huong-dan-tai-khoan.md` mục 1.

Gốc `https://dinoduct.fun/` được Redirect Rule (không có trong code) chuyển 302 về `/lau-meme/`. `*.workers.dev` vẫn bật để `deploy-cf.sh` kiểm tra sức khỏe. Ở đó mọi đường dẫn ngoài `/lau-meme/` trả 404.
Cấu hình tài khoản lần đầu (DNS, Redirect Rule, SSL, deploy production đầu tiên, kiểm tra nhà mạng và xem trước link) xem `docs/dev/huong-dan-tai-khoan.md`.

- `staging`: `wrangler.jsonc` → `env.staging`. Agent được deploy bằng `/dk:ship staging`.
- Production: cấu hình top-level. **Chỉ người làm**: `npx wrangler d1 migrations apply DB --remote` rồi `npx wrangler deploy` (trong `worker/`, sau khi `npm --prefix web run build`), hoặc workflow `deploy` với environment `production` có người duyệt.

## Triển khai và quay lại
- Staging: `/dk:ship staging` (build web, migrate D1, deploy, kiểm tra `/lau-meme/api/health`, tự rollback khi lỗi).
- Quay lại bản trước (chỉ code): `bash <plugin>/scripts/deploy-cf.sh staging --rollback [version-id]`; production: `npx wrangler rollback [version-id]`.
- Rollback **không** quay lại dữ liệu D1. Khôi phục dữ liệu bằng D1 Time Travel - việc của người, kiểm tra cú pháp hiện hành của `wrangler d1 time-travel` trước khi chạy.

## Vận hành
- Log thời gian thực: `npx wrangler tail --env staging` (production: bỏ `--env`).
- Xem dữ liệu: `npx wrangler d1 execute DB --env staging --remote --command "select count(*) from app_meta"`.
- Dọn dữ liệu cá nhân (AC-PRIV-06): Cron Trigger của Worker `0 20 * * *` (03:00 GMT+7), khai báo cả production lẫn `env.staging` trong `worker/wrangler.jsonc`. Mỗi lần chạy ghi 1 dòng log `cleanup {...}` chỉ có số dòng (IP băm > 7 ngày đặt NULL, sự kiện > 90 ngày, bộ đếm hết hạn, audit > 12 tháng, đồng ý của UUID đã xóa > 1 năm).
- Từ cấm cho nickname (ADR 0005, AC-DISC-03): mỗi mẻ, pipeline đọc GitHub Secret `BANNED_WORDS` (mỗi dòng một từ) và thay toàn bộ nguồn `wordlist` trong D1; secret rỗng thì giữ nguyên danh sách cũ. Workflow `batch.yml` phải truyền `BANNED_WORDS: ${{ secrets.BANNED_WORDS }}` vào bước "Mẻ nhúng" (người sửa - workflow được guard bảo vệ). Log và báo cáo đợt không bao giờ in từ cấm.
- Mẻ `full` (ADR 0009, 0011): crawl + Gemini, kho pipeline (phần tử trend, hàng chờ, cache LLM) lưu trong bảng `pipeline_store` cùng version. **Đã chạy `full` thì đừng để cron chạy `core`**: mẻ `core` chỉ đăng lõi, meme trend biến khỏi graph cho tới mẻ `full` kế tiếp (kho của version `core` là rỗng). Bật `full` cho cron bằng variable `BATCH_MODE=full` (`docs/dev/huong-dan-tai-khoan.md` mục 8). Thiếu `GEMINI_API_KEY` ⇒ đợt `full` lỗi ở bước `llm`, bản hiện hành giữ nguyên. Hết quota Gemini ⇒ đợt vẫn đăng, phần chưa xử lý vào hàng chờ, Issue ghi "hết quota".
- Phiên đăng nhập (ADR 0010): phiên hết hạn sau 90 ngày không dùng; cùng Cron `0 20 * * *` xóa các dòng `session` đã hết hạn. Bảng xếp hạng chỉ đọc phiên, không gia hạn.
- Đổi nội dung chính sách (`web/src/privacy/PolicyPage.tsx`): tăng `POLICY_VERSION` trong `worker/wrangler.jsonc` (cả staging) và `POLICY.version` trên trang ⇒ mọi người chơi được hỏi đồng ý lại (AC-PRIV-09).

## Sự cố thường gặp
| Triệu chứng | Nguyên nhân thường gặp | Xử lý |
|---|---|---|
| `/lau-meme/api/*` trả 500, log `no such table` | Chưa chạy migration trên môi trường đó | `npx wrangler d1 migrations apply DB --env <env> --remote` |
| Trang trắng sau deploy | Quên build web trước khi deploy | `npm --prefix web run build` rồi deploy lại |
| Ghi đồng ý (`/lau-meme/api/consents`) trả 500, log `IP_HASH_KEY is not configured` | Chưa đặt secret băm IP của môi trường đó (cố ý báo lỗi thay vì lưu IP thô) | Đặt secret theo `docs/dev/huong-dan-tai-khoan.md` |
| Workflow cron chạy trễ | GitHub Actions không bảo đảm đúng giờ | Bình thường; giao diện dựa vào thời điểm trong dữ liệu, không vào giờ lý thuyết |
| `dinoduct.fun` báo lỗi 52x hoặc không phân giải | Thiếu bản ghi DNS proxied cho host, hoặc Redirect Rule bị tắt | Xem `docs/dev/huong-dan-tai-khoan.md` mục 1–2 |
| `/lau-meme` vào được nhưng F5 ở màn hình con ra 404 | Bản deploy cũ (trước ADR 0007) hoặc web build sai thư mục | Build lại web (`web/dist/lau-meme/index.html` phải có) rồi deploy |
| Pipeline báo `HTTP 401` khi đăng mẻ / rollback | `PIPELINE_TOKEN` ở GitHub Environment khác với secret của Worker | Đặt lại cả hai nơi cùng một giá trị (`huong-dan-tai-khoan.md` mục 4.2) |
| Trang quản trị báo "Thiếu hoặc sai token" dù dán đúng | Chưa đặt `ADMIN_TOKEN` cho môi trường đó, hoặc dán token của môi trường khác | `npx wrangler secret list [--env staging]` phải có `ADMIN_TOKEN`; đặt lại theo mục 4.2 |
| Trang quản trị trả 429 "Thử sai quá nhiều lần" | 5 lần sai trong 1 phút từ cùng IP ⇒ khóa 15 phút, kể cả token đúng (AC-ADMIN-02) | Chờ hết `Retry-After`. Không có lệnh gỡ khóa; xóa dòng `admin-lock:%` trong `rate_counter` chỉ khi chắc không phải bị dò |
| Pipeline báo `HTTP 404` khi đăng mẻ / rollback | Secret `API_BASE_URL` thiếu tiền tố | Đặt `https://dinoduct.fun/lau-meme` (staging: `https://staging.dinoduct.fun/lau-meme`) |
| Pipeline báo `URL phải có dạng https://<host>...` | `API_BASE_URL` dùng `http` cho tên miền thật (chỉ `localhost` được `http`) | Đổi sang `https://...`; chạy cục bộ xem `docs/dev/setup.md` |
| Đăng nhập Google trả 500, log có `ACCOUNT_HASH_KEY is not configured` hoặc `GOOGLE_CLIENT_ID is not configured` | Chưa đặt secret `ACCOUNT_HASH_KEY` hoặc biến `GOOGLE_CLIENT_ID` cho môi trường đó (Worker đóng, không mở phiên) | `npx wrangler secret list [--env staging]` phải có `ACCOUNT_HASH_KEY`; đặt theo `docs/dev/huong-dan-tai-khoan.md` mục 4.2; kiểm `vars` trong `worker/wrangler.jsonc` |
| Đăng nhập Google luôn trả 401 | `GOOGLE_CLIENT_ID` của Worker khác Client ID mà web chọn cho tên miền đó trong `web/src/auth/config.ts` (sai `audience`) | Đối chiếu `vars.GOOGLE_CLIENT_ID` của môi trường (`wrangler.jsonc`) với Client ID trong `web/src/auth/config.ts`; staging phải dùng Client ID staging, production dùng Client ID production |
| Nút Google báo `origin_mismatch` hoặc `The given origin is not allowed` | Origin của tên miền chưa có trong Authorized JavaScript origins của Client ID mà web chọn theo host (staging: client staging; còn lại: client production), hoặc origin mới chưa có hiệu lực | Thêm origin (chỉ scheme + host, không có `/lau-meme`) vào đúng client trong Google Cloud Console; đợi 5 phút tới vài giờ rồi thử lại (`huong-dan-tai-khoan.md` mục 7.3) |
