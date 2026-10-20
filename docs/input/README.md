# Đầu vào cho /dk:spec

Bỏ nguyên liệu thô vào đây trước khi chạy `/dk:spec docs/input/`.

`/dk:spec` chạy hai bước:
1. Lần đầu: đọc các file ở đây, **tự đề xuất danh sách tính năng** vào `docs/scope.md` (có cột Nguồn trích từ ghi chú, cỡ S/M/L, và đối chiếu báo giá nếu có). Bạn sửa file đó - xóa dòng, đổi ưu tiên - rồi đổi Trạng thái thành **Đã chốt**.
2. Lần hai: viết BRD, tiêu chí nghiệm thu và câu hỏi cho khách, chỉ cho các tính năng đã chốt.

| File | Nội dung |
|---|---|
| `ghi-chu-hop.md` | **Bắt buộc.** Những gì khách đã nói qua chat, gọi, họp - càng nguyên văn càng tốt |
| `hang-muc.csv` | Tùy chọn. Danh sách hạng mục đã báo giá (nếu báo giá đi trước spec) - `/dk:spec` đối chiếu và báo tính năng nào nằm ngoài báo giá |
| `*.pdf`, `*.docx`, ảnh | Tài liệu khách gửi |
| `misa/`, `client-data/` | File dữ liệu mẫu của khách, **đã xóa/đổi số liệu thật**. Không commit (đã có trong `.gitignore`) |
