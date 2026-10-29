-- One connected account per instance. The review stage that waited on a
-- named person becomes needs_approval. Time zone and an optional plan
-- override live in settings. The account row stores the name and the
-- subscription_type returned by users.read.

-- D1 keeps foreign keys on. PRAGMA foreign_keys = OFF is ignored there.
-- defer_foreign_keys holds the checks until this migration commits.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE items_v3 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('post', 'thread', 'article')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',
    'approved',
    'scheduled',
    'posting',
    'posted',
    'needs_you',
    'archived'
  )),
  title TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  notes TEXT,
  reviewed_by TEXT,
  content_hash TEXT NOT NULL,
  approved_hash TEXT,
  approved_at INTEGER,
  approved_by TEXT,
  scheduled_at INTEGER,
  lease_until INTEGER,
  lease_id TEXT,
  last_error TEXT,
  x_article_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  posted_at INTEGER,
  review_stage TEXT NOT NULL DEFAULT 'draft' CHECK (
    review_stage IN ('draft', 'needs_hemingway', 'needs_approval')
  ),
  missed INTEGER NOT NULL DEFAULT 0,
  needs_reason TEXT CHECK (
    needs_reason IS NULL OR needs_reason IN ('unknown', 'rejected')
  ),
  resend_segment_id TEXT,
  UNIQUE (source, source_ref)
);

INSERT INTO items_v3 (
  id, kind, status, title, source, source_ref, notes, reviewed_by, content_hash,
  approved_hash, approved_at, approved_by, scheduled_at, lease_until, lease_id,
  last_error, x_article_id, created_at, updated_at, posted_at, review_stage,
  missed, needs_reason, resend_segment_id
)
SELECT
  id,
  kind,
  status,
  title,
  CASE source WHEN 'paul' THEN 'you' ELSE source END,
  source_ref,
  notes,
  reviewed_by,
  content_hash,
  approved_hash,
  approved_at,
  approved_by,
  scheduled_at,
  lease_until,
  lease_id,
  last_error,
  x_article_id,
  created_at,
  updated_at,
  posted_at,
  CASE review_stage
    WHEN 'awaiting_paul' THEN 'needs_approval'
    ELSE review_stage
  END,
  missed,
  needs_reason,
  resend_segment_id
FROM items;

-- Copy the children onto the new parent before the old parent is dropped.
-- DROP TABLE items would otherwise ON DELETE CASCADE the segments, media,
-- audit rows, and attempts that still point at it.
CREATE TABLE segments_v3 (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items_v3 (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  x_post_id TEXT,
  posted_at INTEGER,
  UNIQUE (item_id, position)
);

INSERT INTO segments_v3 (id, item_id, position, text, x_post_id, posted_at)
SELECT id, item_id, position, text, x_post_id, posted_at FROM segments;

CREATE TABLE media_v3 (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items_v3 (id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES segments_v3 (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  alt_text TEXT NOT NULL CHECK (length(alt_text) > 0),
  x_media_id TEXT,
  x_media_expires_at INTEGER
);

INSERT INTO media_v3 (
  id, item_id, segment_id, position, r2_key, mime, bytes, alt_text,
  x_media_id, x_media_expires_at
)
SELECT
  id, item_id, segment_id, position, r2_key, mime, bytes, alt_text,
  x_media_id, x_media_expires_at
FROM media;

CREATE TABLE audit_log_v3 (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items_v3 (id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  content_hash TEXT,
  at INTEGER NOT NULL,
  detail_json TEXT
);

INSERT INTO audit_log_v3 (
  id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json
)
SELECT id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json
FROM audit_log;

CREATE TABLE post_attempts_v3 (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments_v3 (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items_v3 (id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  outcome TEXT CHECK (
    outcome IS NULL OR outcome IN ('posted', 'rejected', 'not_posted', 'rate_limited')
  ),
  resolved_at INTEGER
);

INSERT INTO post_attempts_v3 (
  id, segment_id, item_id, lease_id, started_at, outcome, resolved_at
)
SELECT id, segment_id, item_id, lease_id, started_at, outcome, resolved_at
FROM post_attempts;

DROP TABLE post_attempts;
DROP TABLE audit_log;
DROP TABLE media;
DROP TABLE segments;
DROP TABLE items;

ALTER TABLE items_v3 RENAME TO items;
ALTER TABLE segments_v3 RENAME TO segments;
ALTER TABLE media_v3 RENAME TO media;
ALTER TABLE audit_log_v3 RENAME TO audit_log;
ALTER TABLE post_attempts_v3 RENAME TO post_attempts;

CREATE INDEX items_status_sched ON items (status, scheduled_at);
CREATE INDEX segments_item ON segments (item_id, position);
CREATE INDEX media_item ON media (item_id, segment_id, position);
CREATE INDEX audit_item ON audit_log (item_id, at);
CREATE INDEX post_attempts_segment ON post_attempts (segment_id, started_at);

CREATE TRIGGER items_claim_attempt
AFTER UPDATE OF lease_id ON items
WHEN NEW.status = 'posting'
  AND OLD.status = 'scheduled'
  AND NEW.lease_id IS NOT NULL
  AND OLD.lease_id IS NULL
  AND NEW.resend_segment_id IS NOT NULL
BEGIN
  INSERT INTO post_attempts (
    id, segment_id, item_id, lease_id, started_at, outcome, resolved_at
  ) VALUES (
    NEW.lease_id,
    NEW.resend_segment_id,
    NEW.id,
    NEW.lease_id,
    NEW.updated_at,
    NULL,
    NULL
  );
END;

ALTER TABLE oauth_account ADD COLUMN display_name TEXT;
ALTER TABLE oauth_account ADD COLUMN subscription_type TEXT;

ALTER TABLE app_settings ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'America/New_York';
ALTER TABLE app_settings ADD COLUMN x_plan TEXT;
