# Hướng dẫn tài khoản Cloudflare — dinoduct.fun (người làm)

> Các bước trong file này **chỉ người làm**, trên dashboard Cloudflare hoặc bằng lệnh production. Agent không làm thay được: guard hook chặn `wrangler deploy` không kèm `--env staging`.
> Bối cảnh: Q15 và ADR 0007. Zone `dinoduct.fun` mua qua Cloudflare Registrar, lúc viết hướng dẫn **chưa có bản ghi DNS nào**.
> Tài liệu Cloudflare thay đổi thường xuyên. Tên menu bên dưới đúng vào ngày viết (2026-10-20); nếu dashboard khác đi thì làm theo ý của bước, đừng làm theo chữ.

Thứ tự nên làm: 1 → 3 → deploy staging (`/dk:ship staging`) → 2 → 4 → 5.

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
| `PIPELINE_TOKEN` | Bearer của pipeline gọi `/lau-meme/api/pipeline/*` (đăng mẻ, rollback, danh mục cấm — ADR 0003) | Mọi lệnh pipeline trả 401 |
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
- `production` (bật Required reviewers) và `production-no-approval` (không duyệt, cho cron mẻ nhúng): secret `API_BASE_URL` = `https://dinoduct.fun/lau-meme` (**có tiền tố**, không có `/` cuối), `PIPELINE_TOKEN` = giá trị production ở mục 4.2, `BANNED_WORDS` = danh sách từ cấm (mỗi dòng một từ).
- `staging`: `API_BASE_URL` = `https://staging.dinoduct.fun/lau-meme`, `PIPELINE_TOKEN` = giá trị staging, `BANNED_WORDS`.
- `ADMIN_TOKEN` và `IP_HASH_KEY` **không** đặt ở GitHub: không workflow nào cần.

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
