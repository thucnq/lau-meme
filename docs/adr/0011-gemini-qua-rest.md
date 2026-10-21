# 0011 - Gemini 2.5 Flash gọi qua REST bằng thư viện chuẩn, khóa ở GitHub Secret

- Trạng thái: Đã chấp nhận (người duyệt 2026-10-21)
- Ngày: 2026-10-21
- Nguồn: PIPE giai đoạn 2 (AC-PIPE-05, 06, 08, 09, 12, 13), MOD (AC-MOD-03, 04), ADR 0009

## Bối cảnh
Mẻ `full` cần LLM ở các bước: hỏi trùng (`same`), mô tả meme (`describe`), kiểm duyệt lớp 2 (`classify`), liên kết ngược (`link`), giám khảo (`judge`), công thức bổ sung. Code thuần (`full.py`, `llm.py`) đã nhận LLM dưới dạng hàm theo bước và xử lý gom lô, backoff, hết quota, cache theo mẻ; còn thiếu adapter mạng thật. Pipeline hiện chỉ dùng thư viện chuẩn Python, không có phụ thuộc mạng nào.

## Quyết định
- **Nhà cung cấp và model:** Google AI Studio, gói free, model `gemini-2.5-flash` (người chọn 2026-10-21). Đổi model bằng biến `GEMINI_MODEL`, không cần sửa code.
- **Gọi REST** `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` bằng `http.client` (cùng kiểu adapter `_Https` của `batch.py`), header `x-goog-api-key`, `generationConfig.responseMimeType = application/json`, `temperature = 0`. Không thêm SDK `google-genai`.
- **Ánh xạ lỗi:** HTTP 429 mà chi tiết lỗi nêu hạn mức theo ngày (`quotaId` chứa `PerDay`) → `QuotaExhausted`; 429 khác (theo phút) và 5xx → `RateLimited` (backoff của `call_in_batches`); lỗi khác hoặc trả lời không phải JSON → `LlmError`. Thông báo lỗi chỉ ghi loại lỗi và mã HTTP, không ghi URL hay khóa.
- **Khóa:** GitHub Environment secret `GEMINI_API_KEY` (staging, production-no-approval), không bao giờ vào repo hay log. Thiếu khóa ở chế độ `full` → đợt thất bại ở bước `llm`, bản hiện hành giữ nguyên.
- **Dữ liệu gửi đi:** mọi payload đi qua `build_llm_payload` với danh sách trường cho phép (AC-PIPE-13, mở rộng theo ADR 0009). Không có dữ liệu người chơi.

## Hệ quả
- Không thêm phụ thuộc; adapter nhỏ, test bằng mock `http.client` như các adapter khác.
- Prompt nằm trong code pipeline (tiếng Việt), đổi prompt làm đổi khóa cache nên chỉ ảnh hưởng mẻ sau.
- Hạn mức gói free có thể đổi; hết quota thì mẻ vẫn đăng phần đã xử lý (AC-PIPE-12).

## Phương án đã loại
- **SDK `google-genai`:** thêm phụ thuộc và lớp trừu tượng không cần cho vài lời gọi `generateContent`; khó mock ở tầng kết nối như các adapter còn lại.
- **Workers AI:** hạn mức gói free chưa kiểm (câu hỏi mở 13); model nhỏ hơn yếu tiếng Việt cho kiểm duyệt.
