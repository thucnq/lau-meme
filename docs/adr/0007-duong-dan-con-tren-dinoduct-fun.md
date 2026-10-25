# 0007 - Đường dẫn con trên dinoduct.fun

- Trạng thái: Đã chấp nhận (2026-10-20)
- Ngày: 2026-10-20
- Nguồn: Q15 trong `docs/input/ghi-chu-hop.md`; đóng câu hỏi mở 7

## Bối cảnh
dinoduct.fun (mua qua Cloudflare Registrar) là thương hiệu chứa nhiều game, giống neal.fun. Lẩu Meme là game đầu tiên. Game sau có thể nằm ở repo khác. Repo này trước đây giả định game chạy ở gốc `/`: Vite không có `base`, API ở `/api/*`, Worker gửi mọi đường dẫn khác cho static assets ở chế độ SPA.

## Quyết định
- Địa chỉ game là `https://dinoduct.fun/lau-meme/`, staging là `https://staging.dinoduct.fun/lau-meme/`. Staging dùng cùng đường dẫn con để lỗi thiếu tiền tố lộ ra trước khi lên production.
- Worker gắn bằng **route** `dinoduct.fun/lau-meme*` (production) và `staging.dinoduct.fun/lau-meme*` (staging), không dùng Custom Domain. Custom Domain trỏ *mọi* đường dẫn của một host vào Worker và bỏ qua path khi khớp, nên không gắn được vào một đường dẫn con.
- Mỗi repo chỉ khai báo route của đường dẫn mình. Repo này **không** khai báo `dinoduct.fun/*` hay gốc. Gốc `/` tạm thời do Redirect Rule của Cloudflare (người cấu hình, không nằm trong code) chuyển 302 về `/lau-meme/`. Khi có hub thì gỡ rule này và hub tự gắn route của nó.
- **Ngoại lệ `/robots.txt` (thêm 2026-10-25, AC-SUBPATH-15):** gốc miền không có máy chủ nên `/robots.txt` trả 522, và bot của Meta coi đó là bị chặn (403 khi kiểm trang chính sách cho App Review của Threads). Repo này khai thêm route `dinoduct.fun/robots.txt` và `staging.dinoduct.fun/robots.txt`. Production cho mọi bot; staging chỉ cho `facebookexternalhit`. robots.txt áp cho cả miền, nên khi có hub thì hub giữ file này và gỡ hai route khỏi repo.
- Tiền tố chỉ có một nguồn: `base-path.json` ở gốc repo. Vite đọc file này để đặt `base` và thư mục build (`dist/lau-meme/`). Worker nhận biến `BASE_PATH`. Pattern route trong `wrangler.jsonc` buộc phải viết chuỗi, nên có test (AC-SUBPATH-01) so khớp các chỗ này với nhau.
- Worker chạy trước static assets (`run_worker_first`, trừ `/lau-meme/assets/*` là file có hash). Worker tự xử lý:
  - đường dẫn ngoài `/lau-meme/` (kể cả `/lau-meme-abc`, mà pattern `lau-meme*` vẫn khớp) trả 404. Hệ quả: mọi slug bắt đầu bằng `lau-meme` (vd `/lau-meme2`) coi như **dành riêng** cho game này. Game khác không được đặt slug như vậy; nếu cần thì đổi route thành hai pattern `…/lau-meme` và `…/lau-meme/*`;
  - `/lau-meme` trả 301 về `/lau-meme/`;
  - API nằm dưới `/lau-meme/api/*`, ảnh dưới `/lau-meme/img/*`;
  - request điều hướng không khớp file nào được trả `/lau-meme/index.html`.

  Lý do không dùng `not_found_handling: "single-page-application"`: theo tài liệu Cloudflare, chế độ này luôn trả `/index.html` ở **gốc**, không có cơ chế chọn index gần nhất trong thư mục con.
- `manifest.graph_url` giữ dạng `/api/graph/<v>` và được hiểu là đường dẫn **tương đối với tiền tố**. Client tự nối tiền tố. Nhờ vậy dữ liệu trong D1 và pipeline không bị trói vào `/lau-meme`. Pipeline lấy tiền tố từ secret `API_BASE_URL` (`https://dinoduct.fun/lau-meme`).
- Thẻ OG/Twitter, canonical và link chia sẻ dùng URL tuyệt đối lấy từ biến build `VITE_SITE_URL` (mặc định `https://dinoduct.fun/lau-meme/`).

## Hệ quả - chung origin
Mọi game trên dinoduct.fun có chung origin `https://dinoduct.fun`, nên chung localStorage, sessionStorage, IndexedDB, cookie không giới hạn Path, Cache Storage và quyền của trình duyệt. Script của game này đọc và ghi được dữ liệu của game kia.
- Mọi khóa storage có tiền tố `laumeme:` và chỉ đi qua `web/src/storage.ts`, có try/catch khi storage bị chặn. Khóa cũ (`lm.*`, `lau-meme:*`) được chuyển một lần khi khởi động.
- Tiền tố chỉ tránh **đụng khóa**, không phải ranh giới bảo mật. Vì vậy phía client không lưu token, bí mật hay dữ liệu cá nhân nào ngoài UUID ẩn danh (ADR 0004). Trang quản trị dự kiến giữ token trong `sessionStorage`, đây là rủi ro trên origin chung (câu hỏi mở 19).
- Cookie (hiện không có) phải đặt `Path=/lau-meme`. Service worker (hiện không có) phải có scope `/lau-meme/`. Header bảo mật và CSP chỉ do Worker này đặt trên response của chính nó, nên không lan ra đường dẫn của game khác.
- Mọi request của game đều nằm dưới `/lau-meme/`. Test quét bundle build để chặn đường dẫn tuyệt đối thiếu tiền tố (AC-SUBPATH-07).

## Phương án đã cân nhắc
- **Tên miền con** (`laumeme.dinoduct.fun`, Custom Domain): mỗi game có origin riêng, nên storage tách hẳn, gắn đơn giản và không cần xử lý tiền tố. Không chọn vì dinoduct.fun được định vị là một trang chứa nhiều game theo đường dẫn (kiểu neal.fun), link `dinoduct.fun/lau-meme` dễ nhớ và chia sẻ hơn, và một chứng chỉ, một host gom hết lượt truy cập. Đổi lại phải chấp nhận origin chung như mô tả ở trên.
- **Worker hub duy nhất cho cả dinoduct.fun** chuyển tiếp tới từng game: thêm một tầng phải deploy chung, ràng buộc các repo vào nhau. Không cần khi route theo đường dẫn đã đủ.
- **SPA fallback của static assets**: không hỗ trợ index ở thư mục con (xem trên).
- **Ghi `graph_url` tuyệt đối `/lau-meme/api/graph/<v>`**: đổi tiền tố sẽ phải migrate dữ liệu và sửa pipeline.
