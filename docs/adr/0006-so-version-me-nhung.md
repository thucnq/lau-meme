# 0006 — Số version của mẻ nhúng lấy từ giờ mẻ (GMT+7)

- Trạng thái: Đã chấp nhận (2026-10-20)
- Ngày: 2026-10-20

## Bối cảnh
Worker chỉ nhận version lớn hơn mọi version đã đăng (409, ADR 0003). Sau một lần rollback, `current_version` của `GET /api/pipeline/state` nhỏ hơn version lớn nhất đã đăng, nên "version hiện hành + 1" sẽ bị 409 mãi. Chạy lại cùng một đợt phải ra byte-giống-hệt (AC-PIPE-10), nên version không được phụ thuộc vào trạng thái máy chủ lúc chạy.

## Quyết định
- `version` = giờ mẻ `batch_at` đổi sang GMT+7, viết dạng số `YYYYMMDDHHmm` (vd mẻ 00:00 ngày 21/10/2026 GMT+7 → `202610210000`).
- Hàm thuần `version_for(batch_at)` trong `pipeline/src/lau_meme_pipeline/batch.py`; cùng `batch_at` ⇒ cùng version.

## Hệ quả
- Tăng nghiêm ngặt theo thời gian, không cần đọc version lớn nhất từ máy chủ, sống sót qua rollback.
- Đọc được bằng mắt trong báo cáo đợt và ô "Version muốn quay về" của workflow rollback.
- Hai mẻ trong cùng một phút ⇒ mẻ sau bị 409 và thất bại theo AC-PIPE-11 (bản cũ giữ nguyên); `concurrency` của workflow đã chặn hai mẻ chạy cùng lúc.
- Giá trị ~2·10¹¹: vượt int32 nhưng an toàn với SQLite INTEGER (int64), JavaScript (< 2⁵³) và OpenAPI `integer`.

## Phương án đã cân nhắc
- `current_version + 1`: hỏng sau rollback (xem bối cảnh).
- Giây Unix: tất định nhưng khó đọc khi rollback tay.
