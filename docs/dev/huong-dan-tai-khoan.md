# Hướng dẫn tài khoản Cloudflare — dinoduct.fun (người làm)

> Các bước trong file này **chỉ người làm**, trên dashboard Cloudflare hoặc bằng lệnh production. Agent không làm thay được: guard hook chặn `wrangler deploy` không kèm `--env staging`.
> Bối cảnh: Q15 và ADR 0007. Zone `dinoduct.fun` mua qua Cloudflare Registrar, lúc viết hướng dẫn **chưa có bản ghi DNS nào**.
> Tài liệu Cloudflare thay đổi thường xuyên. Tên menu bên dưới đúng vào ngày viết (2026-10-20); nếu dashboard khác đi thì làm theo ý của bước, đừng làm theo chữ.

Thứ tự nên làm: 1 → 3 → deploy staging (`/dk:ship staging`) → 2 → 4 → 5.

## 1. Bản ghi DNS cho host chỉ có Worker
Route Worker chỉ chạy khi host phân giải **qua proxy Cloudflare** (đám mây cam). Game không có máy chủ gốc, nên dùng bản ghi "không origin": AAAA trỏ `100::`, dải IPv6 dùng để loại bỏ (RFC 6666), không bao giờ có máy chủ nào trả lời ở địa chỉ này.

DNS → Records → Add record, thêm hai bản ghi:

| Type | Name | IPv6 address | Proxy status | TTL |
|---|---|---|---|---|
| AAAA | `@` (tức `dinoduct.fun`) | `100::` | Proxied | Auto |
| AAAA | `staging` | `100::` | Proxied | Auto |

Ghi chú:
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
  - Universal SSL đã phủ `dinoduct.fun` và `*.dinoduct.fun` (gồm `staging`). Chờ trạng thái Active trước khi thử.
  - **HSTS**: chưa bật. Nếu bật thì `max-age` ngắn, **không** tick Preload và **không** Include subdomains cho tới khi mọi game và hub đều chạy HTTPS ổn định. Preload rất khó gỡ.
  - Minimum TLS Version: 1.2.

## 4. Deploy production lần đầu
Chuẩn bị (một lần):
1. Tạo D1 production: `cd worker && npx wrangler d1 create lau-meme-prod`, rồi chép `database_id` vào `worker/wrangler.jsonc` (top-level) và commit qua PR. `database_id` không phải bí mật.
2. Đặt secret Worker production: `npx wrangler secret put PIPELINE_TOKEN` và `npx wrangler secret put IP_HASH_KEY` (giá trị lấy từ `openssl rand -base64 32`; không ghi vào file nào).
3. GitHub → Settings → Environments:
   - environment `production` và `production-no-approval`: secret `API_BASE_URL` = `https://dinoduct.fun/lau-meme` (**có tiền tố**, không có `/` cuối), `PIPELINE_TOKEN` = giá trị vừa đặt ở bước 2.
   - environment `staging` (nếu dùng): `https://staging.dinoduct.fun/lau-meme`.

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
