# API - Lẩu Meme

> Nguồn sự thật: [`openapi.yaml`](openapi.yaml) (OpenAPI 3, `lau-meme API 0.8.0`). File này chỉ là mục lục; khi hai nơi khác nhau thì `openapi.yaml` đúng. Mỗi endpoint mang `x-ac` trỏ về AC trong `docs/acceptance/`.

## Địa chỉ
| Nhóm | Production | Staging |
|---|---|---|
| Game, pipeline (ADR 0007) | `https://dinoduct.fun/lau-meme/api` | `https://staging.dinoduct.fun/lau-meme/api` |
| Quản trị (ADR 0008) | `https://laumeme-admin.dinoduct.fun/api` | `https://laumeme-admin-staging.dinoduct.fun/api` |

Trên host game, `/lau-meme/api/admin/*` trả 404; trên host quản trị chỉ có `/api/admin/*` và trang quản trị.

## Xác thực
| Scheme | Cách gửi | Dùng cho |
|---|---|---|
| - | không cần | đọc công khai (`/health`, `/manifest`, `/graph`, `/blocklist`, bảng xếp hạng…) |
| `PlayerId` | header `X-Player-Id: <UUID v4>` sinh ở client | định danh ẩn danh người chơi, **không phải** xác thực; sai định dạng → 400 |
| `Session` | cookie `laumeme_sid` (HttpOnly, Secure, SameSite=Lax, Path=/lau-meme) đặt bởi `POST /auth/google` | thực khách đã đăng nhập Google: nộp Daily, streak của mình, nickname tài khoản; hết hạn sau 90 ngày không dùng (ADR 0010) |
| `PipelineToken` | `Authorization: Bearer <PIPELINE_TOKEN>` | `/pipeline/*`, `/metrics/summary` |
| `AdminToken` | `Authorization: Bearer <ADMIN_TOKEN>` | `/admin/*`, `/metrics/summary`; 5 lần sai/phút/IP băm ⇒ khóa 15 phút (429 + `Retry-After`) |

Cách đặt token: `docs/dev/huong-dan-tai-khoan.md` mục 4.2.

## Lỗi
Mọi lỗi là RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`), chữ tiếng Việt. Giới hạn tần suất trả 429 kèm `Retry-After`. `/manifest` trả 503 khi môi trường chưa có mẻ nhúng nào.

## Endpoint
Đường dẫn tính từ địa chỉ của nhóm ở trên.

### Công khai và người chơi
| Method | Path | Mô tả | Xác thực | AC chính |
|---|---|---|---|---|
| GET | `/health` | Trạng thái Worker và schema D1 | - | AC-HEALTH-01 |
| GET | `/manifest` | Manifest của version hiện hành (503 nếu chưa có mẻ) | - | AC-GRAPH-04, AC-GRAPH-06 |
| GET | `/graph/{version}` | Graph mã hóa của một version (bất biến), mỗi phần tử có tier 1-5 | - | AC-GRAPH-01..04, AC-TIER-01..03 |
| GET | `/creators/{version}` | Người tạo meme đóng góp có trong một version (`null` = ẩn danh; không bất biến, `max-age=300`) | - | AC-CONTRIB-10, AC-CONTRIB-12 |
| GET | `/blocklist` | Danh sách chặn nóng (phần tử, công thức, ảnh) | - | AC-REPORT-04..07, AC-ADMIN-03/04 |
| POST | `/consents` | Ghi / rút đồng ý (append-only) | PlayerId | AC-PRIV-02..04, AC-PRIV-09 |
| POST | `/auth/google` | Đăng nhập bằng ID token Google, mở phiên | PlayerId | AC-AUTH-01, AC-AUTH-03, AC-AUTH-04, AC-AUTH-07 |
| GET | `/auth/session` | Phiên hiện tại (gia hạn) | Session | AC-AUTH-02 |
| DELETE | `/auth/session` | Đăng xuất | - hoặc Session | AC-AUTH-05 |
| GET | `/me` | Xem / xuất dữ liệu của tôi (có phiên thì kèm tài khoản, Đĩa và đề xuất meme) | PlayerId (+ Session) | AC-PRIV-08, AC-AUTH-06, AC-CONTRIB-12, AC-SYNC-10 |
| DELETE | `/me` | Xóa dữ liệu của tôi (có phiên thì xóa cả tài khoản và Đĩa) | PlayerId (+ Session) | AC-PRIV-05, AC-AUTH-06, AC-CONTRIB-12, AC-SYNC-10 |
| GET | `/me/plate` | Đĩa của tài khoản (gộp mọi máy), không gồm 4 phần tử khởi đầu | PlayerId + Session | AC-SYNC-02, AC-SYNC-05, AC-SYNC-08 |
| POST | `/me/plate` | Ghi một món vừa ghép ra vào Đĩa của tài khoản (gửi lại vẫn 200) | PlayerId + Session | AC-SYNC-01, AC-SYNC-04..06, AC-SYNC-09 |
| POST | `/me/plate/merge` | Gộp nhiều món vào Đĩa sau đăng nhập hoặc gửi bù (tối đa 500 mục) | PlayerId + Session | AC-SYNC-03, AC-SYNC-06, AC-SYNC-09 |
| PUT | `/me/nickname` | Đặt / đổi nickname (có phiên thì của tài khoản) | PlayerId (+ Session) | AC-DISC-02..04, AC-DISC-12, AC-AUTH-04 |
| GET | `/me/streak` | Streak của tài khoản | Session | AC-DAILY-10 |
| GET | `/discoveries` | Công thức gia truyền của các phần tử | - | AC-DISC-09 |
| POST | `/discoveries` | Gửi khám phá (ghi người đầu tiên) | PlayerId | AC-DISC-05..08, AC-DISC-10..12 |
| POST | `/daily/{version}/results` | Nộp cặp ghép ra Món đặc biệt | PlayerId + Session | AC-DAILY-06..08, AC-DAILY-13 |
| GET | `/daily/{version}/leaderboard` | Bảng xếp hạng mẻ (top 20) | - hoặc Session | AC-DAILY-09 |
| GET | `/daily/leaderboard?period=2026-W43` | Bảng xếp hạng tuần / tháng (top 20) | - hoặc Session | AC-DAILY-14 |
| GET | `/streaks/leaderboard` | Bảng xếp hạng streak (top 20) | - | AC-DAILY-11 |
| POST | `/reports` | Báo cáo phần tử hoặc ảnh | PlayerId | AC-REPORT-01..05, AC-REPORT-08 |
| PUT | `/votes` | Bỏ phiếu Ngon / Nhạt cho công thức | PlayerId | AC-FEEDBACK-01..03 |
| POST | `/events` | Gửi lô sự kiện ẩn danh | PlayerId | AC-METRIC-02..04, AC-SHARE-06 |
| GET | `/img/{key}` | Ảnh minh họa từ R2 (giai đoạn 2; ngoài `/api`: `/lau-meme/img/{key}`) | - | AC-ART-05 |

### Đóng góp meme (CONTRIB, ADR 0013)
| Method | Path | Mô tả | Xác thực | AC chính |
|---|---|---|---|---|
| POST | `/contributions` | Gửi đề xuất meme từ cặp 2 phần tử có sẵn | PlayerId + Session | AC-CONTRIB-01..05 |
| GET | `/contributions/{id}` | Một đề xuất của tôi | Session | AC-CONTRIB-06 |
| GET | `/me/contributions` | Đề xuất của tôi (mới nhất trước) | Session | AC-CONTRIB-06 |
| GET | `/contributors/leaderboard` | Top cống hiến (top 20 cố định) | - hoặc Session | AC-CONTRIB-11, AC-CONTRIB-12 |

### Pipeline
| Method | Path | Mô tả | Xác thực | AC chính |
|---|---|---|---|---|
| GET | `/pipeline/state` | Trạng thái cần cho mẻ mới (thêm `admin_blocked`, `daily_pin`) | PipelineToken | AC-PIPE-13, AC-DAILY-01 |
| GET | `/pipeline/store` | Kho pipeline giai đoạn 2 của version hiện hành hoặc `?version=` (ADR 0009) | PipelineToken | AC-PIPE-07, AC-PIPE-10 |
| PUT | `/pipeline/images/{key}` | Tải ảnh WebP đã kiểm duyệt lên R2; Worker kiểm khóa = sha256 nội dung (ADR 0012) | PipelineToken | AC-ART-04 |
| PUT | `/pipeline/banned-terms/{source}` | Thay toàn bộ từ cấm của một nguồn (`wordlist`, `mod`) | PipelineToken | AC-DISC-03, AC-MOD-06 |
| POST | `/pipeline/batches` | Đăng một version mới (nguyên tử, mẻ `full` kèm `store`; khi có chỉ định thì kèm `daily_pin_id` và `stats.daily_pin`, AC-DAILY-19) hoặc ghi đợt lỗi | PipelineToken | AC-PIPE-01, AC-PIPE-11, AC-GRAPH-05 |
| PATCH | `/pipeline/batches/{id}` | Gắn link GitHub Issue báo cáo đợt | PipelineToken | AC-PIPE-14 |
| POST | `/pipeline/rollback` | Về version trước (hoặc version chỉ định) | PipelineToken | AC-GRAPH-06/07 |
| GET | `/metrics/summary` | Số liệu tổng hợp một ngày GMT+7 | PipelineToken hoặc AdminToken | AC-METRIC-05/06 |

### Quản trị (chỉ host quản trị)
| Method | Path | Mô tả | Xác thực | AC chính |
|---|---|---|---|---|
| GET | `/admin/reports` | Báo cáo gom theo đích | AdminToken | AC-ADMIN-06 |
| GET | `/admin/elements` | Danh mục phần tử (tìm không dấu, lọc trạng thái) | AdminToken | AC-ADMIN-03, AC-ADMIN-05 |
| PUT | `/admin/elements/{id}/tier` | Gán tier 1-5, hoặc `"auto"` để trả về tier theo độ sâu; gán 4-5 khi chưa có ảnh → 409 | AdminToken | AC-ADMIN-12, AC-ADMIN-09, AC-TIER-01, AC-TIER-04, AC-TIER-05 |
| PUT | `/admin/elements/{id}/image` | Tải tranh vẽ tay WebP 256×256 cho phần tử (Tùy chọn, ADR 0016) | AdminToken | AC-ART-13, AC-ADMIN-09 |
| GET | `/admin/recipes` | Công thức có một phần tử | AdminToken | AC-ADMIN-04 |
| POST | `/admin/moderation` | Ẩn / hiện / chặn / gỡ chặn / bỏ qua báo cáo | AdminToken | AC-ADMIN-03..05, AC-ADMIN-07, AC-ADMIN-09 |
| GET | `/admin/contributions` | Đề xuất meme (cũ nhất trước, lọc theo trạng thái; `in_catalog` cho biết phần tử đã có trong danh mục) | AdminToken | AC-CONTRIB-07, AC-ADMIN-10, AC-CONTRIB-14 |
| PATCH | `/admin/contributions/{id}` | Sửa đề xuất chờ duyệt | AdminToken | AC-CONTRIB-07, AC-ADMIN-09 |
| POST | `/admin/contributions/{id}/approve` | Duyệt đề xuất (kèm `image_hint`, tier tùy chọn, `use_image_url` để dùng link làm ảnh món; link trống mà bật thì 400) | AdminToken | AC-CONTRIB-08, AC-CONTRIB-09, AC-TIER-01, AC-ADMIN-09, AC-ART-14, AC-CONTRIB-14 |
| POST | `/admin/contributions/{id}/reject` | Từ chối đề xuất (cần lý do) | AdminToken | AC-CONTRIB-08, AC-ADMIN-09 |
| GET | `/admin/batches` | Nhật ký các đợt, kèm `summary` (tổng crawl và thêm của các đợt `full` thành công, hàng chờ và thiếu ảnh của đợt gần nhất) | AdminToken | AC-ADMIN-08, AC-ADMIN-11 |
| GET | `/admin/audit` | Nhật ký audit | AdminToken | AC-ADMIN-09 |
| GET | `/admin/daily-pin` | Chỉ định Món đặc biệt đang chờ mẻ kế tiếp, hoặc `null` | AdminToken | AC-DAILY-19 |
| PUT | `/admin/daily-pin` | Chỉ định Món đặc biệt cho mẻ kế tiếp (`element_id`, `hint`); thay chỉ định cũ. Phần tử không có → 404; bị chặn hoặc gợi ý sai → 400 | AdminToken | AC-DAILY-19, AC-ADMIN-09 |
| DELETE | `/admin/daily-pin` | Bỏ chỉ định (204; không có chỉ định thì vẫn 204) | AdminToken | AC-DAILY-19, AC-ADMIN-09 |

> `/admin/elements/{id}/image` (AC-ART-13) đã định tuyến và triển khai staging 2026-10-25 (PR #107, git sha `ccb0b5d`); host quản trị phục vụ thêm `/lau-meme/img/*` (chỉ đọc) để trang quản trị hiện ảnh dưới CSP `default-src 'self'` (ADR 0016). `/me/plate` và `/me/plate/merge` (SYNC) đã định tuyến trong `worker/src/index.ts`. Contract 0.6.0 thêm `use_image_url` khi duyệt đề xuất và `PipelineState.image_links` (AC-ART-14, ADR 0018) - đã triển khai 2026-10-25 (migration 0009).

Contract 0.7.0 thêm `/admin/daily-pin` (GET, PUT, DELETE), `PipelineState.daily_pin`, `PublishBatchRequest.daily_pin_id` và `BatchStats.daily_pin` (AC-DAILY-19, ADR 0019).

Contract 0.8.0 thêm `in_catalog` vào `AdminContribution` (AC-CONTRIB-14): `element_id` đã có trong danh mục hay chưa; danh mục chỉ đổi khi mẻ đăng. Triển khai staging 2026-10-26 (Worker `31fa60ab-2166-4ab0-b33b-2b125dbd161f`, git sha `6857064`).

## Thử nhanh
```bash
curl -s https://staging.dinoduct.fun/lau-meme/api/health
curl -s https://staging.dinoduct.fun/lau-meme/api/streaks/leaderboard
```

## Đổi hợp đồng
Sửa `openapi.yaml` trước code, qua `/dk:design` → `/dk:approve contract`; `dk-check` chạy OpenAPI lint. Thêm hoặc bỏ endpoint thì cập nhật bảng trên.
