-- ─── Sunday D1 — v2 migration: sessions + magic links + user table fix ────────
-- Run: npx wrangler d1 execute sunday-db --remote --file=./migration-v2.sql

-- Sessions (90-day login persistence)
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  church_id   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',
  expires_at  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_church ON sessions(church_id);

-- Magic links (30-min sign-in tokens)
CREATE TABLE IF NOT EXISTS magic_links (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  church_id   TEXT,
  invite_key  TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Recreate users — drop NOT NULL on email so phone-less sign-in works
CREATE TABLE users_v2 (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  email           TEXT UNIQUE,
  name            TEXT,
  magic_token     TEXT,
  magic_expires   TEXT,
  last_sign_in    TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO users_v2
  SELECT id, email, name, magic_token, magic_expires, last_sign_in, created_at FROM users;
DROP TABLE IF EXISTS users;
ALTER TABLE users_v2 RENAME TO users;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Church members table (if not already present from earlier migration)
CREATE TABLE IF NOT EXISTS church_members (
  user_id     TEXT NOT NULL,
  church_id   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',
  joined_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, church_id)
);
CREATE INDEX IF NOT EXISTS idx_church_members_church ON church_members(church_id);
