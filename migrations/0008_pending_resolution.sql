-- An account switch marks rows for settle. It does not itself change the
-- attempt, the status, the lease, the daily slot, or the post id.
ALTER TABLE items ADD COLUMN pending_resolution TEXT;
