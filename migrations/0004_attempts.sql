-- Rebuild the tables so CHECK constraints and foreign keys are part of
-- CREATE TABLE. D1 does not reliably keep a CHECK that arrived through
-- ALTER TABLE ADD COLUMN (migration 0002). Status values that had no
-- human action collapse into needs_you.

-- D1 keeps foreign keys on. PRAGMA foreign_keys = OFF is ignored there.
-- defer_foreign_keys holds the checks until this migration commits.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE items_v2 (
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
    review_stage IN ('draft', 'needs_hemingway', 'awaiting_paul')
  ),
  missed INTEGER NOT NULL DEFAULT 0,
  needs_reason TEXT CHECK (
    needs_reason IS NULL OR needs_reason IN ('unknown', 'rejected')
  ),
  resend_segment_id TEXT,
  UNIQUE (source, source_ref)
);

INSERT INTO items_v2 (
  id, kind, status, title, source, source_ref, notes, reviewed_by, content_hash,
  approved_hash, approved_at, approved_by, scheduled_at, lease_until, lease_id,
  last_error, x_article_id, created_at, updated_at, posted_at, review_stage,
  missed, needs_reason, resend_segment_id
)
SELECT
  id,
  kind,
  CASE
    WHEN status IN ('needs_review', 'failed', 'partially_posted') THEN 'needs_you'
    ELSE status
  END,
  title,
  source,
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
  review_stage,
  missed,
  CASE
    WHEN status = 'needs_review' THEN 'unknown'
    WHEN status IN ('failed', 'partially_posted') THEN 'rejected'
    ELSE NULL
  END,
  NULL
FROM items;

DROP TABLE items;
ALTER TABLE items_v2 RENAME TO items;

CREATE TABLE segments_v2 (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  x_post_id TEXT,
  posted_at INTEGER,
  UNIQUE (item_id, position)
);

INSERT INTO segments_v2 (id, item_id, position, text, x_post_id, posted_at)
SELECT id, item_id, position, text, x_post_id, posted_at FROM segments;

DROP TABLE segments;
ALTER TABLE segments_v2 RENAME TO segments;

CREATE TABLE media_v2 (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items (id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES segments (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  alt_text TEXT NOT NULL CHECK (length(alt_text) > 0),
  x_media_id TEXT,
  x_media_expires_at INTEGER
);

INSERT INTO media_v2 (
  id, item_id, segment_id, position, r2_key, mime, bytes, alt_text,
  x_media_id, x_media_expires_at
)
SELECT
  id,
  item_id,
  segment_id,
  (
    SELECT COUNT(*)
    FROM media older
    WHERE older.segment_id = media.segment_id AND older.rowid <= media.rowid
  ) - 1,
  r2_key,
  mime,
  bytes,
  alt_text,
  x_media_id,
  x_media_expires_at
FROM media;

DROP TABLE media;
ALTER TABLE media_v2 RENAME TO media;

CREATE TABLE audit_log_v2 (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items (id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  content_hash TEXT,
  at INTEGER NOT NULL,
  detail_json TEXT
);

INSERT INTO audit_log_v2 (
  id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json
)
SELECT id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_v2 RENAME TO audit_log;

CREATE TABLE intake_usage_v2 (
  token_id TEXT NOT NULL REFERENCES intake_tokens (id) ON DELETE CASCADE,
  hour_bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (token_id, hour_bucket)
);

INSERT INTO intake_usage_v2 (token_id, hour_bucket, count)
SELECT token_id, hour_bucket, count FROM intake_usage;

DROP TABLE intake_usage;
ALTER TABLE intake_usage_v2 RENAME TO intake_usage;

CREATE TABLE post_attempts (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES segments (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  outcome TEXT CHECK (
    outcome IS NULL OR outcome IN ('posted', 'rejected', 'not_posted', 'rate_limited')
  ),
  resolved_at INTEGER
);

-- Occupies the env-secret bot's id so a minted token cannot take it.
INSERT INTO intake_tokens (
  id, name, token_sha256, created_at, revoked_at, last_used_at
) VALUES (
  'env:intake',
  'x-drafts',
  'reserved-env-intake-not-a-token',
  0,
  0,
  NULL
);

CREATE INDEX items_status_sched ON items (status, scheduled_at);
CREATE INDEX segments_item ON segments (item_id, position);
CREATE INDEX media_item ON media (item_id, segment_id, position);
CREATE INDEX audit_item ON audit_log (item_id, at);
CREATE INDEX post_attempts_segment ON post_attempts (segment_id, started_at);
