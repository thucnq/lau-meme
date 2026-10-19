# lau-meme

Khởi tạo từ golden path `py-ts-cloudflare` của plugin `dk`. Quy trình: `CLAUDE.md`. Vận hành: `docs/runbook.md`. Cài máy: `docs/dev/setup.md`.

| Thư mục | Nội dung |
|---|---|
| `worker/` | Cloudflare Worker (TypeScript): API `/api/*` + phục vụ `web/dist`; D1 `migrations/` |
| `web/` | React 19 + Vite |
| `pipeline/` | Việc theo lô bằng Python (chạy trên GitHub Actions) |
| `docs/` | BRD, tiêu chí nghiệm thu, OpenAPI, ADR, runbook |
