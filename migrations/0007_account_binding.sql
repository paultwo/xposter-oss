-- Bind an approval to the X account that approved it, remember which
-- local day a segment posted on, and keep one dispatcher in the cap.

ALTER TABLE items ADD COLUMN approved_x_user_id TEXT;
ALTER TABLE segments ADD COLUMN posted_day TEXT;

ALTER TABLE app_settings ADD COLUMN dispatch_lease_id TEXT;
ALTER TABLE app_settings ADD COLUMN dispatch_lease_until INTEGER;
ALTER TABLE app_settings ADD COLUMN disconnected_since INTEGER;

CREATE TABLE daily_slots (
  id TEXT PRIMARY KEY,
  day_key TEXT NOT NULL,
  segment_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('held', 'posted')),
  created_at INTEGER NOT NULL
);

CREATE INDEX daily_slots_day ON daily_slots (day_key, state);

-- Existing approvals stay unbound (approved_x_user_id NULL). A scheduled
-- or in-flight row would sit in the due query forever, so park it.
UPDATE items
SET status = 'needs_you',
    needs_reason = 'rejected',
    last_error = 'Approve again after connecting X.',
    approved_hash = NULL,
    approved_at = NULL,
    approved_by = NULL,
    scheduled_at = NULL,
    missed = 0,
    lease_id = NULL,
    lease_until = NULL
WHERE approved_hash IS NOT NULL
  AND approved_x_user_id IS NULL
  AND status IN ('approved', 'scheduled', 'posting');
