# Tổng hợp: plugin `dk` (devkit) và dự án QLDN

> Cập nhật 2026-10-19 chiều (PR #9 0.7.0 đã code xong, CI xanh, chờ merge; Lẩu Meme có lõi nội dung 139/363, luật người thật). Ngữ cảnh cho các phiên sau, không phải tài liệu khách hàng.

## 1. Mục tiêu và bối cảnh
- Plugin Claude Code tên `dk` giúp chủ dự án freelance làm việc nhanh gấp nhiều lần mà vẫn bảo đảm yêu cầu chức năng và phi chức năng, đồng thời tiết kiệm token.
- Dùng cho dự án cá nhân và freelance làm mới từ đầu, đội 3 người cùng trình độ, đều dùng Claude Pro và GitHub Free, khách ở Việt Nam.
- Stack: Java 21 / Spring Boot 3.5 (Maven monorepo), Postgres (hiếm khi Oracle), Kafka khi cần, React 19 + Vite, mobile qua Capacitor.
- Tài liệu bằng tiếng Việt, viết markdown trong repo: BRD, tài liệu API, sơ đồ DB/sequence/hệ thống, runbook. Báo giá xuất .xlsx theo template Google Sheet.
- Bắt buộc: bảo mật, audit log (giữ 3 tháng, cấu hình được, không dùng hash chain), bảo vệ dữ liệu cá nhân (PII) theo Luật BVDLCN 2025 và NĐ 356/2025. Tối ưu độ trễ và thông lượng với hạ tầng $0.
- Triển khai: máy trạm của khách, free tier hoặc cloud trả phí. Môi trường không phải production dùng free tier, ở đó agent được làm mọi việc.
- **Ba cổng do người duyệt**: spec, hợp đồng schema/API, merge vào `main`. Production chỉ người làm.
- Bỏ Sonar, dùng Semgrep, gitleaks, SpotBugs và PMD.
- **Môi trường chạy (từ 0.4.0): WSL2 Ubuntu 24.04** cho Claude Code, agent, hook, Maven, Docker; Windows 10 chỉ chạy IntelliJ và trình duyệt. Chạy trực tiếp trên Windows gây lỗi CRLF, mất quyền thực thi, hook sai. Máy của Thuc: ổ C quá đầy → đặt Ubuntu ở ổ D (`setup-wsl.ps1 -Drive D`, từ 0.6.1).

## 2. Kiến trúc plugin
- Repo marketplace: `github.com/thucnq/devkit-marketplace`, tên marketplace `thuc-devkit`. Cài bằng `/plugin marketplace add thucnq/devkit-marketplace` rồi `/plugin install dk@thuc-devkit`.
- Phiên bản trên `main`: **0.6.1** (PR #8 đã merge). **PR #9 (0.7.0, nhánh `feat/stack-profile`)**: stack profile Python/TS/Cloudflare — thiết kế đã duyệt, 4 commit code xong, CI xanh 3 job (`plugin` 48 test, `scaffold-and-build`, `scaffold-py-ts`); còn ở trạng thái draft → người bấm *Ready for review* rồi merge (session cloud không đổi được draft vì cần GraphQL). Biến userConfig: `hourly_rate_vnd` (175000), `overhead_pct` (30), `strict_gates` (true), `marketplace_repo` (mặc định `thucnq/devkit-marketplace` từ 0.6.0; trước là `OWNER/…` nên dự án mới không tự cài plugin cho đồng đội).
- Nguyên tắc chính: **cổng kiểm tra tất định không tốn token** (script và hook), LLM chỉ làm phần cần phán đoán. Trạng thái nằm trong `.dk/state.md` và chỉ được sửa qua `dk-state.sh`.

### Skills (lệnh `/dk:*`)
| Lệnh | Việc làm |
|---|---|
| `new-project` | Dựng dự án từ golden path; từ 0.6.0 bật `core.hooksPath .githooks` |
| `spec` | **Bước A**: đề xuất `docs/scope.md` từ ghi chú họp rồi dừng. **Bước B**: viết BRD, tiêu chí nghiệm thu `AC-<MÃ>-NN`, câu hỏi mở cho phạm vi đã chốt; từ 0.4.0 thêm `docs/acceptance/inv.md` (`AC-INV-NN`, bất biến nghiệp vụ trên dữ liệu vàng) khi hệ thống tính tiền/kế toán. Thêm `bỏ qua phạm vi` để chạy cả hai bước một lần |
| `approve` | Duyệt spec hoặc contract (chỉ người làm, hook chặn agent) |
| `estimate` | Tính điểm và báo giá .xlsx (`gen-quote.py`), đối chiếu với báo giá cũ; từ 0.4.0 điền `id`/`deps`/`ac`/`risk` và chạy `gen-plan.py` một lần |
| `plan` (0.4.0) | Lịch theo phụ thuộc + Gantt + checklist tiến độ: `docs/plan/tien-do.md` (người tick hạng mục/AC, %, người, ngày thực tế), `gantt.html` (offline, nút tải checklist), `gantt.md` (Mermaid). KH cố định, dự báo tính lại; `rebaseline` để lập lại KH |
| `design` | Viết OpenAPI, migration Flyway (tên `V<yyyyMMddHHmm>__`, chỉ thêm), ERD và ADR |
| `build <feature>` | Agent test-author viết test fail trước, sau đó mới implement; 0.5.0 ghi bằng chứng RED → GREEN theo AC (`dk-evidence.py`); 0.6.0 lọc test `-Dtest='<Feature>*'` (PascalCase, Surefire phân biệt hoa thường — `*cty*` không khớp `CtyApiTest`) |
| `review` | Chạy kiểm tra tất định trước, rồi agent reviewer với context sạch; rủi ro HIGH → soát đủ checklist bảo mật; 0.5.0 thêm checklist injection và upload Excel |
| `ship` | Triển khai môi trường không phải production, đồng bộ tài liệu; 0.6.0: từ chối cây làm việc chưa commit, `releases.log` trên máy chủ, `deploy.sh <env> --rollback [tag]` / `--releases`, tự rollback khi health hoặc k6 lỗi |
| `doctor` (0.4.0) | Kiểm tra máy: WSL2, repo ngoài `/mnt/c`, LF, Java 21, Docker, Node 22, gh, Claude Code, Docker Desktop lẫn vào PATH, biến môi trường chặn Remote Control, git hook dự án đã bật chưa, ổ C còn < 15 GB (0.6.1); `--fix`, `--install-launcher` |
| `note`, `retro` | Ghi chú và rút kinh nghiệm sau dự án dựa trên log; `/dk:note #lesson …` (0.5.0) được in lại ở đầu mỗi phiên (5 bài gần nhất) |
| `spring-conventions`, `react-conventions`, `security-baseline`, `vn-data-protection` | Quy ước tham chiếu |

### Agents
`test-author` (kiểm thử hộp đen, không đọc code production), `reviewer` (chỉ đọc), `doc-sync` (đồng bộ tài liệu, không sửa code).
Lý do không có agent planner hay developer riêng: luồng chính chạy trong phiên hiện tại để đỡ tốn token khi phải dựng lại context. Agent riêng chỉ dùng ở những chỗ cần **độc lập** (test viết trước code, review với context sạch). Đã đối chiếu với pipeline 4 agent của `hopnhat` và với ECC, giữ quyết định này (xem `docs/review-hopnhat.md`, `docs/review-ecc.md` trong repo plugin).
**Từ 0.6.0 tính độc lập do hook bảo đảm** (payload hook có `agent_id`/`agent_type` khi chạy trong subagent): `test-author` không đọc được `backend/src/main/java/**`, `frontend/src/**` (trừ file test) qua Read/Grep/Bash, Grep phải có `path` trong vùng cho phép, chỉ ghi file test; `reviewer` chỉ ghi `.dk/reviews/`, không chạy git đổi cây làm việc; `doc-sync` chỉ sửa `docs/`, README, `deploy/.env.example`.

### Hooks và scripts
- `guard.py` (PreToolUse, matcher Bash và Read|Edit|Write|MultiEdit|NotebookEdit|Grep) chặn: file bí mật (`.env`, `deploy/envs/*.env`, key), deploy production, `gh pr merge`, agent tự `dk-state approve`, force push, push lên hoặc push từ `main`, `--no-verify`, `rm -rf /`, sửa `.dk/state.md`, sửa migration đã commit (từ 0.6.0 cả qua lệnh shell `echo >>`, `sed -i`). Khi push, nó kiểm tra nhánh ở thư mục của lệnh `cd` hoặc `git -C` cuối cùng.
  - Từ 0.5.0: bỏ qua phần văn bản (`-m`, `--body`, `--title`, `echo`, heredoc vào lệnh không phải shell) nên hết chặn nhầm commit/PR có nhắc tới `git push`/`gh pr merge`; vẫn chặn `bash -c "git push origin main"` và heredoc vào `bash`.
  - Từ 0.5.0 (ý tưởng ECC config-protection): chặn agent nới cổng chất lượng — sửa cấu hình eslint/prettier/tsconfig/SpotBugs/PMD/gitleaks/semgrep/CI workflow/`ArchitectureTest`/`ac-trace.py`/`check-migrations.sh` (cả qua `sed -i`, `>`, `tee`, `cp/mv/rm`), thêm `@Disabled`/`NOPMD`/`@ts-ignore`/`eslint-disable`/`nosemgrep`/`.skip`, thêm `skipTests` hoặc hạ `<minimum>` coverage trong `pom.xml`. Người mở phiên `DK_ALLOW_QUALITY_EDIT=1` khi cần đổi luật.
  - **Lỗi tìm thấy và sửa ở 0.5.0**: `guard.py` dùng `shutil` mà không import → cổng pre-commit (quét bí mật, unit test, ArchUnit) chưa từng chạy ở các bản ≤ 0.4.0, kể cả với các commit của QLDN.
- `dk-check.sh` (precommit / quick / full), `ac-trace.py` (truy vết AC sang test; `--started-only` chỉ bắt buộc tính năng đã có test), `check-migrations.sh` (migration chỉ thêm, tên timestamp, lối thoát `-- dk:allow-destructive`), `dk-evidence.py` (RED/GREEN/report), `dk-state.sh`, `gen-quote.py`, `gen-plan.py` + `gantt-template.html`, `gen-erd.py`, `new-project.sh`, `deploy.sh` (0.6.0: rollback), `format.sh`, `session-start.sh` (in dòng tiến độ, bài học `#lesson`, cảnh báo khi chạy trên Git Bash hoặc `/mnt/c`), `wsl-doctor.sh`, `dk-remote.sh` (Remote Control trong tmux, tự chạy lại khi mất mạng).
- `windows/setup-wsl.ps1` (PowerShell Admin):
  - `-Drive D` / `-InstallDir <thư mục>` (0.6.1): cài Ubuntu thẳng vào ổ đã chọn (WSL ≥ 2.4: `wsl --install --location`; WSL cũ: cài ở C rồi chuyển ngay); không truyền thì liệt kê các ổ kèm dung lượng trống và hỏi (chọn sẵn ổ trống nhất khi C còn < 40 GB).
  - Ubuntu đã ở C: cùng lệnh `-Drive D` chuyển sang `D:\wsl\Ubuntu-24.04` (WSL ≥ 2.3 `wsl --manage --move`; WSL cũ export `.tar` lên ổ đích → chỉ unregister khi tar đủ → import → đặt lại user mặc định qua `/etc/wsl.conf`). Kiểm NTFS/ReFS, ổ cố định, đủ chỗ (~1,2× hoặc ~2,2× đĩa ảo), thư mục đích rỗng, hỏi trước `wsl --shutdown` (`-Yes` bỏ hỏi).
  - Đặt `swapFile` trong `.wslconfig` cùng ổ (mặc định swap nằm ở `%TEMP%` trên C); `-Status` xem Ubuntu ở đâu, nặng bao nhiêu, ổ trống bao nhiêu; `-MoveTo` giữ để tương thích.
  - Còn có: kiểm ảo hóa BIOS, `-Configure` (Remote Control tự chạy khi đăng nhập, chống ngủ), `-Firewall`, `-Remove`.
- Hook Stop (0.5.0, `dk-log.py`): cảnh báo người qua `systemMessage` khi câu trả lời có dấu hiệu bỏ dở ("lỗi có sẵn", flaky, "bỏ qua test", "để sau") và khi ngữ cảnh vượt `DK_COMPACT_AT` (mặc định 120k token) → nhắc `/compact`; model không tốn token; `/dk:retro` thống kê.
- Test và lint (CI job `plugin`): `plugins/dk/tests/` 19 test hồi quy Python (guard gồm phạm vi agent, dk-evidence, check-migrations, ac-trace, gen-plan, rollback) + `test_setup_wsl.ps1` (0.6.1: parse, không dùng toán tử chỉ có ở PowerShell 7, sửa `.wslconfig`) chạy bằng `pwsh` có sẵn trên runner; shellcheck (mức warning) và pyflakes từ 0.6.0.
- Log: `.dk/log/<author>.jsonl` không chứa prompt, nội dung file hay bí mật. `dk-report.py` tính các chỉ số cho `/dk:retro`. Cursor phiên nằm ở `.dk/log/.sessions/` và **phải nằm trong gitignore**.
- Mọi lệnh gọi script đều qua `bash` hoặc `python3`, vì khi giải nén zip trên Windows thì file mất quyền thực thi.

### Golden path (template)
Spring Boot dùng Postgres RLS (`set_config('app.tenant_id')`, role `app_rw`), UUIDv7, JWT HS256 với refresh cookie xoay vòng, Google SSO chỉ cho người được mời, audit chia partition theo tháng kèm `audit_maintain()`, PII mã hóa AES-GCM (`@Pii`), ArchUnit, Testcontainers, JaCoCo, profile `-Pquality`. Frontend React 19 + TanStack Query + Capacitor. Triển khai bằng Docker Compose + Caddy. CI GitHub Actions nằm trong hạn mức 2000 phút miễn phí và chạy **gitleaks CLI 8.30.1**, không dùng gitleaks-action vì action đó cần quyền đọc PR. Dependabot đã gộp nhóm theo hệ (maven, npm), chạy hằng tháng.
Từ 0.4.0: `.gitattributes` ép LF, `.run/` (IntelliJ: `API (dev)`, `Attach API :5005`), `scripts/dev/debug-api.sh`, `docs/dev/wsl-intellij.md`, `tools/check-migrations.sh`, Flyway `out-of-order: true`, CI `ac-trace --started-only`, gitleaks allowlist `.dk/log/.sessions/`. Từ 0.5.0: `.claude/settings.local.json` trong `.gitignore`, CLAUDE.md thêm luật "sửa code, không sửa cổng" và bằng chứng RED → GREEN. Từ 0.6.0: `.githooks/pre-commit` cho commit của người (quét bí mật bằng gitleaks hoặc regex, chặn commit `docs/input/misa/`, `docs/input/client-data/`, `.env`, `deploy/envs/*.env`). Từ 0.6.1: `docs/dev/wsl-intellij.md` Bước 1 có phần chọn ổ đĩa / chuyển Ubuntu khỏi ổ C và thu nhỏ đĩa ảo (`wsl --manage <distro> --set-sparse true`).

### Lịch sử PR của plugin
1. #1: chạy script qua bash/python3, khôi phục quyền thực thi
2. #2: `guard.py` kiểm tra nhánh tại thư mục push; thêm `docs/input` vào golden path
3. #3: CI golden path chạy gitleaks CLI
4. #4: `/dk:spec` đề xuất phạm vi từ ghi chú trước khi viết AC; `hang-muc.csv` thành tùy chọn; ignore `.dk/log/.sessions/`
5. #5 (đã merge, 0.4.0): WSL2 + IntelliJ, `/dk:plan` Gantt + checklist, `/dk:doctor`, học từ `hopnhat`, sửa 2 lỗi CI của QLDN.
6. #6 (đã merge, 0.5.0): học từ ECC (`affaan-m/ecc` v2.2.3) và runbook hopnhat; sửa cổng pre-commit không chạy; test hồi quy.
7. #7 (đã merge, 0.6.0): rà toàn bộ plugin — hook giữ độc lập agent, rollback, git hook cho người, sửa lọc test `/dk:build`, sửa `marketplace_repo` mặc định, shellcheck + pyflakes trong CI.
8. #8 (đã merge, 0.6.1): `setup-wsl.ps1` chọn ổ đĩa cho Ubuntu và chuyển Ubuntu khỏi ổ C; `swapFile` cùng ổ; `-Status`; `/dk:doctor` cảnh báo ổ C; test PowerShell trong CI.
9. #9 (**chờ merge**, 0.7.0, nhánh `feat/stack-profile`; 4 câu hỏi thiết kế đều được đồng ý): stack profile — `.dk/stack.toml` (TOML vì `tomllib` có sẵn, Python ≥ 3.11), `dk_stack.py`, JUnit XML chung cho Surefire/pytest/vitest, guard theo profile + luật né cổng Python + chặn `wrangler deploy` không `--env` (mặc định là production), migration `wrangler-seq` (`NNNN_*.sql`), golden path `py-ts-cloudflare` (Worker static assets thay Pages), `deploy-cf.sh`, `estimate --no-quote`, `plan --hours-per-week`. Không có `stack.toml` ⇒ chạy nguyên nhánh code 0.6.1 (test so bảng `dk-check` với bản 0.6.1 đóng băng ở `tests/fixtures/dk-check-0.6.1.sh`). Đã làm: (1) profile + check/trace/evidence/migrations/guard, (2) golden path `templates/py-ts-cloudflare` + `/dk:new-project --stack py-ts-cloudflare` + doctor theo stack + skill `python-conventions`/`cf-worker-conventions` + `review/checklist-py-ts.md`, (3) `/dk:estimate --no-quote` + `gen-plan --hours-per-week`, (4) `deploy-cf.sh` + `/dk:ship` Cloudflare + guard chặn wrangler production. Chưa kiểm chứng: `deploy-cf.sh` với Cloudflare thật.
Chưa kiểm chứng trên môi trường thật: `setup-wsl.ps1` trên Windows 10 (đặc biệt `--install --location`, `--manage --move`, đường export/import), `.run/` (IntelliJ), `dk-evidence.py` và phạm vi agent trong một lần `/dk:build` thật, `deploy.sh --rollback` qua SSH thật.

### Backlog plugin
1. ~~`/dk:ship rollback`~~ — xong ở 0.6.0.
2. Mã mẫu test endpoint catalog fail-closed trong golden path.
3. Generator dữ liệu vàng mẫu (Python, seed cố định) cho dự án import Excel.
4. Chế độ worktree cho một máy chạy nhiều phiên song song.
5. Đề xuất từ review 0.6.0, chờ quyết định: bỏ commit `.dk/log/*.jsonl` (gây thay đổi thường trực) và gom log khi `/dk:retro`; cổng pre-commit mặc định `precommit` (compile) thay vì chạy unit test mỗi commit của agent; đường deploy production có script cho người; giám sát uptime miễn phí; sao lưu ra ngoài máy chủ; reviewer dùng opus cho hạng mục rủi ro HIGH; kiểm chứng `${user_config.*}` có được thay trong nội dung skill không.
6. ~~**Hỗ trợ stack Python/TypeScript**~~ — xong ở PR #9 / 0.7.0 (chờ merge; động lực: dự án Lẩu Meme ở mục 6): golden path, `dk-check.sh`, lọc test `/dk:build`, kiểm migration D1, `guard.py`, CI, `/dk:ship` cho Cloudflare. Dự án cá nhân không báo giá → `/dk:estimate` cần chế độ bỏ qua báo giá.

### Đối chiếu ECC — không lấy (tốn token hoặc phá tính độc lập của agent)
GateGuard (bắt trả lời câu hỏi trước mỗi lần sửa), continuous learning tự động bằng LLM, PreCompact gọi LLM tóm tắt, Memory Vault đa harness, hook profile, cài trọn 71 agent / 311 skill. Chỉ tham khảo skill `springboot-security`, `jpa-patterns`, `postgres-patterns`, `deployment-patterns` khi làm backlog.

## 3. Dự án QLDN (`github.com/thucnq/qldn`)
- Khách sở hữu khoảng 10 công ty dùng **MISA desktop**. Hệ thống là cổng self-host để chuyển nhanh giữa các công ty và **import một chiều file .xlsx xuất từ MISA**.
- Đầu vào ở `docs/input/`:
  - `ghi-chu-hop.md` (bắt buộc)
  - `bao-gia-tom-tat.md`
  - `hang-muc.csv` (tùy chọn): 47 hạng mục, 335 điểm
  - `misa-mau/`: 12 file xlsx **giả lập** theo cấu trúc báo cáo MISA
- File MISA thật để ở `docs/input/misa/` và **không bao giờ commit**; số liệu phải được đổi trước khi dùng.
- Trên `main`:
  - Spec: BRD, 165 AC theo 47 hạng mục báo giá, 22 câu hỏi mở (commit `bd19233`, đã duyệt 2026-10-11)
  - Estimate: 241 điểm, khoảng 438,6 triệu (commit `14398d2`)
  - `docs/scope.md` được tạo từ BRD với trạng thái "Đã chốt" (PR #10)
- Phase hiện tại: **design**. Bước kế tiếp là `/dk:design` → `/dk:approve contract` → `/dk:build <feature>`.
- PR #7–#10 đã merge. PR #2–#6 là cập nhật dependency từ Dependabot, đang mở.
- `hopnhat` (`github.com/thucnq/hopnhat`) là bản làm cùng bài toán theo pipeline 4 agent — tham khảo dữ liệu vàng và bất biến kế toán của nó khi viết `AC-INV` cho QLDN.

### Việc còn mở cho qldn
Chép từ golden path (0.4.0–0.6.1) sang qldn: `.gitattributes`, `.run/`, `scripts/dev/`, `docs/dev/`, `.githooks/` (+ `git config core.hooksPath .githooks` trên mỗi clone), `tools/ac-trace.py`, `tools/check-migrations.sh`, `.gitleaks.toml`, bước CI `--started-only`; rồi chạy `/dk:plan bắt đầu <ngày>`. Cập nhật plugin trên các máy (`/plugin marketplace update thuc-devkit`) để cổng pre-commit và phạm vi agent có hiệu lực.
1. **`requirements` đỏ**: `ac-trace` báo 159 AC bắt buộc chưa có test (bình thường khi chưa build) → `--started-only`.
2. **`secrets` đỏ trên `main`**: gitleaks báo nhầm `generic-api-key` trong `.dk/log/.sessions/6fa63423-012.json` (lịch sử commit `bd19233`, `14398d2`) → allowlist `.dk/log/.sessions/`.

## 4. Bài học, đưa vào retro để cải tiến plugin
- Môi trường sandbox chặn Maven Central nên phải kiểm chứng backend qua GitHub CI.
- Skill dùng `!command` cần khai báo `allowed-tools: Bash`.
- npm bị xung đột peer dependency nên ghim TypeScript `~5.9.3`.
- Hook log của plugin chạy trong sandbox từng ghi `.dk/log/noreply.jsonl` vào repo khách. Luôn kiểm tra `git status` trước khi commit.
- Các file trạng thái hoặc log của công cụ phải được ignore ngay từ template, nếu không sẽ gây báo nhầm ở gitleaks và gây conflict.
- CI phải phù hợp với phase của dự án: kiểm tra test đầy đủ chỉ có ý nghĩa sau khi bắt đầu build.
- Chạy Claude Code trực tiếp trên Windows 10 sinh nhiều lỗi (CRLF, quyền file, hook) → chuẩn hóa WSL2.
- `java -version` có thể in dòng "Picked up JAVA_TOOL_OPTIONS" trước dòng version (máy có proxy) — script phải tìm dòng `version "`.
- Báo giá giả định chia đều việc cho 3 kỹ sư; lịch theo phụ thuộc thường dài hơn — `gen-plan.py` in cả hai để báo khách mốc thực tế.
- Hook kết thúc bằng exit code khác 2 (vd exception Python) thì Claude Code chỉ coi là lỗi không chặn → một bug trong hook guard làm cổng âm thầm biến mất. Mọi hook phải có test hồi quy chạy trong CI.
- Quy tắc trong prompt của agent ("không đọc code production") không đủ; ép bằng hook dựa trên `agent_type`.
- Hook của plugin chỉ thấy commit do Claude tạo; commit gõ tay cần git hook riêng trong repo (`.githooks/`).
- Viết git hook mới phải thử ngay trên commit scaffold: bản đầu chặn nhầm `.gitkeep` và làm hỏng `/dk:new-project`.
- Surefire `-Dtest` phân biệt hoa thường: lọc theo tên lớp PascalCase.
- `Path.lstrip("./")` trong Python xóa cả ký tự `.` đầu (`.dk/` → `dk/`) — dùng cắt tiền tố.
- Script PowerShell phải parse thử trước khi giao (pwsh trên Linux được): `"$Distro:"` trong chuỗi là lỗi cú pháp, phải viết `"${Distro}:"`. Windows PowerShell 5.1 không có `?:`, `??`, `&&`, `||` — test CI kiểm token. `Join-Path` đòi ổ đĩa phải tồn tại — ghép chuỗi khi chỉ cần đường dẫn.
- Runbook hopnhat: WSL tắt Ubuntu khi không còn tiến trình `wsl.exe` (tác vụ Windows cần `exec sleep infinity`); `claude remote-control` tự thoát khi mất mạng > ~10 phút (cần vòng lặp tự chạy lại); `docker` trong WSL có thể trỏ nhầm Docker Desktop qua `/mnt/c`; ổ C đầy dễ làm hỏng đĩa ảo WSL — đặt Ubuntu và swap ở ổ khác.
- npm 10.9 lỗi `Cannot read properties of null (reading 'edgesOut')` khi `npm install` lần đầu gói có peerOptional (vitest) → tạo lockfile bằng `npx npm@11 install`; `npm ci` với lockfile thì npm 10 chạy được. npm 11 chặn script cài đặt mặc định (`install-scripts`), workerd/esbuild vẫn chạy test được.
- `@cloudflare/vitest-pool-workers` đã đổi tên thành `@cloudflare/vitest-plugin` (API `cloudflareTest()`, `readD1Migrations()`, hỗ trợ vitest 4–5). `wrangler whoami` trả exit 0 cả khi chưa đăng nhập — phải đọc nội dung output. `wrangler deploy --dry-run` cần thư mục static assets tồn tại → trong profile đặt web trước worker.
- `IFS=$'\t' read` gộp các tab liên tiếp (tab là IFS whitespace) → trường rỗng làm lệch cột; dùng giá trị giữ chỗ `-`.
- Checklist theo dõi dự án: artifact "QLDN checklist" trên claude.ai (từ 0.4.0 có thể thay bằng `docs/plan/` trong repo).

## 5. Vận hành
- Máy dev: WSL2 Ubuntu 24.04 đặt ở ổ D (`D:\wsl\Ubuntu-24.04`, cài/chuyển bằng `setup-wsl.ps1 -Drive D`; kiểm `setup-wsl.ps1 -Status`), repo ở `~/code/<du-an>` (không ở `/mnt/c`), IntelliJ mở qua `\\wsl$` với JDK của WSL; hướng dẫn trong `docs/dev/wsl-intellij.md`.
- Để máy chạy sẵn Claude Code và điều khiển từ điện thoại: `dk-remote start` (tmux, tên phiên lấy từ `.dk/state.md`; tự chạy lại khi mất mạng, `dk-remote status`), hoặc `claude remote-control --name "qldn"` / `/remote-control`; `setup-wsl.ps1 -Configure` để tự chạy khi đăng nhập Windows (cửa sổ wsl thu nhỏ, không đóng); dùng tab Code trong app Claude, máy phải luôn thức.
- Deploy non-prod: `/dk:ship [env]`; quay lại bản trước: `deploy.sh <env> --rollback [tag]`, xem lịch sử: `deploy.sh <env> --releases` (chạy từ thư mục plugin `scripts/`).
- Quy tắc làm việc:
  - Agent chỉ commit hoặc push khi được yêu cầu, luôn tạo nhánh và mở PR, **người merge**.
  - Không đọc hay ghi `deploy/envs/*.env` và `.env`.
  - Mạng công ty chặn xem file `.py`/`.txt`, nên dán code trực tiếp vào chat.
  - Plugin cá nhân để trong `.claude/settings.local.json` (gitignore); trong repo dk tắt các plugin tự chạy plan/TDD riêng (superpowers, ECC), mang trí nhớ sang subagent (claude-mem, ECC continuous-learning), hoặc thêm hook mỗi lượt tool (ECC GateGuard).
  - Session Claude Code cloud không dùng được GitHub GraphQL: tạo PR bằng `gh api repos/<owner>/<repo>/pulls` (REST).

## 6. Dự án khác bàn trong Project (không thuộc dk/QLDN)
### Lẩu Meme (tên tạm trước: Meme Craft, mememories; ý tưởng từ 2026-10-19)
- Web game kiểu Infinite Craft (neal.fun/infinite-craft): kéo 2 phần tử ghép ra phần tử mới, nội dung là meme.
- Đối tượng: người Việt; nội dung meme Việt + meme quốc tế mà người Việt biết.
- Engine: tập meme **đóng**; hệ thống tự tìm liên kết (công thức ghép) giữa các meme.
- Nguồn nội dung: crawl meme định kỳ 2 lần/ngày, **00:00 và 12:00 GMT+7**.
- Mục tiêu: viral công khai; quảng cáo tính sau.
- Đã chốt (11:40): mỗi đợt crawl **tự động đăng**, không duyệt tay; LLM chạy lô dùng **Gemini free tier**; làm **cả Daily Meme lẫn First Discovery** ngay từ đầu.
- Đã chốt (13:29): tên đang cân nhắc **"mememories"**; pipeline viết bằng **Python**; sẽ phát triển bằng plugin `dk` → đầu ra của bước thiết kế phải là đầu vào cho luồng dk (`docs/input/`, scope, BRD/AC, OpenAPI, ADR), không bỏ qua cổng spec/contract.
- Lưu ý khi dùng dk cho dự án này: golden path và các script (`dk-check.sh`, lọc test Surefire, Flyway) đang giả định Java/Maven/Postgres; Meme Craft là Python + React tĩnh + Cloudflare Worker/D1.
- Đã chốt (13:44): **sửa plugin dk để hỗ trợ Python/TypeScript** (xem Backlog plugin mục 6); dự án **cá nhân, chỉ Thuc làm, không báo giá**; tên chưa chốt (đang xem các đề xuất thay cho "mememories").
- Đã chốt (13:59): **tên "Lẩu Meme"**; điểm nhấn UI: kéo thả 2 meme vào **hình một nồi lẩu** để ghép. Thời gian **20 giờ/tuần**, muốn **go-live sớm nhất có thể**. Phần sửa plugin dk cho Python/TS làm trong **1 PR duy nhất**.
- Đã chốt (14:02): **không làm beta kín**, ra mắt công khai luôn; chưa có tài khoản Cloudflare/Gemini → đã viết hướng dẫn.
- **Đã thực thi prompt (14:02)**. Đầu ra (lưu trong Project, thư mục `lau-meme/`; sẽ chép vào repo `thucnq/lau-meme` sau `/dk:new-project --stack py-ts-cloudflare`):
  - `docs/input/ghi-chu-hop.md`: quyết định Q1–Q11, MVP/ngoài phạm vi, từ vựng lẩu, chức năng GAME/DAILY/DISC/PIPE/MOD/ADMIN, phi chức năng, chống lộ đáp án, danh mục cấm, 10 bất biến cho AC-INV, gợi ý Mã, rủi ro (không beta ⇒ chạy pipeline thật trên staging vài ngày trước go-live), 5 câu hỏi mở.
  - `docs/input/noi-dung-loi.md` (mẫu chờ duyệt giọng hài): 4 phần tử khởi đầu **🌶️ Cay, 😂 Cười, 💀 Toang, ⏰ Deadline** (Doge chuyển thành món độ sâu 2), 20 công thức + 3 dự bị (đã kiểm độ sâu và cặp không trùng bằng script), 8 câu "Nồi trào", ví dụ Món đặc biệt 📈 Stonks (độ sâu 4, 6 lượt).
  - `docs/dev/huong-dan-tai-khoan.md`: Gemini (AI Studio, không bật billing), Cloudflare (2FA, Account ID, workers.dev, D1, API token, `wrangler secret put ADMIN_TOKEN`), GitHub (repo public, secrets, environment `production` có reviewer, push protection), Reddit/YouTube API, domain.
- Hạ tầng đề xuất đổi: Worker static assets phục vụ cả web lẫn API (thay Cloudflare Pages) — chờ duyệt ở PR #9.
- Đã chốt (14:28): đồng ý cả 4 câu thiết kế PR #9 (TOML, Worker thay Pages, giữ nhánh 0.6.1, bỏ k6); ghi chú họp giữ nguyên; **giọng càng mặn càng tốt**; tỉ lệ meme **Việt/quốc tế 7/3**; **muốn có ảnh meme nếu không vi phạm**.
- Ảnh: không dùng ảnh meme gốc (bản quyền + mặt người thật). Ghi chú họp đổi Q9: **ảnh minh họa tự tạo** vẽ lại khái niệm (Workers AI FLUX.1 schnell; gói free 10.000 neuron/ngày ≈ vài trăm ảnh nhỏ — cần kiểm tra), kiểm duyệt ảnh bằng Gemini (Gemini free không tạo ảnh), emoji hiện trước và là dự phòng; thêm bước pipeline 6b, luật cấm cho ảnh, câu hỏi mở 7 (lưu ảnh: R2 / KV / static assets → ADR ở /dk:design). Hướng dẫn tài khoản thêm quyền Workers AI cho token.
- Lõi nội dung (`lau-meme/docs/input/noi-dung-loi.md` + `.json`, sinh bởi `lau-meme/tools/noi_dung.py` — sửa dữ liệu ở script rồi chạy lại): **137 phần tử, 359 công thức**, độ sâu tối đa 7, Việt/quốc tế 98/39 (71%), 40 câu "Nồi trào", 3 Món đặc biệt (Stonks độ sâu 4, Bao Giờ Cưới 5, Mẹ Giữ Hộ 7), gợi ý ảnh cho từng phần tử; script kiểm cặp trùng, tới được, emoji/tên trùng, độ sâu Món đặc biệt [4, 8].
- **Phát hiện**: ghép trượt khi chơi ngẫu nhiên 100 lượt ≈ 67% (20 lượt đầu ≈ 41%) — không đạt NFR ≤ 40%; tập đóng không thể dày như Infinite Craft. Đề xuất (câu hỏi mở 6): đổi NFR thành "20 lượt đầu ≤ 45%, cả ván ≤ 70%", pipeline sinh công thức bổ sung hàng loạt, "nồi trào có gợi ý".
- Đã chốt (15:23): đồng ý NFR ghép trượt mới (**20 lượt đầu ≤ 45%, cả ván ≤ 70%** + công thức bổ sung + "nồi trào có gợi ý" — Q13, lõi hiện đạt); độ mặn ok; **lưu ảnh ở R2** (tên file theo băm nội dung, phục vụ qua Worker + Cache API, `immutable`, WebP 256px; R2 free 10 GB / 10 triệu lượt đọc / không phí băng thông; cần kiểm tra R2 có bắt khai báo thẻ; dự phòng: repo ảnh riêng + static assets) — Q14.
- **Luật người thật** (ghi chú họp mục 7.1, chốt 15:23, phát sinh từ trend một nghệ sĩ hài đang bị đào lại các cáo buộc ứng xử/quấy rối): phép thử *nhận diện được* — viết tắt, biệt danh, tên vai, câu cửa miệng, ảnh na ná đều tính như nêu tên; cấm mọi phần tử nhận ra được người thật gắn với cáo buộc và mọi trò đùa về quấy rối; được dùng **hiện tượng chung** (thêm `⛏️ Đào Mả Phốt`, `🔄 Fan Quay Xe` vào lõi → 139 phần tử / 363 công thức) nhưng mô tả/gợi ý không nhắc vụ việc, không chọn làm Món đặc biệt khi tin còn nóng (~30 ngày); kiểm duyệt pipeline dựa trên ngữ cảnh nguồn + danh sách chặn bí danh. Pháp lý tham chiếu: BLDS 2015 Điều 32, 34; BLHS Điều 155, 156; NĐ 174/2026 (hiệu lực 1/7/2026: chia sẻ thông tin sai sự thật xúc phạm danh dự cá nhân phạt 20–30 triệu).
- Bước kế tiếp: Thuc merge PR #9 (bấm Ready for review → merge) → `/plugin marketplace update thuc-devkit` → `/dk:new-project lau-meme --stack py-ts-cloudflare` → chép `lau-meme/docs/input/*` vào repo → `/dk:spec docs/input/` → `/dk:estimate --no-quote` → `/dk:plan --hours-per-week 20`. Song song: tạo tài khoản Gemini + Cloudflare theo hướng dẫn.
