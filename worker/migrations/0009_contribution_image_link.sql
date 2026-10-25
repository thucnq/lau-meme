-- Migration number: 0009 	 2026-10-25
-- AC-ART-14, ADR 0018: on approve the admin may use the contribution's image link as the element's picture. The
-- pipeline fetches it in the next full batch; publishing a batch then marks the element's image_source 'admin'.
-- Expand-only: a new column with a default, existing rows read as "not chosen".
ALTER TABLE contribution ADD COLUMN use_image_url INTEGER NOT NULL DEFAULT 0 CHECK (use_image_url IN (0, 1));
