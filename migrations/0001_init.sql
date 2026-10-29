CREATE TABLE items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('post', 'thread', 'article')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',
    'approved',
    'scheduled',
    'posting',
    'posted',
    'partially_posted',
    'failed',
    'needs_review',
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
  UNIQUE (source, source_ref)
);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  x_post_id TEXT,
  posted_at INTEGER,
  UNIQUE (item_id, position)
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  segment_id TEXT,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  alt_text TEXT NOT NULL CHECK (length(alt_text) > 0),
  x_media_id TEXT,
  x_media_expires_at INTEGER
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  content_hash TEXT,
  at INTEGER NOT NULL,
  detail_json TEXT
);

CREATE TABLE oauth_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  x_user_id TEXT,
  x_username TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  iv_access TEXT,
  iv_refresh TEXT,
  expires_at INTEGER,
  scopes TEXT,
  updated_at INTEGER,
  needs_reconnect INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  lease_id TEXT
);

CREATE TABLE intake_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE intake_usage (
  token_id TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (token_id, hour_bucket)
);

CREATE INDEX items_status_sched ON items (status, scheduled_at);
CREATE INDEX segments_item ON segments (item_id, position);
CREATE INDEX media_item ON media (item_id);
CREATE INDEX audit_item ON audit_log (item_id, at);
