# Hướng dẫn tài khoản Cloudflare và Google - dinoduct.fun (người làm)

> Các bước trong file này **chỉ người làm**, trên dashboard Cloudflare hoặc bằng lệnh production. Agent không làm thay được: guard hook chặn `wrangler deploy` không kèm `--env staging`.
> Bối cảnh: Q15 và ADR 0007. Zone `dinoduct.fun` mua qua Cloudflare Registrar, lúc viết hướng dẫn **chưa có bản ghi DNS nào**.
> Tài liệu Cloudflare thay đổi thường xuyên. Tên menu bên dưới đúng vào ngày viết (2026-10-20); nếu dashboard khác đi thì làm theo ý của bước, đừng làm theo chữ.

Thứ tự nên làm: 1 → 3 → deploy staging (`/dk:ship staging`) → 2 → 4 → 5. Mục 6 (R2) làm trước khi build ART ở giai đoạn 2. Mục 7 (Google OAuth) làm trước khi build AUTH.

## 1. Bản ghi DNS cho host chỉ có Worker
Route Worker chỉ chạy khi host phân giải **qua proxy Cloudflare** (đám mây cam). Game không có máy chủ gốc, nên dùng bản ghi "không origin": AAAA trỏ `100::`, dải IPv6 dùng để loại bỏ (RFC 6666), không bao giờ có máy chủ nào trả lời ở địa chỉ này.

DNS → Records → Add record, thêm bốn bản ghi:

| Type | Name | IPv6 address | Proxy status | TTL |
|---|---|---|---|---|
| AAAA | `@` (tức `dinoduct.fun`) | `100::` | Proxied | Auto |
| AAAA | `staging` | `100::` | Proxied | Auto |
| AAAA | `laumeme-admin` | `100::` | Proxied | Auto |
| AAAA | `laumeme-admin-staging` | `100::` | Proxied | Auto |

Ghi chú:
- Hai bản ghi `laumeme-admin*` là host của trang quản trị (ADR 0008), cùng Worker với game nhưng khác origin. Route `laumeme-admin*.dinoduct.fun/*` bắt mọi đường dẫn của host nên Worker tự trả 404 cho đường dẫn lạ, không ra lỗi 52x.
- Tài liệu Workers hiện hành có cảnh báo về bản ghi `100::` và khuyên dùng Custom Domain khi Worker là origin. Ở đây **không dùng được Custom Domain**: nó chiếm mọi đường dẫn của host (ADR 0007). Bản ghi `100::` proxied vẫn là cách Cloudflare dùng cho origin chỉ có Worker (vd tài liệu "Worker as origin" của Cloudflare for SaaS). Hệ quả: mọi đường dẫn **không** có route hay Redirect Rule (vd `dinoduct.fun/abc`) sẽ trả lỗi 52x của Cloudflare. Đây là hành vi **dự kiến**, không phải sự cố. Chấp nhận cho tới khi có hub.
- Không thêm bản ghi `www` nếu chưa cần. Nếu thêm thì cũng là AAAA `100::` proxied, kèm một Redirect Rule `www` → apex.
- Kiểm tra: `dig +short AAAA dinoduct.fun` phải ra IPv6 của Cloudflare (không phải `100::`, vì đã proxied).

## 2. Redirect Rule cho gốc `/`
Rules → Redirect Rules (Single Redirects) → Create rule:

- Tên: `goc-ve-lau-meme (tạm, gỡ khi có hub)`
- Điều kiện (Edit expression):
  ```
  (http.host eq "dinoduct.fun" and http.request.uri.path eq "/")
  ```
  Chỉ khớp đúng host `dinoduct.fun` và đúng path `/`. Không khớp `staging.dinoduct.fun` và không khớp `/lau-meme...`.
- Then: Static, URL `https://dinoduct.fun/lau-meme/`, Status code **302**, bật **Preserve query string** (để `/?ref=x` → `/lau-meme/?ref=x`).
- Deploy.

Giới hạn: gói Free cho **10 Single Redirect rules mỗi zone** (wildcard được, regex thì không). Rule này dùng 1.

Kiểm tra:
```bash
curl -sI "https://dinoduct.fun/?ref=test" | grep -iE '^(HTTP|location)'
# HTTP/2 302 · location: https://dinoduct.fun/lau-meme/?ref=test
```

**Gỡ khi có hub:** tắt (Disable) rule này cùng lúc hub deploy route của nó (vd `dinoduct.fun/` hoặc Custom Domain riêng). Kiểm tra `curl -sI https://dinoduct.fun/` không còn 302 rồi mới xóa hẳn rule. Repo Lẩu Meme không phải sửa gì.

## 3. SSL/TLS
- SSL/TLS → Overview: để **Automatic SSL/TLS** (mặc định hiện hành) hoặc **Full (strict)**. Không có origin, mọi request đều do Worker trả lời, nên chế độ này chỉ ảnh hưởng nếu sau này có origin thật. Tuyệt đối không chọn Flexible.
- SSL/TLS → Edge Certificates:
  - **Always Use HTTPS**: bật.
  - Universal SSL đã phủ `dinoduct.fun` và `*.dinoduct.fun` (gồm `staging` và hai host `laumeme-admin*`). Chờ trạng thái Active trước khi thử.
  - **HSTS**: chưa bật. Nếu bật thì `max-age` ngắn, **không** tick Preload và **không** Include subdomains cho tới khi mọi game và hub đều chạy HTTPS ổn định. Preload rất khó gỡ.
  - Minimum TLS Version: 1.2.

## 4. Deploy production lần đầu
Chuẩn bị (một lần, làm cho staging trước rồi production).

### 4.1. D1
Tạo D1: `cd worker && npx wrangler d1 create lau-meme-staging` và `npx wrangler d1 create lau-meme-prod`, rồi chép `database_id` vào `worker/wrangler.jsonc` (`env.staging` và top-level) và commit qua PR. `database_id` không phải bí mật.

### 4.2. Secret của Worker
Ba secret, **mỗi môi trường một giá trị riêng** (không dùng chung giữa staging và production). Giá trị sinh bằng `openssl rand -base64 32` (32 byte ngẫu nhiên), không ghi vào file, issue, chat hay commit nào. Lệnh dưới là của staging; production bỏ `--env staging` (chỉ người chạy, guard chặn agent) và với `gh` dùng `--env production`.

| Secret | Dùng để | Thiếu thì |
|---|---|---|
| `PIPELINE_TOKEN` | Bearer của pipeline gọi `/lau-meme/api/pipeline/*` (đăng mẻ, rollback, danh mục cấm - ADR 0003) | Mọi lệnh pipeline trả 401 |
| `IP_HASH_KEY` | Khóa HMAC-SHA256 băm IP cho giới hạn tần suất, ghi đồng ý và khóa chống dò token quản trị (ADR 0004). IP thô không bao giờ được lưu | Ghi đồng ý, các API có giới hạn tần suất và **toàn bộ API quản trị** trả 500 (cố ý báo lỗi thay vì lưu IP thô) |
| `ADMIN_TOKEN` | Bearer của trang quản trị ở `https://laumeme-admin[-staging].dinoduct.fun/` (ADR 0008) | Trang quản trị từ chối mọi request (401) |

`PIPELINE_TOKEN` phải có **cùng giá trị** ở Worker và ở GitHub Environment, nên sinh một lần rồi đẩy vào cả hai nơi, không in ra màn hình:
```bash
cd worker
T=$(openssl rand -base64 32)
printf %s "$T" | npx wrangler secret put PIPELINE_TOKEN --env staging
printf %s "$T" | gh secret set PIPELINE_TOKEN --env staging
unset T

# production (người chạy): sinh T mới, một giá trị cho Worker và cả hai environment production
T=$(openssl rand -base64 32)
printf %s "$T" | npx wrangler secret put PIPELINE_TOKEN
printf %s "$T" | gh secret set PIPELINE_TOKEN --env production
printf %s "$T" | gh secret set PIPELINE_TOKEN --env production-no-approval
unset T
```

`IP_HASH_KEY` không ai cần biết giá trị, đặt thẳng:
```bash
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put IP_HASH_KEY --env staging
```
Đổi `IP_HASH_KEY` làm mọi bộ đếm giới hạn tần suất và khóa quản trị đang có bắt đầu lại từ 0; dữ liệu cũ vẫn đúng (chỉ có băm, sẽ được cron dọn sau 7 ngày). Chỉ đổi khi nghi lộ.

`ADMIN_TOKEN` là mật khẩu của người quản trị: sinh, **lưu vào trình quản lý mật khẩu trước**, rồi dán vào lời nhắc của wrangler:
```bash
openssl rand -base64 32          # chép vào trình quản lý mật khẩu, mục "Lẩu Meme admin (staging)"
npx wrangler secret put ADMIN_TOKEN --env staging   # dán giá trị khi được hỏi
clear                            # xóa giá trị khỏi màn hình
```
- Token ngắn hoặc dễ đoán là không được: khóa chống dò chỉ chặn 5 lần sai/phút/IP (AC-ADMIN-02), an toàn dựa vào độ dài token. Luôn dùng 32 byte ngẫu nhiên như trên.
- Trang quản trị chỉ giữ token trong `sessionStorage` của tab: đóng tab là phải dán lại.
- Đổi token (định kỳ hoặc khi nghi lộ): chạy lại `secret put` với giá trị mới. Có hiệu lực ngay, phiên đang mở báo 401 và phải dán token mới. Nhật ký audit ghi 8 ký tự dấu vân của token nên phân biệt được thao tác trước và sau khi đổi.

Kiểm tra (chỉ in tên, không in giá trị):
```bash
npx wrangler secret list --env staging        # phải có ADMIN_TOKEN, IP_HASH_KEY, PIPELINE_TOKEN
```
Sau khi deploy:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://staging.dinoduct.fun/lau-meme/api/pipeline/state                 # 401 (không token)
curl -s -o /dev/null -w '%{http_code}\n' https://laumeme-admin-staging.dinoduct.fun/api/admin/batches            # 401 (không token)
curl -s -o /dev/null -w '%{http_code}\n' https://staging.dinoduct.fun/lau-meme/api/admin/batches                 # 404 (host game không có API quản trị)
```
Rồi mở `https://laumeme-admin-staging.dinoduct.fun/`, dán `ADMIN_TOKEN`, thấy danh sách đợt là xong. Đừng thử token sai quá 4 lần trong 1 phút: lần sai thứ 5 trong cùng phút đó khóa IP của bạn 15 phút, kể cả khi sau đó dán đúng token.

### 4.3. GitHub Environments
GitHub → Settings → Environments:
- `production` (bật Required reviewers) và `production-no-approval` (không duyệt, cho cron mẻ nhúng): variable (Environment variables, không phải secret) `API_BASE_URL` = `https://dinoduct.fun/lau-meme` (**có tiền tố**, không có `/` cuối); secret `PIPELINE_TOKEN` = giá trị production ở mục 4.2, `BANNED_WORDS` = danh sách từ cấm (mỗi dòng một từ).
- `staging`: variable `API_BASE_URL` = `https://staging.dinoduct.fun/lau-meme`; secret `PIPELINE_TOKEN` = giá trị staging, `BANNED_WORDS`.
- `ADMIN_TOKEN` và `IP_HASH_KEY` **không** đặt ở GitHub: không workflow nào cần.
- Mẻ `full` (giai đoạn 2, crawl + Gemini - xem mục 8): thêm vào **cả** `staging` và `production-no-approval`.

Deploy (trên `main` đã merge, máy sạch):
```bash
npm --prefix web ci && npm --prefix web run build      # phải có web/dist/lau-meme/index.html
cd worker && npm ci
npx wrangler d1 migrations apply DB --remote           # production
npx wrangler deploy                                    # production; wrangler gắn route dinoduct.fun/lau-meme*
curl -fsS https://dinoduct.fun/lau-meme/api/health     # {"status":"ok","env":"production",...}
```
Hoặc chạy workflow `deploy` với `env = production` (environment có người duyệt).

Kiểm tra nghiệm thu:
```bash
for u in / /lau-meme /lau-meme/ /lau-meme/bat-ky /lau-meme/api/health /lau-meme-abc; do
  printf '%-22s ' "$u"; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Accept: text/html' "https://dinoduct.fun$u"
done
# /  302 …/lau-meme/ · /lau-meme 301 …/lau-meme/ · /lau-meme/ 200 · /lau-meme/bat-ky 200 · health 200 · /lau-meme-abc 404
```
Trên trình duyệt: mở game, F5 ở mọi màn hình không ra 404. DevTools → Network: mọi request nằm dưới `/lau-meme/`. Application → Local Storage: mọi khóa bắt đầu bằng `laumeme:`.

Quay lại khi lỗi: `npx wrangler rollback` (chỉ code, không quay lại dữ liệu D1, xem runbook).

## 5. Kiểm tra mạng và xem trước link
**Nhà mạng và bộ lọc.** Một số bộ lọc doanh nghiệp, DNS gia đình và trình chặn quảng cáo xếp đuôi `.fun` vào nhóm rủi ro. Mở `https://dinoduct.fun/lau-meme/` và chơi thử một ván trên từng mạng, ghi kết quả (mở được / bị chặn / chậm):

| Mạng | Kết quả | Ghi chú |
|---|---|---|
| Wi-Fi công ty | | |
| 4G Viettel | | |
| 4G Vinaphone | | |
| 4G Mobifone | | |
| Wi-Fi nhà (DNS mặc định) | | |

Nếu bị chặn: ghi tên bộ lọc hoặc trang chặn, rồi gửi yêu cầu xếp loại lại cho nhà cung cấp bộ lọc đó (vd Cisco Talos, Fortinet, Palo Alto, Zscaler đều có trang "URL category lookup / re-categorize"). Phương án dự phòng là tên miền khác, một quyết định mới nên ghi vào `docs/open-questions.md`.

**Xem trước link.** Mỗi nền tảng có công cụ làm mới bộ nhớ đệm:
- Facebook / Messenger: https://developers.facebook.com/tools/debug/ → dán `https://dinoduct.fun/lau-meme/` → Scrape Again. Phải thấy tiêu đề "Lẩu Meme", URL chuẩn `https://dinoduct.fun/lau-meme/`, và ảnh OG (sẽ thiếu ảnh cho tới khi có `og.png`, câu hỏi mở 18).
- Zalo: gửi link vào một cuộc trò chuyện (vd "Cloud của tôi") để xem thẻ. Zalo giữ cache khá lâu; khi đã đổi thẻ thì thêm `?v=2` vào link để thử.
- Thử cả `https://dinoduct.fun` (qua redirect 302) và `https://dinoduct.fun/lau-meme` (qua 301) để chắc trình thu thập theo được chuyển hướng.

Staging làm tương tự với `https://staging.dinoduct.fun/lau-meme/`. Thẻ xem trước của staging vẫn trỏ canonical về production, như vậy là đúng.

## 6. R2 - kho ảnh minh họa (giai đoạn 2)
Dùng cho ART: pipeline lưu ảnh WebP 256x256 ở khóa `img/<sha256-12>.webp` (AC-ART-04), Worker phục vụ `/lau-meme/img/*` với cache `immutable` (AC-ART-05). Giai đoạn 1 chưa dùng.

### 6.1. Bật R2
Storage & Databases → R2 Object Storage → Purchase R2 Plan / Get started, trên đúng account chứa zone `dinoduct.fun`.
- Ngày 2026-10-21, account này bật R2 **không bị đòi khai báo thẻ thanh toán** (trả lời câu hỏi mở 13).
- Gói free mỗi tháng: 10 GB lưu trữ, 1 triệu thao tác loại A (ghi, liệt kê), 10 triệu thao tác loại B (đọc), egress miễn phí. Ảnh vài chục KB, đọc qua Cache API nên còn rất xa hạn mức.
- R2 không có giới hạn chi tiêu cứng. Nếu sau này account có phương thức thanh toán thì đặt cảnh báo ở Manage Account → Billing → Notifications.

### 6.2. Bucket
Mỗi môi trường một bucket, vị trí gợi ý châu Á - Thái Bình Dương:
```bash
cd worker
npx wrangler r2 bucket create lau-meme-img --location apac
npx wrangler r2 bucket create lau-meme-img-staging --location apac
npx wrangler r2 bucket list
```
- **Không bật Public access và không bật r2.dev.** Ảnh chỉ đi qua Worker: Worker kiểm định dạng khóa, đặt header cache và không phục vụ ảnh bị chặn (AC-ART-05/07).
- Không cần CORS: ảnh cùng origin với game.
- Tên bucket không phải bí mật.

### 6.3. Pipeline ghi ảnh qua Worker (không cần token S3)
Từ ADR 0012, pipeline tải ảnh bằng `PUT /lau-meme/api/pipeline/images/{key}` với `PIPELINE_TOKEN`. Worker kiểm nội dung rồi ghi R2 qua binding `IMG` (mục 6.4).
- **Không** tạo R2 API token / S3 access key cho dự án này.
- Nếu đã tạo theo bản hướng dẫn cũ: xóa token ở R2 → Manage R2 API Tokens, rồi xóa `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` khỏi các GitHub Environment.

### 6.5. Token Workers AI cho pipeline (vẽ ảnh)
1. Dashboard → My Profile → API Tokens → Create Token → Custom token.
2. Permissions: **Account → Workers AI → Edit** (gồm Read). Account Resources: chỉ account chứa `dinoduct.fun`. Không thêm quyền nào khác.
3. GitHub → Settings → Environments, thêm vào `staging` và `production-no-approval`:

| Tên | Loại | Giá trị |
|---|---|---|
| `WORKERS_AI_TOKEN` | Secret | token ở bước 2 (khác `CLOUDFLARE_API_TOKEN` dùng để deploy) |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Account ID (trang Overview của zone, cột phải) |
| `WORKERS_AI_MODEL` | Variable | để trống = `@cf/black-forest-labs/flux-1-schnell` |

Mỗi đợt vẽ tối đa 20 ảnh; hết hạn mức gói free thì phần còn lại chờ vẽ đợt sau (AC-ART-03), đợt không thất bại. Báo cáo đợt (GitHub Issue) ghi số ảnh vẽ, bị loại, chờ vẽ.

### 6.4. Binding cho Worker
Đã khai báo trong `worker/wrangler.jsonc` ngày 2026-10-21, ở **cả** top-level lẫn `env.staging` (binding không kế thừa sang env). Chỉ một binding `IMG` mỗi môi trường. Nếu `wrangler r2 bucket create` hỏi có thêm binding vào file cấu hình không thì chọn **không**: lệnh đó thêm binding vào top-level (tức production) với tên tự sinh và `"remote": true`, đồng thời định dạng lại cả file.
```jsonc
// top-level (production)
"r2_buckets": [{ "binding": "IMG", "bucket_name": "lau-meme-img" }],
// env.staging
"r2_buckets": [{ "binding": "IMG", "bucket_name": "lau-meme-img-staging" }],
```
Test local (Miniflare) tự giả lập R2, không cần tài khoản hay token.

### 6.5. Kiểm tra
Trên bucket staging:
```bash
cd worker
printf test > /tmp/r2-test.txt
npx wrangler r2 object put lau-meme-img-staging/img/r2-test.txt --file /tmp/r2-test.txt --remote --env staging
npx wrangler r2 object get lau-meme-img-staging/img/r2-test.txt --remote --pipe --env staging   # in ra "test"
npx wrangler r2 object delete lau-meme-img-staging/img/r2-test.txt --remote --env staging
rm /tmp/r2-test.txt
```
Sau khi deploy bản có ART:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://staging.dinoduct.fun/lau-meme/img/000000000000.webp   # 404 (khóa không có)
curl -s -o /dev/null -w '%{http_code}\n' https://staging.dinoduct.fun/lau-meme/img/abc.png            # 400 (sai định dạng)
```

## 7. Google OAuth client ID - đăng nhập Google (AUTH)
Dùng cho AUTH (`docs/acceptance/auth.md`, câu hỏi mở 33). Game dùng **Google Identity Services** (nút "Đăng nhập bằng Google"): trình duyệt nhận **ID token** từ Google rồi gửi cho Worker, Worker kiểm chữ ký bằng khóa công khai của Google. Không có redirect OAuth và không dùng client secret, nên chỉ cần **client ID** (công khai) và **Authorized JavaScript origins**.
Tên menu đúng vào ngày viết (2026-10-21). Google đang đổi tên "OAuth consent screen" thành **Google Auth Platform**; nếu menu khác thì làm theo ý của bước.

### 7.1. Tạo project
1. Vào https://console.cloud.google.com bằng tài khoản Google sẽ quản lý game.
2. Thanh trên cùng → chọn project → **New project**. Tên: `lau-meme`. Organization: để "No organization" nếu là tài khoản cá nhân → **Create**.
3. Chọn project `lau-meme` vừa tạo. Không cần bật API nào: kiểm ID token không gọi Google API.

### 7.2. Màn hình xin quyền (Google Auth Platform)
1. Menu ☰ → **APIs & Services → OAuth consent screen** (hoặc **Google Auth Platform → Branding**) → **Get started**.
2. **App information**: App name `Lẩu Meme`, User support email là email của bạn.
3. **Audience**: chọn **External** (người chơi là bất kỳ tài khoản Google nào).
4. **Contact information**: email của bạn → đồng ý điều khoản → **Create**.
5. **Branding** (bổ sung, cần để xuất bản):
   - Application home page: `https://dinoduct.fun/lau-meme/`
   - Application privacy policy link: `https://dinoduct.fun/lau-meme/chinh-sach`
   - Authorized domains: `dinoduct.fun`
   - Logo: bỏ trống. Có logo thì Google bắt xác minh thương hiệu, mất vài ngày.
6. **Data Access** (Scopes): chỉ để 3 scope mặc định `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. **Không thêm scope nào khác.** Đây là scope "non-sensitive" nên không cần Google duyệt. Worker chỉ đọc `sub` trong ID token, bỏ qua email và tên (AC-AUTH-01).
7. **Audience → Publishing status**: bấm **Publish app** để chuyển từ Testing sang **In production**. Ở Testing chỉ tối đa 100 "test users" thêm tay mới đăng nhập được. Với 3 scope mặc định và không có logo, xuất bản không phải chờ Google duyệt.

### 7.3. Tạo client ID
Tạo **hai** client: một cho production, một cho staging và máy local. Tách ra để sửa origin của staging không đụng production.
1. **Clients** (hoặc **APIs & Services → Credentials → Create credentials → OAuth client ID**) → **Create client**.
2. Application type: **Web application**.
3. Client production:
   - Name: `lau-meme-production`
   - Authorized JavaScript origins: `https://dinoduct.fun`
   - Authorized redirect URIs: **để trống** (không có redirect)
4. Client staging:
   - Name: `lau-meme-staging`
   - Authorized JavaScript origins: `https://staging.dinoduct.fun`, `http://localhost`, `http://localhost:5173`, `http://localhost:8787`
   - Authorized redirect URIs: để trống
5. Origin chỉ gồm scheme + host (+ cổng), **không có đường dẫn** `/lau-meme`, không có dấu `/` ở cuối.
6. Mỗi client hiện **Client ID** dạng `123456789012-abc...apps.googleusercontent.com`. Client ID **không phải bí mật** (nằm trong mã web gửi cho mọi người). Màn hình có thể hiện cả **Client secret**: không dùng, không chép đi đâu.
7. Origin mới có thể mất 5 phút tới vài giờ mới có hiệu lực. Nếu nút báo `origin_mismatch` hoặc `The given origin is not allowed` thì đợi rồi thử lại.

### 7.4. Đưa client ID vào cấu hình
Client ID công khai nên để trong `worker/wrangler.jsonc` vars (Worker kiểm `aud`), mỗi môi trường một giá trị. Web không lấy từ Worker: `web/src/auth/config.ts` giữ Client ID staging và production, chọn theo tên miền (`staging.dinoduct.fun` dùng staging, còn lại dùng production). Khi đổi Client ID, sửa cả hai nơi. Cấu hình `vars` của Worker:
```jsonc
// top-level (production)
"vars": { ..., "GOOGLE_CLIENT_ID": "<client ID của lau-meme-production>" },
// env.staging
"vars": { ..., "GOOGLE_CLIENT_ID": "<client ID của lau-meme-staging>" }
```
Đã tạo và điền ngày 2026-10-21: production `983893414114-5s71asl52rc0c5o5pffdnbfa1n0uc2r1.apps.googleusercontent.com`, staging `983893414114-4fqirgtmr60j2ae9mumhtuuthr31vl4c.apps.googleusercontent.com`.

### 7.5. Khóa băm mã tài khoản (secret)
Worker lưu HMAC-SHA256(`sub`) chứ không lưu `sub` thô (AC-AUTH-01). Khóa HMAC là **bí mật**, mỗi môi trường một khóa, **không đổi** sau khi đã có người đăng nhập (đổi khóa thì mọi tài khoản cũ thành tài khoản mới trống).
```bash
cd worker
openssl rand -base64 32 | npx wrangler secret put ACCOUNT_HASH_KEY --env staging
openssl rand -base64 32 | npx wrangler secret put ACCOUNT_HASH_KEY   # production: chỉ người làm (guard chặn agent)
```
- Lệnh dùng pipe nên khóa không hiện trên màn hình và không nằm lại trong lịch sử shell. Không cần chép khóa ra đâu khác: Cloudflare giữ nó.
- Kiểm tra: `npx wrangler secret list --env staging` thấy tên `ACCOUNT_HASH_KEY` (không thấy giá trị).
- Chạy local có đăng nhập (`npm --prefix worker run dev`): tự thêm `ACCOUNT_HASH_KEY=<chuỗi bất kỳ>` vào file biến local của Worker (agent không được đọc/ghi file đó). Test tự đặt khóa giả, không cần.

### 7.6. Kiểm tra sau khi deploy bản có AUTH
1. Mở `https://staging.dinoduct.fun/lau-meme/`, đồng ý gửi dữ liệu, bấm "Đăng nhập bằng Google", chọn tài khoản: giao diện hiện "Đã đăng nhập".
2. DevTools → Application → Cookies: có cookie phiên với `HttpOnly`, `Secure`, `Path=/lau-meme`.
3. Ghép ra Món đặc biệt → thẻ hiện "Hạng #…"; Bảng xếp hạng có dòng của bạn.
4. Đăng xuất → bảng xếp hạng vẫn xem được, thẻ món mời đăng nhập lại.

## 8. Gemini và nguồn crawl - mẻ `full` (giai đoạn 2)
Mẻ `full` crawl meme rồi gọi Gemini để khử trùng, mô tả, kiểm duyệt, liên kết và chấm điểm (ADR 0009, 0011). Chỉ dữ liệu meme công khai được gửi đi (AC-PIPE-13).

1. **Khóa Gemini:** vào https://aistudio.google.com/apikey → Create API key (gói free). Khóa là bí mật: không dán vào chat, issue, commit.
2. GitHub → Settings → Environments → `staging` (rồi lặp lại cho `production-no-approval`):
   - Secret `GEMINI_API_KEY` = khóa ở bước 1.
   - Variable `GEMINI_MODEL` = `gemini-2.5-flash` (để trống cũng dùng giá trị này).
   - Variable `REDDIT_SUBREDDITS`, `RSS_FEEDS`: danh sách phân tách bằng dấu phẩy (câu hỏi mở 25). Để trống thì nguồn đó không thu gì; Know Your Meme và Google Trends VN chạy không cần cấu hình.
   - Secret `YOUTUBE_API_KEY` (tùy chọn): khóa YouTube Data API v3; không có thì nguồn YouTube báo lỗi trong báo cáo đợt, các nguồn khác vẫn chạy (AC-PIPE-03).
   - Variable `BATCH_MODE`: để trống (cron chạy `core`) cho tới khi chạy tay `full` ổn định, rồi đặt `full` để cron tự crawl.
3. Chép `docs/dev/workflows/batch.yml` vào `.github/workflows/batch.yml` (agent không được sửa workflow).
4. Thử: Actions → batch → Run workflow → mode `full`, target `staging`. Xem GitHub Issue báo cáo đợt: số crawl/thêm/bị chặn/hàng chờ, lỗi từng nguồn, quota Gemini.
