# 0012 - Ảnh minh họa: vẽ bằng Workers AI qua REST, kiểm bằng Gemini, tải lên R2 qua Worker

- Trạng thái: Đã chấp nhận (2026-10-21, cổng contract duyệt tại 02bca48)
- Ngày: 2026-10-21
- Nguồn: ART (AC-ART-01..04; AC-ART-09/10 thêm 2026-10-21 ghi lại các quyết định dưới đây thành tiêu chí nghiệm thu), ADR 0009 (kho pipeline), ADR 0011 (Gemini qua REST), câu hỏi mở 13

## Bối cảnh
PR #35 đã có logic thuần của ART (`pipeline/src/lau_meme_pipeline/art.py`: prompt, vẽ lại một lần, chờ vẽ, WebP theo băm), Worker phục vụ `/img/{key}` từ R2 và web hiện ảnh. Còn thiếu ba adapter để mẻ `full` có ảnh thật:
- vẽ ảnh,
- kiểm ảnh,
- đưa ảnh lên R2.

Ngoài ra kho pipeline phải nhớ phần tử "chờ vẽ" qua các đợt.

Pipeline chạy trên GitHub Actions, gói Cloudflare free. Hạn mức Workers AI gói free chưa kiểm (câu hỏi mở 13), và đợt phải xong trong 15 phút.

## Quyết định
- **Vẽ:** Workers AI qua REST `POST https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/ai/run/<model>`.
  - Model mặc định `@cf/black-forest-labs/flux-1-schnell`, đổi bằng variable `WORKERS_AI_MODEL`.
  - Gọi bằng `http.client`, cùng kiểu adapter với ADR 0011.
  - Khóa là GitHub Environment secret `WORKERS_AI_TOKEN`: API token chỉ có quyền **Workers AI** (Read + Edit) trên account này, khác `CLOUDFLARE_API_TOKEN` dùng để deploy.
  - Ánh xạ lỗi: HTTP 429 hoặc lỗi hết phân bổ ngày → `QuotaExhausted`, và phần còn lại vào "chờ vẽ" (AC-ART-03). 5xx → thử lại theo backoff, hết lượt thì phần tử chờ vẽ. 400/413/422 → `DrawRejected`: lần vẽ đó hỏng (tính vào 2 lần vẽ, rồi về emoji). 401/403/404 (và `API_KEY_INVALID` của Gemini) → `ArtConfigError`: lỗi token, account hoặc model, bước vẽ dừng ngay, mọi phần tử giữ nguyên chờ vẽ và không bị tính lần thử; báo cáo đợt ghi cảnh báo cấu hình.
  - Chỉ đọc dạng trả lời của Flux (`result.image` base64). Đổi `WORKERS_AI_MODEL` sang model trả ảnh thô thì mọi lần vẽ đều lỗi.
  - **Chạy lại cho cùng ảnh (AC-PIPE-10, AC-INV-05):** gửi `seed` = 8 hex đầu của SHA-256(prompt + số lần đã hỏi prompt đó trong lần chạy). Cùng mẻ chạy lại thì cùng seed, nên cùng ảnh và cùng khóa (với điều kiện model giữ nguyên); lần vẽ lại trong cùng mẻ là seed mới.
- **Kiểm ảnh:** Gemini (ADR 0011, cùng khóa `GEMINI_API_KEY`), bước mới `check_image`.
  - Gửi ảnh dạng `inline_data` và nhận `{ok, reason}`.
  - `reason` thuộc 5 lý do của AC-ART-02. Lý do lạ được quy về `banned_category`.
  - Ảnh do máy vẽ, không phải dữ liệu người chơi (AC-PIPE-13).
- **Giải mã ảnh không tin cậy:** Pillow với `Image.MAX_IMAGE_PIXELS = 4096²` (vượt thì ném lỗi), chỉ nhận định dạng PNG/JPEG/WEBP, đầu vào tối đa 8 MB. Ảnh không giải mã được tính là một lần vẽ hỏng.
- **Tải lên:** endpoint mới `PUT /api/pipeline/images/{key}` dùng `PIPELINE_TOKEN`.
  - Thân `image/webp`, tối đa 512 KB.
  - Worker kiểm `key` = 12 hex đầu SHA-256 của thân và chữ ký `RIFF....WEBP`, rồi ghi `img/<key>` qua binding `IMG`.
  - Object đã có thì không ghi lại.
  - Pipeline tải ảnh trước khi đăng mẻ. Mẻ lỗi thì ảnh mồ côi vô hại, vì khóa theo nội dung và không ai tham chiếu.
- **Thiếu `WORKERS_AI_TOKEN` hoặc `CLOUDFLARE_ACCOUNT_ID`:** mẻ `full` vẫn chạy, bỏ bước vẽ, phần tử mới vào "chờ vẽ" và báo cáo đợt ghi cảnh báo. Khác `GEMINI_API_KEY`: thiếu khóa Gemini thì đợt `full` thất bại (ADR 0011), vì không kiểm duyệt được meme.
- **Lỗi tạm thời** (mạng, 5xx, tải lên): phần tử chờ vẽ; `art_attempts` trong kho chỉ tăng ở đợt mà bước vẽ vẫn chạy được với phần tử khác (có ảnh vẽ được hoặc bị kiểm), vì nếu không thì đó là sự cố chung (mạng, Worker). Sau **3 đợt** như vậy thì giữ emoji, để một phần tử hỏng không chiếm suất vẽ mãi. Báo cáo đợt đếm lỗi theo loại, để token sai (401) không bị che thành "chờ vẽ".
- **Ngân sách thời gian:** bước vẽ dừng sau 8 phút, phần còn lại chờ vẽ, để cả đợt xong trong 15 phút.
- **Kiểm đúng ảnh được đăng:** ảnh của model được chuyển WebP 256×256 trước, Gemini kiểm chính các byte đó, rồi mới tải lên.
- **Phần tử chưa có gợi ý ảnh** chỉ bị bỏ qua, không đánh dấu giữ emoji; đợt sau có gợi ý thì vẽ. Gợi ý bị kiểm duyệt loại thì giữ emoji luôn.
- **Danh sách chờ vẽ** lưu tối đa 2000 id; phần dư được tìm lại từ kho ở đợt sau.
- **Giới hạn:** tối đa **20 ảnh mỗi đợt** (người chọn 2026-10-21). Phần vượt vào "chờ vẽ" và được vẽ trước ở đợt sau. Mỗi ảnh tối đa 2 lần vẽ (AC-ART-02).
- **Kho:** `PipelineStore.art_pending` (id phần tử chờ vẽ). Phần tử trend trong kho giữ `image_key`.
  - Worker nhận thêm khóa `art_pending` (danh sách khóa hợp lệ của `store`).
  - Không cần migration, vì kho là JSON (ADR 0009).
- **Báo cáo đợt:** số ảnh đã vẽ, số bị loại theo lý do, số chờ vẽ, số lượt gọi Workers AI. Chỉ ghi trong Issue, không đổi `BatchStats`.

## Hệ quả
- Thêm một endpoint, một khóa trong `PipelineStore`, hai cấu hình GitHub (`WORKERS_AI_TOKEN` secret; `CLOUDFLARE_ACCOUNT_ID`, `WORKERS_AI_MODEL` variable). Không thêm thư viện ngoài Pillow (đã có từ PR #35).
- Không cần token S3 của R2. Mục 6.3 của hướng dẫn tài khoản bỏ; token đã tạo thì xóa trên dashboard.
- Worker kiểm nội dung trước khi ghi R2, nên token pipeline bị lộ cũng chỉ ghi được ảnh WebP đúng khóa băm, không ghi đè ảnh có sẵn.
- Ảnh đã phục vụ là bất biến một năm. Gỡ ảnh xấu đã lên = chặn ảnh (client không tải, AC-ART-07), xóa object R2 và purge URL (runbook).

## Phương án đã loại
- **S3 API của R2 từ pipeline:** cần thêm 2 secret và tự ký SigV4 (hoặc thêm boto3). R2 cũng nhận bất kỳ nội dung nào mà không có lớp kiểm.
- **Gemini tạo ảnh:** gói free của Gemini API không gồm tạo ảnh.
- **Vẽ trong Worker (binding `AI`):** request tới Worker có giới hạn thời gian và CPU, và vẽ không gắn với mẻ. Vẽ trong pipeline giữ đúng thứ tự kiểm duyệt rồi đăng (AC-PIPE-11).
