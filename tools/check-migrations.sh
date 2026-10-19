#!/usr/bin/env bash
# Migrations are expand-only (idea from hopnhat ADR-007).
#   check-migrations.sh [--kind flyway-ts|wrangler-seq] [--dir <dir>] [base] [head]
#   default: Flyway in backend/src/main/resources/db/migration, merge-base with origin/main .. HEAD
# FAIL when, between base and head:
#   - a committed migration is modified, deleted or renamed;
#   - a new migration is badly named:
#       flyway-ts     V<yyyyMMddHHmm>__<slug>.sql (3 people on parallel branches must never collide)
#       wrangler-seq  NNNN_<slug>.sql (what `wrangler d1 migrations create` writes), and NNNN must be greater
#                     than every migration already on base — two branches that both add 0004_ collide;
#   - a new migration contains a destructive statement (DROP, RENAME, TRUNCATE, DELETE FROM, ALTER COLUMN … TYPE,
#     SET NOT NULL) — unless the file carries the line `-- dk:allow-destructive <reason>`, which the human
#     accepts at the contract gate (/dk:approve contract) or in PR review.
set -uo pipefail
KIND="flyway-ts"; DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kind) KIND="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    *) break ;;
  esac
done
case "$KIND" in
  flyway-ts) DIR="${DIR:-backend/src/main/resources/db/migration}" ;;
  wrangler-seq) DIR="${DIR:-worker/migrations}" ;;
  *) echo "check-migrations: kind $KIND không hỗ trợ"; exit 2 ;;
esac
base="${1:-$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD~1)}"; head="${2:-HEAD}"
git rev-parse -q --verify "$base^{commit}" >/dev/null 2>&1 || { echo "check-migrations: base $base không tồn tại — bỏ qua"; exit 0; }
FORBIDDEN='(\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE[[:space:]]+FROM\b|ALTER[[:space:]]+COLUMN[^;]*\bTYPE\b|SET[[:space:]]+NOT[[:space:]]+NULL)'
max_base=-1
if [ "$KIND" = wrangler-seq ]; then
  while read -r f; do
    n="$(basename "$f" | sed -nE 's/^([0-9]{4})_.*\.sql$/\1/p')"
    [ -n "$n" ] && [ $((10#$n)) -gt "$max_base" ] && max_base=$((10#$n))
  done < <(git ls-tree --name-only "$base" -- "$DIR/" 2>/dev/null)
fi
fail=0; n=0
while IFS=$'\t' read -r status path newpath; do
  [ -n "${status:-}" ] || continue
  n=$((n + 1))
  case "$status" in
    A)
      name="$(basename "$path")"
      if [ "$KIND" = flyway-ts ]; then
        if ! [[ "$name" =~ ^V[0-9]{12}__[a-z0-9_]+\.sql$ ]]; then
          echo "✗ $path: tên phải là V<yyyyMMddHHmm>__<slug>.sql (vd V$(date -u +%Y%m%d%H%M)__add_invoice.sql)"; fail=1
        fi
      else
        if ! [[ "$name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]]; then
          echo "✗ $path: tên phải là NNNN_<slug>.sql (tạo bằng: npx wrangler d1 migrations create <DB> <slug>)"; fail=1
        elif [ $((10#${name:0:4})) -le "$max_base" ]; then
          echo "✗ $path: số ${name:0:4} không lớn hơn migration lớn nhất trên nhánh gốc ($(printf %04d "$max_base")) — đổi số để không trùng"; fail=1
        fi
      fi
      body="$(git show "$head:$path" | sed -E 's/--.*$//')"
      if echo "$body" | grep -Eiq "$FORBIDDEN"; then
        if git show "$head:$path" | grep -q -- '-- dk:allow-destructive'; then
          echo "! $path có thao tác phá hủy, đã đánh dấu dk:allow-destructive — người review phải xác nhận"
        else
          echo "✗ $path chứa thao tác phá hủy (thêm cột/bảng mới thay vì sửa; nếu bắt buộc, thêm dòng '-- dk:allow-destructive <lý do>'):"
          echo "$body" | grep -Ein "$FORBIDDEN" | head -5; fail=1
        fi
      fi ;;
    R*) echo "✗ $path → $newpath: migration đã commit bị đổi tên"; fail=1 ;;
    *)  echo "✗ $path: migration đã commit bị sửa/xóa ($status) — tạo migration mới thay vì sửa"; fail=1 ;;
  esac
done < <(git diff --name-status -M "$base" "$head" -- "$DIR" | grep '\.sql' || true)
[ $fail -eq 0 ] && echo "✓ migration hợp lệ ($n thay đổi)"
exit $fail
