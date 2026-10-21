# 0010 - Đăng nhập Google: chỉ băm `sub`, phiên cookie lưu băm trong D1, Daily theo tài khoản

- Trạng thái: Đã chấp nhận (2026-10-21, cổng contract duyệt tại 732bb73)
- Ngày: 2026-10-21
- Nguồn: AUTH (AC-AUTH-01..07), DAILY làm lại (AC-DAILY-04..15), BRD 0.5 mục 2, 5.1, 5.2; câu hỏi mở 32-34

## Bối cảnh
Bảng xếp hạng Daily cần một danh tính khó nhân bản hơn UUID ẩn danh (ADR 0004) và dùng được trên nhiều máy. BRD 0.5 chọn đăng nhập Google, bắt buộc để nộp kết quả, tùy chọn để chơi. Ràng buộc: không lưu email, tên, ảnh, `sub` thô (dữ liệu cá nhân cơ bản, Luật BVDLCN 2025); phiên hết hạn sau 90 ngày không dùng (câu hỏi mở 32); gói Cloudflare free, không thêm hạ tầng.

## Quyết định
- **Client**: Google Identity Services (nút "Sign in with Google", script `https://accounts.google.com/gsi/client`) trả ID token (JWT). Client gửi token một lần tới `POST /api/auth/google` kèm `X-Player-Id`. Không dùng luồng redirect/code, không cần client secret.
- **Kiểm ID token ở Worker** bằng thư viện `jose` (không phụ thuộc, chạy trên Workers): `createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs')` (cache khóa trong isolate theo `Cache-Control` của Google), `jwtVerify` với `issuer: ['accounts.google.com', 'https://accounts.google.com']`, `audience: GOOGLE_CLIENT_ID`, `algorithms: ['RS256']`, `clockTolerance: 60`. Mọi lỗi (kể cả JWKS không tải được) → 401; token và `sub` không bao giờ vào log (AC-AUTH-03, AC-PRIV-07). Test dùng `fetchMock` của vitest-pool-workers trả JWKS của một khóa RSA sinh trong test.
- **Tài khoản**: khóa = `HMAC-SHA256(ACCOUNT_HASH_KEY, sub)` (secret, không bao giờ xoay khi đã có tài khoản); id nội bộ UUIDv7. Bảng `account_player` gắn mỗi UUID trình duyệt đã đăng nhập vào đúng một tài khoản (đăng nhập tài khoản khác trên cùng máy thì chuyển gắn).
- **Phiên**: mã 32 byte ngẫu nhiên (base64url) trong cookie `laumeme_sid; HttpOnly; Secure; SameSite=Lax; Path=/lau-meme; Max-Age=7776000`; D1 chỉ lưu SHA-256 của mã (mã đủ entropy nên không cần HMAC). Mỗi yêu cầu có phiên hợp lệ tới endpoint cần phiên hoặc quản lý phiên (`/auth/session`, `/me*`, nộp Daily) đặt `last_used_at = now`, `expires_at = now + 90 ngày` và đặt lại cookie. Bảng xếp hạng Daily (mẻ, tuần/tháng) là đọc công khai không giới hạn tần suất nên chỉ đọc phiên để đánh dấu hạng của mình, không ghi D1, không đặt lại cookie. Đăng xuất xóa dòng phiên; Cron hằng ngày (ADR 0004) xóa phiên hết hạn.
- **CSRF**: `SameSite=Lax` không gửi cookie trong POST/PUT/DELETE chéo trang; thêm vào đó mọi yêu cầu ghi có cookie phải là `Content-Type: application/json` (form HTML không gửi được) - không cần token CSRF riêng. Không bật CORS.
- **Phân chia dữ liệu**: kết quả Daily (`daily_entry`), streak (`account_streak`) và nickname trên bảng xếp hạng (`account.nickname`) thuộc tài khoản. Khám phá, báo cáo, phiếu, sự kiện và đồng ý vẫn thuộc UUID; đồng ý `play` của UUID vẫn bắt buộc cho đăng nhập và nộp Daily. `PUT /me/nickname` có phiên thì đặt nickname tài khoản, không thì nickname UUID; `fold` không được trùng giữa hai bảng (kiểm trong cùng một câu lệnh ghi, D1 ghi tuần tự nên không có tranh chấp).
- **Daily**: `daily_entry` mỗi (tài khoản, version) một dòng, `solved_at` là thời điểm server nhận, `solve_ms = solved_at − batch_at`, `seq` tự tăng phân xử hòa tới ms; `day` (ngày GMT+7 của `batch_at`) là khóa streak và kỳ tuần/tháng. Bảng `daily_result`/`streak` theo UUID cũ giữ nguyên (migration chỉ mở rộng) nhưng không còn được ghi; dữ liệu cũ chỉ có ở staging (câu hỏi mở 34).
- **Xóa**: `DELETE /me` có phiên xóa `account`, `ON DELETE CASCADE` xóa phiên, `account_player`, `daily_entry`, `account_streak`; mọi UUID đã gắn được xóa như AC-PRIV-05 (AC-AUTH-06).
- **Giới hạn tần suất**: đăng nhập 10/phút theo IP băm (AC-AUTH-07); nộp Daily 10/phút theo tài khoản và theo IP băm (AC-DAILY-13) - dùng `rate_counter` sẵn có. Bộ đếm IP chạy cùng lượt với câu lệnh tra/gia hạn phiên và được xét trước, nên cookie giả hoặc phiên hết hạn cũng bị đếm; bộ đếm tài khoản chạy sau khi biết tài khoản. Nộp Daily không phải `application/json` → 415.
- **CSP**: trang game hiện không đặt CSP; nếu sau này đặt thì phải cho phép `https://accounts.google.com/gsi/` ở `script-src`, `frame-src`, `connect-src`, `style-src`.

## Hệ quả
- Thêm 1 thư viện runtime (`jose`) cho worker; thêm 1 secret `ACCOUNT_HASH_KEY` và var `GOOGLE_CLIENT_ID` (đã khai báo, hướng dẫn tài khoản mục 7).
- Mỗi yêu cầu có phiên tới endpoint cần phiên tốn 1 lượt ghi D1 để gia hạn - không đáng kể ở tải BRD; bảng xếp hạng chỉ tốn 1 lượt đọc.
- Google biết tài khoản đã đăng nhập vào game; trang chính sách phải nêu (AC-AUTH-06).
- Đổi `ACCOUNT_HASH_KEY` làm mọi tài khoản cũ không tìm lại được - coi khóa này như khóa vĩnh viễn.
- Kết quả và streak theo UUID trước khi đổi luật không chuyển sang tài khoản.
- Mỗi UUID gắn đúng một tài khoản, lần đăng nhập sau thắng: ai biết UUID của người khác (vốn đã là khóa chủ sở hữu theo ADR 0004) và đăng nhập Google của mình trên UUID đó sẽ chuyển gắn sang tài khoản mình, rồi `DELETE /me` của họ xóa luôn dữ liệu theo UUID đó. Không thêm quyền đọc mới so với ADR 0004; chấp nhận (câu hỏi mở 38, đã chốt 2026-10-21: giữ "lần sau thắng").
- Đăng nhập trên trình duyệt đang giữ phiên cũ thì phiên cũ bị thu hồi; `/me`, `/me/nickname`, `/me/streak`, `/auth/session` đặt lại cookie mỗi lần gia hạn.
- JWKS của Google cache 10 phút trong isolate (mặc định của `jose`), `kid` lạ thì tải lại.

## Phương án đã loại
- **Lưu JWT tự ký trong cookie (phiên không trạng thái)**: không thu hồi được khi đăng xuất/xóa tài khoản (AC-AUTH-05 đòi cookie cũ trả 401) trừ khi vẫn tra D1.
- **Lưu `sub` thô hoặc SHA-256 không khóa**: `sub` là định danh ổn định của Google; băm không khóa có thể đối chiếu nếu lộ cả danh sách `sub`. HMAC với secret tránh được.
- **Tự viết kiểm chữ ký RS256 bằng WebCrypto**: làm được nhưng dễ sai ở các chi tiết (chọn `kid`, `alg`, cache JWKS, `nbf`/`exp`); `jose` là thư viện chuẩn, nhỏ, đã được kiểm nhiều.
- **Cloudflare Access / dịch vụ đăng nhập bên ngoài (Auth0, Firebase Auth)**: thêm dịch vụ và có thể tốn phí, chuyển thêm dữ liệu người chơi ra bên thứ ba; không cần ở quy mô này.
- **Mã phiên trong `localStorage` gửi bằng header**: JavaScript đọc được (AC-AUTH-02 đòi HttpOnly), dễ lộ qua XSS.
