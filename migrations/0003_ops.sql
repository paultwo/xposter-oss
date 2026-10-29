ALTER TABLE items ADD COLUMN missed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN retry_only_position INTEGER;

ALTER TABLE oauth_account ADD COLUMN avatar_r2_key TEXT;

CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  posting_paused INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  paused_by TEXT,
  posting_blocked_since INTEGER
);

INSERT INTO app_settings (id, posting_paused) VALUES (1, 0);
