-- Migration number: 0013 	 2026-10-31T03:35:44.041Z
-- "Ngày tạo" / "Ngày cập nhật" of the admin "Nội dung" list (AC-ADMIN-19, open question 105, ADR 0025).
-- created_at: when a batch first added the element; set on insert only, never by the upsert's update branch.
-- Elements that predate the column take the publish time of the first batch that had them (first_version),
-- falling back to updated_at when that batch_run row is gone.
ALTER TABLE element ADD COLUMN created_at INTEGER;
UPDATE element SET created_at = COALESCE(
  (SELECT MIN(r.created_at) FROM batch_run r WHERE r.version = element.first_version),
  updated_at
) WHERE created_at IS NULL;

-- updated_at keeps its column but changes meaning (ADR 0025): every admin write to the element or its image sets it,
-- a batch sets it only when a value really differs. Indexes for the sort keys the admin list offers.
CREATE INDEX element_created ON element (created_at);
CREATE INDEX element_updated ON element (updated_at);
CREATE INDEX element_depth ON element (depth);
