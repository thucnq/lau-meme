# Tiêu chí nghiệm thu - Chạy dưới đường dẫn con dinoduct.fun/lau-meme (SUBPATH)

> Component: worker, web, pipeline. Quyết định: Q15 trong `docs/input/ghi-chu-hop.md`, ADR 0007.
> Production `https://dinoduct.fun/lau-meme`, staging `https://staging.dinoduct.fun/lau-meme`. Gốc `dinoduct.fun/` do Redirect Rule
> của Cloudflare lo (người làm, không có trong repo). Các game trên dinoduct.fun chung origin.
> Nguồn duy nhất của tiền tố: file `base-path.json` ở gốc repo (`{"basePath": "/lau-meme"}`); web, Worker, test đọc từ đó.
> `manifest.graph_url` giữ dạng `/api/graph/<version>` và là đường dẫn **tương đối với tiền tố** (không đổi dữ liệu D1, không đổi pipeline).
> Test của Worker chạy trên static assets thật (`web/dist`) nên cần build web trước (thứ tự đã có trong CI và `.dk/stack.toml`).

### AC-SUBPATH-01: Một nguồn tiền tố, route đúng
- **Cho** `base-path.json`, `worker/wrangler.jsonc`, `.dk/stack.toml`
- **Khi** đọc cấu hình
- **Thì** biến `BASE_PATH` của Worker (production và `env.staging`) bằng `basePath` trong `base-path.json`; top-level có `routes` đúng một mục `{ pattern: "dinoduct.fun/lau-meme*", zone_name: "dinoduct.fun" }`, `env.staging` có đúng một mục `{ pattern: "staging.dinoduct.fun/lau-meme*", zone_name: "dinoduct.fun" }`; ngoài ra mỗi môi trường chỉ được thêm đúng một route cho host quản trị (ADR 0008): top-level `{ pattern: "laumeme-admin.dinoduct.fun/*", zone_name: "dinoduct.fun" }`, `env.staging` `{ pattern: "laumeme-admin-staging.dinoduct.fun/*", zone_name: "dinoduct.fun" }`; không có route nào khác (không `dinoduct.fun/*`, không gốc của `dinoduct.fun` hay `staging.dinoduct.fun`); `workers_dev` là `true`; `deploy.health` trong `.dk/stack.toml` là `/lau-meme/api/health`
- Ưu tiên: Bắt buộc

### AC-SUBPATH-02: API dưới tiền tố
- **Cho** Worker đã chạy migration
- **Khi** gọi `GET /lau-meme/api/health`, `GET /lau-meme/api/khong-co`
- **Thì** lần lượt 200 `{status: "ok", env, schema}` và 404 `application/problem+json`; các API khác (manifest, graph, daily, pipeline) cũng chỉ trả lời dưới `/lau-meme/api/*`
- Ưu tiên: Bắt buộc

### AC-SUBPATH-03: Thiếu dấu gạch chéo cuối
- **Cho** Worker đang chạy
- **Khi** gọi `GET /lau-meme` và `GET /lau-meme?ref=daily`
- **Thì** 301 với `Location` lần lượt là `/lau-meme/` và `/lau-meme/?ref=daily` (giữ query string)
- Ưu tiên: Bắt buộc

### AC-SUBPATH-04: Ngoài tiền tố là 404
- **Cho** Worker đang chạy (trên workers.dev mọi đường dẫn đều tới Worker)
- **Khi** gọi `GET /`, `GET /lau-meme-abc`, `GET /api/health`, `GET /index.html`, `GET /assets/x.js` (có và không có `Accept: text/html`)
- **Thì** tất cả trả 404, không trả HTML của game, không đụng D1
- Ưu tiên: Bắt buộc

### AC-SUBPATH-05: Vào game và F5 ở mọi màn hình
- **Cho** web đã build
- **Khi** điều hướng (GET, `Accept: text/html`) tới `/lau-meme/`, `/lau-meme/bat-ky`, `/lau-meme/a/b/c?x=1`
- **Thì** 200 `text/html` là nội dung `index.html` của game (có `<div id="root">`); request **không phải điều hướng** tới file không tồn tại (vd `GET /lau-meme/assets/khong-co.js` với `Accept: */*`) trả 404, không trả HTML; file tĩnh có thật dưới `/lau-meme/assets/` trả 200
- Ưu tiên: Bắt buộc

### AC-SUBPATH-06: Giữ chỗ đường dẫn ảnh
- **Cho** giai đoạn 1 (chưa có R2, AC-ART-05 ở giai đoạn 2)
- **Khi** gọi `GET /lau-meme/img/0123456789ab.webp` (có `Accept: text/html` hoặc không)
- **Thì** Worker trả 404 `application/problem+json`, không trả HTML của game (để giai đoạn 2 chỉ cần thêm handler)
- Ưu tiên: Bắt buộc

### AC-SUBPATH-07: Web không gọi ra ngoài tiền tố
- **Cho** web build bằng cấu hình thật (`vite build`)
- **Khi** quét mọi file `.html`, `.js`, `.css` trong thư mục build và đọc các URL mà `api.ts` gọi
- **Thì** file `index.html` nằm ở `<outDir>/lau-meme/index.html`, asset ở `<outDir>/lau-meme/assets/`; không có chuỗi `"/api/`, `'/api/`, `` `/api/ ``, `"/img/`, `"/assets/`, `href="/`, `src="/`, `url(/` nào thiếu tiền tố `/lau-meme/`; `getHealth`/`getManifest`/`getBlocklist` fetch `/lau-meme/api/health|manifest|blocklist`; `getGraph` với `graph_url = "/api/graph/12"` fetch `/lau-meme/api/graph/12`
- Ưu tiên: Bắt buộc

### AC-SUBPATH-08: Mọi khóa localStorage có tiền tố `laumeme:`
- **Cho** localStorage trống
- **Khi** mở game, ghép vài món, đổi giao diện sáng/tối, ghép ra Món đặc biệt
- **Thì** mọi khóa trong localStorage bắt đầu bằng `laumeme:`; khi localStorage ném lỗi ở mọi thao tác (bị chặn), game vẫn chạy và không ném lỗi ra ngoài
- Ưu tiên: Bắt buộc

### AC-SUBPATH-09: Chuyển khóa cũ một lần
- **Cho** localStorage có `lm.game.progress`, `lm.theme`, `lau-meme:daily-challenge` (bản trước khi đổi tiền tố)
- **Khi** game khởi động
- **Thì** giá trị được chuyển sang `laumeme:game.progress`, `laumeme:theme`, `laumeme:daily-challenge` và khóa cũ bị xóa; tiến độ cũ hiện đủ trên Đĩa; nếu khóa mới đã có thì giữ khóa mới và chỉ xóa khóa cũ; chạy lại lần hai không đổi gì; khóa của game khác (không thuộc danh sách trên) không bị đụng
- Ưu tiên: Bắt buộc

### AC-SUBPATH-10: Link chia sẻ tuyệt đối
- **Cho** biến build `VITE_SITE_URL` không đặt (mặc định `https://dinoduct.fun/lau-meme/`)
- **Khi** tạo link chia sẻ với `ref` = `daily` và `disc`
- **Thì** ra `https://dinoduct.fun/lau-meme/?ref=daily` và `https://dinoduct.fun/lau-meme/?ref=disc` (AC-SHARE dùng helper này)
- Ưu tiên: Bắt buộc

### AC-SUBPATH-11: Thẻ xem trước link và favicon
- **Cho** web build bằng cấu hình thật
- **Khi** đọc `<head>` của `index.html` đã build
- **Thì** có `<link rel="canonical" href="https://dinoduct.fun/lau-meme/">`, `og:url` = `https://dinoduct.fun/lau-meme/`, `og:title` = `Lẩu Meme`, `og:image` là URL tuyệt đối bắt đầu bằng `https://dinoduct.fun/lau-meme/`, `twitter:card`; `<title>` là `Lẩu Meme`; favicon `href` bắt đầu bằng `/lau-meme/`. Mô tả và ảnh OG chính thức chờ câu hỏi mở 18
- Ưu tiên: Bắt buộc

### AC-SUBPATH-12: Pipeline gọi API dưới tiền tố
- **Cho** `API_BASE_URL = https://dinoduct.fun/lau-meme` và adapter HTTP được mock ở tầng kết nối
- **Khi** mẻ nhúng gọi state/đăng/gắn Issue và workflow rollback gọi rollback
- **Thì** đường dẫn gửi đi lần lượt là `/lau-meme/api/pipeline/state`, `/lau-meme/api/pipeline/batches`, `/lau-meme/api/pipeline/batches/<id>`, `/lau-meme/api/pipeline/rollback`; `manifest.graph_url` vẫn là `/api/graph/<version>`
- Ưu tiên: Bắt buộc
