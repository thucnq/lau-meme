# lau-meme

Project built on the dk golden path `py-ts-cloudflare`. Docs and UI text in Vietnamese; code and identifiers in English. Never use the em dash `—` in any text (docs, UI, commits, PRs); write a plain hyphen `-` instead.
Stack profile: `.dk/stack.toml` (components pipeline / web / worker - dk reads it for checks, test filters and agent scope).

## Workflow (dk plugin ≥ 0.7.0)
/dk:spec (đề xuất phạm vi) → chốt docs/scope.md → /dk:spec → /dk:approve spec → /dk:estimate --no-quote → /dk:plan → /dk:design → /dk:approve contract → /dk:build <feature> → /dk:review → human merges → /dk:ship staging
Gates are enforced by hooks; state lives in `.dk/state.md` (edit only via dk-state.sh).
- Unfinished work: when the human says "tiếp tục việc đang dở" or you claim something was left unfinished, base it on the "Dấu hiệu việc bỏ dở" lines from session start (or `python3 <plugin>/scripts/dk-unfinished.py`, dk ≥ 0.7.6) and quote their evidence (branch, commit, check report line, log time) - never from memory alone.

## Source of truth
- Requirements: `docs/brd.md`, `docs/acceptance/<feature>.md` (AC ids, one test each)
- Contract: `docs/api/openapi.yaml` · Schema: `worker/migrations/NNNN_*.sql` (never edit committed ones)
- Decisions: `docs/adr/`

## Commands
- Pipeline: `uv run --directory pipeline pytest -q` · lint `uv run --directory pipeline ruff check .`
- Worker: `npm --prefix worker run test -- --run|typecheck|lint|dev` · new migration: `cd worker && npx wrangler d1 migrations create DB <slug>`
- Web: `npm --prefix web run test -- --run|typecheck|lint|build|dev`
- All checks: `bash <plugin>/scripts/dk-check.sh quick` · tests of one feature: `python3 <plugin>/scripts/dk_stack.py test-cmd <feature>`

## AC ids in tests
- TypeScript: the `it(...)` title starts with the id: `it('AC-GAME-01: …')`.
- Python: function `test_ac_game_01_<what>()` (no dashes allowed in names) + docstring starting with `AC-GAME-01:`.

## Non-negotiables
- The repo may be public: never read or write `.dev.vars*`, `.env*`; secrets live in Cloudflare secrets / GitHub Secrets only.
- Production is human-only: `wrangler deploy`, `wrangler rollback`, `wrangler secret put`, `d1 migrations apply --remote` and `d1 execute --remote` without `--env staging` are blocked by the guard hook.
- D1 SQL only through `prepare(...).bind(...)`; no string-built SQL. Errors are RFC 9457 problem+json (`src/http.ts`).
- Migrations are expand-only; numbers strictly increase (`tools/check-migrations.sh --kind wrangler-seq`).
- Pipeline code is pure where it can be (no network/clock/randomness in logic) so tests and re-runs are deterministic; network adapters are isolated and mocked in tests.
- Never send user data to an LLM. Never guess business rules: add the question to `docs/open-questions.md` and stop that part.
- Fix the code, never the gate: lint/test/coverage configs (`[tool.ruff|pytest|coverage]` in pyproject, eslint, tsconfig, vitest config, CI workflows, `.dk/stack.toml`) and suppressions (`# noqa`, `# type: ignore`, `pytest.mark.skip`, `@ts-ignore`, `eslint-disable`, `.skip`) are blocked by the guard hook - stop and ask the human.
- Git hooks live in `.githooks/` (`git config core.hooksPath .githooks`); never bypass them.
- Build evidence: RED before implementing, GREEN after (`dk-evidence.py`, `.dk/evidence/<feature>.json` is committed).
