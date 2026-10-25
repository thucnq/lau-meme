# Runbook vận hành - lau-meme

## Bí mật
Không bí mật nào nằm trong repo (repo có thể public).

| Bí mật | Nơi lưu | Đặt bằng |
|---|---|---|
| `ADMIN_TOKEN` | Cloudflare secret của Worker (mỗi môi trường một giá trị) + trình quản lý mật khẩu của người quản trị | `docs/dev/huong-dan-tai-khoan.md` mục 4.2 |
| `PIPELINE_TOKEN` | Cloudflare secret của Worker **và** GitHub Environment secret (`staging`, `production`, `production-no-approval`) - hai nơi phải cùng giá trị | `docs/dev/huong-dan-tai-khoan.md` mục 4.2 |
| `IP_HASH_KEY` | Cloudflare secret của Worker (mỗi môi trường một giá trị) | `docs/dev/huong-dan-tai-khoan.md` mục 4.2 |
| `ACCOUNT_HASH_KEY` | Cloudflare secret của Worker (mỗi môi trường một giá trị), băm `sub` Google thành `account.sub_hash` (ADR 0010) | `docs/dev/huong-dan-tai-khoan.md` mục 4.2 |
| `IP_HASH_KEY`, `ACCOUNT_HASH_KEY` của preview | Secret riêng của Worker Previews (`npx wrangler preview base-config secret put <KEY>`), không dùng chung với staging. Preview không cần `ADMIN_TOKEN` và `PIPELINE_TOKEN` | `docs/dev/huong-dan-tai-khoan.md` mục 4.4 |
| `API_BASE_URL`, `BANNED_WORDS` | GitHub Environment secret | `docs/dev/huong-dan-tai-khoan.md` mục 4.3 |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Secrets | Settings → Secrets and variables → Actions |
| Khóa API của pipeline (LLM, nguồn dữ liệu) | GitHub Secrets | như trên |
| `THREADS_ACCESS_TOKEN` (secret), `THREADS_KEYWORDS` (variable) | GitHub Secret và Variable của workflow `batch.yml`; token lấy từ app Meta đã được duyệt quyền tìm theo từ khóa (AC-PIPE-17). Secret `THREADS_ACCESS_TOKEN` được workflow `threads-token` gia hạn và ghi lại mỗi tuần (AC-PIPE-19) | `docs/dev/huong-dan-tai-khoan.md` mục 8, 8.1 |
| `GH_SECRETS_TOKEN` | GitHub Secret của repo: fine-grained PAT chỉ cho repo lau-meme, quyền `Secrets: Read and write`, hạn 1 năm. Chỉ workflow `threads-token` đọc; `GITHUB_TOKEN` không ghi được secret | `docs/dev/huong-dan-tai-khoan.md` mục 8.1 (gia hạn token) |
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

Trang chính sách `/lau-meme/chinh-sach` (và `/lau-meme/chinh-sach/`) trả `index.html` cho mọi GET/HEAD, không cần `Accept: text/html`, để bot App Review của Meta đọc được (AC-SUBPATH-13, ADR 0014). Nội dung do JS vẽ, nên bot đi theo canonical về production chưa chạy (câu hỏi mở 66). URL khai với Meta là `/lau-meme/chinh-sach-tinh` (AC-SUBPATH-14): HTML tĩnh viết sẵn chữ, không script, không canonical hay `og:url`, lấy từ `web/chinh-sach-tinh.html`; tầng assets phục vụ file này, Worker không đổi.

Trang quản trị chạy trên host riêng (ADR 0008), cùng Worker, phân biệt bằng biến `ADMIN_HOST` trong `wrangler.jsonc` (mỗi môi trường một giá trị). Trên host game, `/lau-meme/admin*` và `/lau-meme/api/admin/*` trả 404. Bản ghi DNS của hai host quản trị nằm trong `docs/dev/huong-dan-tai-khoan.md` mục 1.

Gốc `https://dinoduct.fun/` được Redirect Rule (không có trong code) chuyển 302 về `/lau-meme/`. `*.workers.dev` vẫn bật để `deploy-cf.sh` kiểm tra sức khỏe. Ở đó mọi đường dẫn ngoài `/lau-meme/` trả 404.
Cấu hình tài khoản lần đầu (DNS, Redirect Rule, SSL, deploy production đầu tiên, kiểm tra nhà mạng và xem trước link) xem `docs/dev/huong-dan-tai-khoan.md`.

- `staging`: `wrangler.jsonc` → `env.staging`. Agent được deploy bằng `/dk:ship staging`.
- Production: cấu hình top-level. **Chỉ người làm**: `npx wrangler d1 migrations apply DB --remote` rồi `npx wrangler deploy` (trong `worker/`, sau khi `npm --prefix web run build`), hoặc workflow `deploy` với environment `production` có người duyệt. Workers Builds chạy production nên dùng lệnh `npx wrangler versions upload` (không `wrangler deploy`) để production vẫn do người làm kích hoạt.
- Preview (Workers Builds, nhánh không phải production): lệnh `npx wrangler preview`, khối `previews` trong `wrangler.jsonc`. Bind D1 `lau-meme-staging` và R2 `lau-meme-img-staging` (không kế thừa từ top-level hay `env.staging`), `APP_ENV=preview`, không có `ADMIN_HOST` nên trang quản trị tắt. Preview dùng chung dữ liệu staging và không áp migration mới. Đăng nhập Google thường không chạy trên URL preview vì origin chưa được đăng ký; kiểm đăng nhập trên staging.
  - URL preview do Workers Builds cấp theo nhánh: `https://<tên-nhánh>-lau-meme.thucnguyenquy.workers.dev` (dấu `/` trong tên nhánh thành `-`), ví dụ nhánh `docs/release-staging-20261021-1832` → `https://docs-release-staging-20261021-1832-lau-meme.thucnguyenquy.workers.dev`. Game nằm dưới `/lau-meme/`; kiểm tra bằng `/lau-meme/api/health` (phải có `"env":"preview"`). Link cũng có ở cuối log build và trong check "Workers Builds: lau-meme" của PR.
  - Cài đặt build của preview: Root directory `worker`, Build command `npm --prefix ../web ci && npm --prefix ../web run build` (tạo `web/dist` mà `assets.directory` trỏ tới), Deploy/Preview command `npx wrangler preview`. Cài đặt trong tab **Previews Base** chỉ áp cho preview **tạo mới**; preview đã có (nhánh từng build trước đó, ví dụ `feat/art`) giữ bản cài đặt riêng.
  - Dấu hiệu sai cài đặt: check "Workers Builds: lau-meme" của PR đỏ, cài đặt của build là Root directory `/`, Build command `None`; log báo `missing a previews block` và `npx` phải tải wrangler về (lệnh không chạy trong `worker/`).
  - Phân biệt nhanh bằng link "Details" của check: build đúng nằm ở `.../lau-meme/production/previews/<tên-nhánh>/builds/<id>`; build dùng cài đặt cũ nằm ở `.../lau-meme/production/builds/<id>` (không có `previews/`). Ví dụ nhánh `docs/preview-url`: PR #48, #49 ở `/builds/` (đỏ), sau khi sửa cài đặt riêng của nhánh thì PR #50 ở `/previews/docs-preview-url/` (xanh). Nhánh tạo mới sau khi bật Previews (`docs/previews-base-note`, PR #51) vào thẳng `/previews/`.
  - Cách sửa (người làm trên dashboard, đã dùng cho nhánh `docs/preview-url`, PR #50):
    1. Mở Worker `lau-meme`, đổi ô **Production ⌄** ở đầu trang sang preview của nhánh lỗi.
    2. Vào **Settings > Build**, sửa ba ô cho khớp cài đặt trên. Kiểm tra luôn tab **Previews Base** để nhánh mới không lỗi lại.
    3. Cách khác khi không tìm thấy nhánh trong ô **Production ⌄**: tạo nhánh mới từ nhánh lỗi (`git switch -c <tên-mới>`), push và mở PR mới; nhánh mới nhận cài đặt Previews Base.
    4. Push một commit mới lên nhánh (commit rỗng cũng được: `git commit --allow-empty -m "chore: chạy lại build preview"`). **Không** bấm Retry build cũ: Retry dùng lại cài đặt cũ.
    5. Khi check xanh, mở `https://<tên-nhánh>-lau-meme.thucnguyenquy.workers.dev/lau-meme/api/health`, phải có `"env":"preview"`; `/lau-meme/` trả 200.

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
- Ảnh minh họa (ADR 0012): mẻ `full` vẽ tối đa 20 ảnh/đợt bằng Workers AI, Gemini kiểm, tải qua `PUT /api/pipeline/images/{key}`. Gỡ ảnh xấu đã lên: chặn ảnh trên trang quản trị (client thôi tải, AC-ART-07), rồi `npx wrangler r2 object delete lau-meme-img/img/<key>.webp` và purge URL `/lau-meme/img/<key>.webp` (Caching → Custom Purge) vì ảnh cache bất biến 1 năm.
- Tier và ảnh Vàng/Đỏ (AC-TIER-04, AC-ART-12): tier tự động tính trong pipeline mỗi mẻ theo độ sâu, không cần cấu hình. Mẻ `full` vẽ ưu tiên các món Vàng/Đỏ chưa có ảnh, trong hạn 20 ảnh/đợt. Theo dõi trong báo cáo đợt: dòng "Chờ ảnh để lên Vàng/Đỏ: N" và "Vàng/Đỏ thiếu ảnh: <tên>".
- Đóng góp meme (ADR 0013): pipeline đọc đề xuất đã duyệt qua `GET /api/pipeline/state` (trường `contributions`) và đưa vào graph ở mẻ kế tiếp; không có Cron hay biến môi trường riêng. Đề xuất khớp danh mục từ cấm được giữ ở trạng thái chờ và đếm vào số chờ, không làm hỏng mẻ (INV-07). Tên người tạo trên phần tử lấy từ `GET /api/creators/{version}`; đổi nickname hiện từ mẻ kế tiếp, xóa tài khoản thì tên đó bị bỏ khỏi mọi version còn lưu.
- Phiên đăng nhập (ADR 0010): phiên hết hạn sau 90 ngày không dùng; cùng Cron `0 20 * * *` xóa các dòng `session` đã hết hạn. Bảng xếp hạng chỉ đọc phiên, không gia hạn.
- Lịch mẻ staging (AC-PIPE-02, AC-DAILY-12): cron riêng `0 */2 * * *` chạy mỗi 2 tiếng ở giờ chẵn UTC; production giữ `0 5 * * *` và `0 17 * * *`. Workflow `batch.yml` chọn môi trường `staging` khi cron này chạy, và đặt `BATCH_HOURS_UTC` theo lịch của môi trường (staging `0,2,...,22`, production `5,17`). Pipeline ghi lịch vào manifest (`schedule_hours_utc`) để client đếm ngược đúng; không tự đặt tay giá trị này trong GitHub Variables.
- Đổi nội dung chính sách (`web/src/privacy/PolicyPage.tsx`): tăng `POLICY_VERSION` trong `worker/wrangler.jsonc` (cả staging) và `POLICY.version` trên trang ⇒ mọi người chơi được hỏi đồng ý lại (AC-PRIV-09). Sửa chữ thì sửa cả `web/chinh-sach-tinh.html` (bản tĩnh cho bot); `web/src/privacy/staticPolicy.test.tsx` báo lỗi khi hai bản lệch nhau (AC-SUBPATH-14).
- Gia hạn token Threads (AC-PIPE-19, ADR 0014): workflow `threads-token` chạy thứ Hai 02:00 UTC mỗi tuần và chạy tay được (Actions → `threads-token` → Run workflow). Mỗi lần thành công, workflow ghi lại `THREADS_ACCESS_TOKEN` cho `staging` và `production-no-approval`; lỗi thì mở Issue "Threads token: gia hạn lỗi" kèm link run. Workflow nằm ở `docs/dev/workflows/threads-token.yml`, người làm chép vào `.github/workflows/` (agent không sửa workflow) và tạo `GH_SECRETS_TOKEN` (`docs/dev/huong-dan-tai-khoan.md` mục 8.1).
  - Hằng tháng kiểm tra workflow `threads-token` còn **Enabled**. GitHub tắt workflow theo lịch sau 60 ngày repo không có hoạt động; bị tắt thì bấm **Enable workflow** và chạy tay một lần.
  - Nếu bước ghi secret thứ hai (`production-no-approval`) lỗi thì `staging` đã có token mới và `production-no-approval` vẫn cũ. Chạy lại workflow bằng `workflow_dispatch` để ghi lại cả hai.
  - Dự phòng khi workflow không chạy được: gia hạn bằng tay theo `docs/dev/huong-dan-tai-khoan.md` mục 8.1 (trước 60 ngày).

## Sự cố thường gặp
| Triệu chứng | Nguyên nhân thường gặp | Xử lý |
|---|---|---|
| `/lau-meme/api/*` trả 500, log `no such table` | Chưa chạy migration trên môi trường đó | `npx wrangler d1 migrations apply DB --env <env> --remote` |
| Trang trắng sau deploy | Quên build web trước khi deploy | `npm --prefix web run build` rồi deploy lại |
| Ghi đồng ý (`/lau-meme/api/consents`) trả 500, log `IP_HASH_KEY is not configured` | Chưa đặt secret băm IP của môi trường đó (cố ý báo lỗi thay vì lưu IP thô) | Đặt secret theo `docs/dev/huong-dan-tai-khoan.md` |
| Workflow cron chạy trễ | GitHub Actions không bảo đảm đúng giờ | Bình thường; giao diện dựa vào thời điểm trong dữ liệu, không vào giờ lý thuyết |
| Báo cáo đợt ghi "Threads: thiếu cấu hình" | Thiếu `THREADS_ACCESS_TOKEN` hoặc `THREADS_KEYWORDS` (rỗng) | Đặt secret và variable theo `docs/dev/huong-dan-tai-khoan.md` mục 8; đợt không thất bại, nguồn Threads chỉ không thu gì (AC-PIPE-17) |
| Báo cáo đợt ghi "Threads: 0 bài cho mọi từ khóa" (dòng ⚠️) | App chưa được Meta duyệt quyền `threads_keyword_search`: API chỉ tìm trong bài của chính tài khoản cấp token, nên mọi từ khóa ra 0 bài. Không phải lỗi nguồn, đợt vẫn đăng (AC-PIPE-20) | Không cần sửa code. Gửi hoặc theo dõi App Review theo `docs/dev/huong-dan-tai-khoan.md` mục 8.1 (Bước 2); khi được duyệt, dòng cảnh báo biến mất ở đợt sau |
| Issue "Threads token: gia hạn lỗi" (workflow `threads-token` đỏ) | Gia hạn token lỗi: dòng `Threads token: gia hạn lỗi <mã>` trong log, thiếu `GH_SECRETS_TOKEN` hoặc PAT đã hết hạn (1 năm), hoặc workflow đã bị GitHub tắt | Mở log run theo link trong Issue. Token hết hạn ⇒ làm lại Bước 3 mục 8.1 rồi cập nhật secret. PAT hết hạn ⇒ tạo PAT mới, cập nhật `GH_SECRETS_TOKEN`, chạy lại workflow. Workflow bị tắt ⇒ bấm **Enable workflow** |
| Báo cáo đợt ghi "Threads: 401" hoặc "Threads: 403" | Token hết hạn, hoặc app chưa được duyệt quyền tìm theo từ khóa | Cấp lại token trong app Meta rồi cập nhật secret `THREADS_ACCESS_TOKEN`. Lỗi 429 (bị giới hạn lượt gọi) cũng hiện ở dòng lỗi nguồn (AC-PIPE-03) |
| Báo cáo đợt ghi "Tuổi Trẻ: không đọc được trang" | Trang `tuoitre.vn/meme.html` đổi giao diện | Không cần cấu hình; cập nhật bộ đọc `TuoiTreAdapter` trong `pipeline/src/lau_meme_pipeline/crawl.py` (AC-PIPE-15) |
| Đợt `core` thất bại với lỗi lịch mẻ (`BATCH_HOURS_UTC` ngoài 0-23, rỗng hoặc trùng) | Giá trị `BATCH_HOURS_UTC` trong `batch.yml` bị sửa sai | Khôi phục biểu thức trong `.github/workflows/batch.yml`; bản hiện hành giữ nguyên (AC-DAILY-12) |
| `dinoduct.fun` báo lỗi 52x hoặc không phân giải | Thiếu bản ghi DNS proxied cho host, hoặc Redirect Rule bị tắt | Xem `docs/dev/huong-dan-tai-khoan.md` mục 1–2 |
| `/lau-meme` vào được nhưng F5 ở màn hình con ra 404 | Bản deploy cũ (trước ADR 0007) hoặc web build sai thư mục | Build lại web (`web/dist/lau-meme/index.html` phải có) rồi deploy |
| Pipeline báo `HTTP 401` khi đăng mẻ / rollback | `PIPELINE_TOKEN` ở GitHub Environment khác với secret của Worker | Đặt lại cả hai nơi cùng một giá trị (`huong-dan-tai-khoan.md` mục 4.2) |
| Trang quản trị báo "Thiếu hoặc sai token" dù dán đúng | Chưa đặt `ADMIN_TOKEN` cho môi trường đó, hoặc dán token của môi trường khác | `npx wrangler secret list [--env staging]` phải có `ADMIN_TOKEN`; đặt lại theo mục 4.2 |
| Trang quản trị trả 429 "Thử sai quá nhiều lần" | 5 lần sai trong 1 phút từ cùng IP ⇒ khóa 15 phút, kể cả token đúng (AC-ADMIN-02) | Chờ hết `Retry-After`. Không có lệnh gỡ khóa; xóa dòng `admin-lock:%` trong `rate_counter` chỉ khi chắc không phải bị dò |
| Pipeline báo `HTTP 404` khi đăng mẻ / rollback | Secret `API_BASE_URL` thiếu tiền tố | Đặt `https://dinoduct.fun/lau-meme` (staging: `https://staging.dinoduct.fun/lau-meme`) |
| Pipeline báo `URL phải có dạng https://<host>...` | `API_BASE_URL` dùng `http` cho tên miền thật (chỉ `localhost` được `http`) | Đổi sang `https://...`; chạy cục bộ xem `docs/dev/setup.md` |
| Check "Workers Builds: lau-meme" của PR đỏ, log `missing a previews block` | Preview của nhánh giữ cài đặt build cũ (Root directory `/`, không Build command); sửa tab Previews Base không áp cho preview đã có | Sửa **Settings > Build** của chính preview đó rồi push commit mới, theo mục Môi trường ở trên |
| Trên URL preview: ghi đồng ý trả 500 (log `IP_HASH_KEY is not configured`), hoặc đăng nhập Google trả 500 (`ACCOUNT_HASH_KEY is not configured`) | Chưa đặt secret của preview; secret staging và production không áp dụng cho preview | `npx wrangler preview base-config secret put IP_HASH_KEY` và `ACCOUNT_HASH_KEY`, theo `docs/dev/huong-dan-tai-khoan.md` mục 4.4 |
| Đăng nhập Google trả 500, log có `ACCOUNT_HASH_KEY is not configured` hoặc `GOOGLE_CLIENT_ID is not configured` | Chưa đặt secret `ACCOUNT_HASH_KEY` hoặc biến `GOOGLE_CLIENT_ID` cho môi trường đó (Worker đóng, không mở phiên) | `npx wrangler secret list [--env staging]` phải có `ACCOUNT_HASH_KEY`; đặt theo `docs/dev/huong-dan-tai-khoan.md` mục 4.2; kiểm `vars` trong `worker/wrangler.jsonc` |
| Đăng nhập Google luôn trả 401 | `GOOGLE_CLIENT_ID` của Worker khác Client ID mà web chọn cho tên miền đó trong `web/src/auth/config.ts` (sai `audience`) | Đối chiếu `vars.GOOGLE_CLIENT_ID` của môi trường (`wrangler.jsonc`) với Client ID trong `web/src/auth/config.ts`; staging phải dùng Client ID staging, production dùng Client ID production |
| Log pipeline `Gemini: cả N mục của bước <step> đều lỗi (HTTP 503)` (hoặc `HTTP 429 theo phút`, `TimeoutError`) | Gemini tạm quá tải, giới hạn theo phút hoặc mạng chậm. Mỗi lô đã tự thử lại 5 lần (backoff 2 → 32 s, dùng `retryDelay` của Google nếu lâu hơn, tối đa 60 s) rồi mới báo lỗi; đợt vẫn đăng | Thường tự hết ở đợt sau. Nếu lặp lại nhiều đợt, xem log để biết mã lỗi. Báo "hết quota" là chuyện khác (hạn mức theo ngày) |
| Pipeline báo `HTTP 404` từ Gemini | Model trong `GEMINI_MODEL` không còn cho khóa mới (ví dụ `gemini-2.5-flash`, ADR 0011) | Đặt variable `GEMINI_MODEL` của environment về model còn hỗ trợ (mặc định hiện là `gemini-3.8-flash`, `docs/dev/huong-dan-tai-khoan.md` mục 8) |
| Báo cáo đợt ghi "Vàng/Đỏ thiếu ảnh: <tên>" | Món admin gán Vàng/Đỏ mà ảnh bị ẩn/chặn hoặc chưa vẽ kịp trong hạn 20 ảnh/đợt. Graph vẫn đăng, món hiện emoji | Tải tranh vẽ tay cho món, hoặc đổi tier về "Tự động (theo độ sâu)" (AC-TIER-05). Vẽ lại không tự gỡ chặn ảnh (câu hỏi mở 77): gỡ chặn bằng tay trên trang quản trị nếu ảnh đã được duyệt |
| Trang quản trị báo 409 "Món Vàng/Đỏ cần có ảnh trước" khi gán tier | Gán tier 4 hoặc 5 cho phần tử không có ảnh dùng được (không có `image_key` hoặc ảnh đang bị chặn) | Chọn tier 1-3 hoặc "Tự động", hoặc đợi ảnh hợp lệ rồi gán lại (AC-TIER-04, AC-ADMIN-12); không ghi audit khi bị từ chối |
| Nút Google báo `origin_mismatch` hoặc `The given origin is not allowed` | Origin của tên miền chưa có trong Authorized JavaScript origins của Client ID mà web chọn theo host (staging: client staging; còn lại: client production), hoặc origin mới chưa có hiệu lực | Thêm origin (chỉ scheme + host, không có `/lau-meme`) vào đúng client trong Google Cloud Console; đợi 5 phút tới vài giờ rồi thử lại (`huong-dan-tai-khoan.md` mục 7.3) |
