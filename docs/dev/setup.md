# Cài đặt máy dev

Chạy trong WSL2 Ubuntu (repo ở `~/code/…`, không ở `/mnt/c`) - `/dk:doctor` kiểm tra tất cả.

```bash
# Python ≥ 3.11 + uv (hoặc pip)
curl -LsSf https://astral.sh/uv/install.sh | sh
uv sync --directory pipeline                  # tạo pipeline/.venv với pytest, ruff
# Node 22
npm --prefix worker ci && npm --prefix web ci
cp worker/.dev.vars.example worker/.dev.vars
npm --prefix worker run migrate:local         # D1 cục bộ
```

Chạy:
```bash
npm --prefix web run build && npm --prefix worker run dev   # http://localhost:8787 (API + web)
npm --prefix web run dev                                     # http://localhost:5173 (hot reload, /api → 8787)
```

D1 cục bộ sau `migrate:local` còn trống, nên `GET /lau-meme/api/manifest` trả 503 "Chưa có mẻ nhúng nào được đăng" cho đến khi đăng mẻ đầu tiên. Khi `npm --prefix worker run dev` đang chạy, mở terminal khác:
```bash
# PIPELINE_TOKEN = giá trị PIPELINE_TOKEN bạn đã đặt trong worker/.dev.vars
API_BASE_URL=http://localhost:8787/lau-meme PIPELINE_TOKEN=<token-local> \
  uv run --directory pipeline python -m lau_meme_pipeline.batch --mode core --core ../docs/input/noi-dung-loi.json
```
Không đặt `GITHUB_REPOSITORY` thì pipeline không tạo GitHub Issue, chỉ in báo cáo đợt ra màn hình. Mỗi lần xóa `worker/.wrangler/state` phải đăng lại.

Kiểm tra như CI: `bash <plugin>/scripts/dk-check.sh quick` (dk tự chạy khi review).

npm ≥ 11 chặn script cài đặt mặc định: cảnh báo `install-scripts` cho `workerd`/`esbuild` không làm hỏng test. Nếu `wrangler dev` báo thiếu binary, chạy `npm --prefix worker install-scripts approve workerd esbuild` (kiểm tra cú pháp với bản npm đang dùng).
