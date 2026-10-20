# 0008 — Trang quản trị ở tên miền con riêng

- Trạng thái: Đã chấp nhận (2026-10-20) — chờ `/dk:approve spec` + `/dk:approve contract` cho thay đổi contract và AC-ADMIN-10
- Ngày: 2026-10-20
- Nguồn: câu hỏi mở 19, chốt 2026-10-20: "Trang quản trị ở subdomain"

## Bối cảnh
Trang quản trị (ADMIN) giữ `ADMIN_TOKEN` trong `sessionStorage` (AC-ADMIN-10). Theo ADR 0007, game chạy ở `dinoduct.fun/lau-meme` và dùng chung origin `https://dinoduct.fun` với hub và các game sau. Storage thuộc về origin, nên script của bất kỳ trang nào trên `dinoduct.fun` cũng đọc được token. Tiền tố khóa `laumeme:` không ngăn được việc này. Vì vậy trang quản trị phải chạy ở một origin khác.

## Quyết định
- **Host:** `laumeme-admin.dinoduct.fun` (production) và `laumeme-admin-staging.dinoduct.fun` (staging).
  - Chỉ dùng tên miền con một cấp, vì Universal SSL chỉ phủ `*.dinoduct.fun`; `admin.staging.dinoduct.fun` cần Advanced Certificate.
  - Tên có tiền tố `laumeme-`, để game sau có origin quản trị riêng chứ không dùng chung `admin.dinoduct.fun`.
- **Cùng một Worker:** thêm route `laumeme-admin.dinoduct.fun/*` vào top-level `wrangler.jsonc`, và `laumeme-admin-staging.dinoduct.fun/*` vào `env.staging`. Biến mới `ADMIN_HOST` để Worker nhận ra host quản trị.
- **Định tuyến trong Worker:**
  - Trên host quản trị: `/` trả trang quản trị (entry Vite riêng `web/admin.html`, build ra `web/dist/admin/`), `/api/admin/*` là API quản trị. Mọi đường dẫn khác trả 404.
  - Trên host game: `/lau-meme/api/admin/*` trả **404**. Token chỉ được gửi tới origin quản trị, và trang game không bao giờ gọi được API quản trị (phòng thủ nhiều lớp).
  - Cùng origin nên không cần CORS. API `/pipeline/*` giữ nguyên trên host game.
- **Header của trang quản trị:**
  - `X-Robots-Tag: noindex, nofollow`, kèm `<meta name="robots" content="noindex">`.
  - `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`.
  - `Referrer-Policy: no-referrer`.
  - `Cache-Control: no-store` cho HTML.
- **Liên kết tới chính sách:** trang quản trị chỉ link tuyệt đối tới `https://dinoduct.fun/lau-meme/chinh-sach` (AC-PRIV-01).
- **Người làm (DNS/Cloudflare):** thêm bản ghi DNS proxied cho hai host trên (cùng cách với `staging`, xem `docs/dev/huong-dan-tai-khoan.md`). Deploy production vẫn là việc của người.

## Thay đổi đã làm theo ADR (cần duyệt trước khi build)
- `docs/api/openapi.yaml`: mỗi path `/admin/*` có `servers` riêng là host quản trị (`/api` trên `https://laumeme-admin.dinoduct.fun`).
- `docs/acceptance/admin.md` AC-ADMIN-10: mở `https://laumeme-admin.dinoduct.fun/`; `/lau-meme/api/admin/*` trên host game trả 404; header `X-Robots-Tag` + CSP.
- `docs/acceptance/subpath.md` AC-SUBPATH-01: cho phép đúng thêm một route host quản trị mỗi môi trường (chốt 2026-10-20 khi build ADMIN).
- `/dk:approve spec` và `/dk:approve contract` sau khi sửa.

## Hệ quả
- Token quản trị không chung origin với game hay hub. XSS ở game không đọc được token.
- Thêm một entry build và nhánh định tuyến theo host trong Worker. Test worker cần gọi với `Host` của tên miền quản trị.
- Thêm 2 bản ghi DNS và 2 route; chứng chỉ do Universal SSL cấp sẵn.

## Phương án đã loại
- **Đường dẫn con `dinoduct.fun/lau-meme/admin`:** chung origin, lộ token (câu hỏi mở 19).
- **`admin.dinoduct.fun` dùng chung cho mọi game:** các game sau lại chung origin quản trị với nhau.
- **Worker riêng cho trang quản trị:** thêm một dự án phải deploy, và phải truy cập chung D1. Không cần ở quy mô này.
- **Cloudflare Access trước trang quản trị:** an toàn hơn và có thể thêm sau, nhưng không thay được việc tách origin cho token.
