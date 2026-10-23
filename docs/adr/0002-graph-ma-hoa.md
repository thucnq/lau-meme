# 0002 - Graph mã hóa: khóa tra cứu băm, AES-256-GCM với khóa dẫn xuất từ 2 tên

- Trạng thái: Đề xuất
- Ngày: 2026-10-20

## Bối cảnh
Graph phải tải hết về trình duyệt để ghép < 50 ms không gọi mạng (AC-GAME-14), nhưng không được lộ cây công thức dạng đọc được (AC-GRAPH-01..03, AC-INV-04). Pipeline phải xuất byte-giống-hệt khi chạy lại (AC-INV-05, AC-PIPE-10). Worker phải kiểm lại khám phá và đường ghép Daily mà không cần tên dạng rõ trong phản hồi (AC-DISC-07, AC-DAILY-06). Danh sách chặn chỉ được chứa mã/băm (AC-REPORT-06).

## Quyết định
Ký hiệu: `fold(s)` là hàm chuẩn hóa đã có ở pipeline (`text.fold`, AC-HEALTH-03: đ→d, NFD rồi bỏ dấu thanh/dấu mũ, chữ thường, gộp khoảng trắng - **không** bỏ dấu câu; bỏ dấu câu là bước riêng của khử trùng AC-PIPE-05 và lọc nickname AC-DISC-03), cài lại y hệt bằng TypeScript cho web và worker; cả ba dùng chung một file vector kiểm thử (`pipeline/tests/golden/fold-vectors.json`).
`added_version` của phần tử lõi classic là `0`. `b64u` = base64url không đệm. Với cặp tên (a, b): `x, y` = `fold(a), fold(b)` sắp xếp tăng dần theo byte UTF-8.

| Thứ | Công thức |
|---|---|
| Id phần tử | `b64u(SHA-256("lm1|e|" + fold(tên)))` - 43 ký tự |
| Khóa tra cứu = id công thức | `b64u(SHA-256("lm1|k|" + x + "\0" + y))` - trùng nhau cho (a, b) và (b, a) |
| Khóa + IV | `HKDF-SHA256(ikm = x + "\0" + y, salt = "lm1|graph|v" + version, info = "lm1|aes-gcm", L = 44)` → 32 byte khóa + 12 byte IV |
| Mục graph | `entries[khóa tra cứu] = b64u(AES-256-GCM(khóa, IV, bản rõ, aad = khóa tra cứu))` |
| Bản rõ | JSON chuẩn (khóa sắp xếp, không khoảng trắng) của `GraphResult`: `id, name, emoji, depth, added_version, image_key` |
| Món đặc biệt | manifest chỉ có `element_id` của món; client so với `id` của kết quả vừa giải mã |

- Mọi chuỗi mã hóa UTF-8. Salt chứa version ⇒ mỗi (cặp, version) có khóa riêng, nên IV tất định không bao giờ bị dùng lại cho hai bản rõ khác nhau dưới cùng khóa; nhờ đó cùng đầu vào cho ra cùng byte.
- Giải mã sai (thiếu tên, sai tên) ⇒ thẻ GCM không khớp ⇒ client coi như ghép trượt (AC-GRAPH-02).
- Thư viện: WebCrypto (`crypto.subtle`: SHA-256, HKDF, AES-GCM) trên trình duyệt và Worker - không thêm dependency; Python dùng `cryptography` (HKDF, AESGCM) - thêm 1 dependency vào `pipeline/pyproject.toml`.
- Manifest chỉ chứa dạng đọc được của 4 phần tử khởi đầu.

## Hệ quả
- Đã biết 2 tên thì giải được 1 mục: graph chống đọc trộm cả cây, **không** chống dò từng cặp hay dò từ điển tên - chấp nhận theo BRD mục 8.
- Đổi `fold` là đổi mọi id ⇒ phải coi `fold` như một phần của định dạng (`lm1`); đổi thì tăng tiền tố (`lm2`) và `format` của graph.
- Kích thước: ~200 byte/mục (khóa 43 + bản mã base64url) ⇒ lõi 518 công thức ≈ 105 KB, gzip nhỏ hơn; mỗi lượt tra = 1 SHA-256 + 1 HKDF + 1 AES-GCM, đo trong AC-GAME-14.

## Phương án đã loại
- IV ngẫu nhiên mỗi mục: phá tính idempotent byte-giống-hệt (AC-INV-05).
- KDF chậm (PBKDF2 nhiều vòng, Argon2): làm chậm dò cặp nhưng phá ngân sách < 50 ms và không có Argon2 trong WebCrypto.
- XChaCha20-Poly1305 / libsodium: không có trong WebCrypto, phải nhúng thư viện vào bundle.
- Graph dạng rõ + làm rối (obfuscation): vi phạm AC-GRAPH-03.
