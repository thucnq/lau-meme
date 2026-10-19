# Tiêu chí nghiệm thu — Sức khỏe hệ thống (HEALTH)

> Tính năng mẫu để minh họa cấu trúc và quy ước AC cho 3 ngôn ngữ. Giữ lại (health check cần cho `/dk:ship`)
> hoặc sửa theo dự án.
> Quy ước gắn AC vào test: TypeScript — tiêu đề `it("AC-HEALTH-01: …")`; Python — tên hàm `test_ac_health_03_…`.

### AC-HEALTH-01: API sức khỏe
- **Cho** Worker đã chạy migration
- **Khi** gọi `GET /api/health`
- **Thì** nhận 200 `{status: "ok", env, schema}`; đường `/api/*` không tồn tại trả 404 `application/problem+json`
- Ưu tiên: Bắt buộc

### AC-HEALTH-02: Trang chủ hiện trạng thái máy chủ
- **Cho** người dùng mở trang chủ
- **Khi** API trả về bình thường / lỗi
- **Thì** hiện "Máy chủ: ok (<env>)" / thông báo lỗi có `role="alert"`
- Ưu tiên: Bắt buộc

### AC-HEALTH-03: Khóa so khớp văn bản
- **Cho** chuỗi tiếng Việt có dấu, hoa thường, khoảng trắng thừa
- **Khi** pipeline chuẩn hóa (`fold`)
- **Thì** ra chữ thường không dấu, gộp khoảng trắng; áp hai lần cho cùng kết quả
- Ưu tiên: Bắt buộc
