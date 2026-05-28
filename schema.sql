-- ═══════════════════════════════════════════════════════════════
-- Sunday — D1 (SQLite) Schema
-- Multi-tenant: every row is scoped to a church_id
-- Run: npx wrangler d1 execute sunday-db --file=./schema.sql
-- ═══════════════════════════════════════════════════════════════

-- ── Churches (tenants) ────────────────────────────────────────────────────────
-- One row per church. church_id is the root of all tenancy.
CREATE TABLE IF NOT EXISTS churches (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(6)))),
  name         TEXT NOT NULL,
  slug         TEXT UNIQUE,
  timezone     TEXT DEFAULT 'Pacific/Auckland',
  settings     TEXT DEFAULT '{}',        -- JSON freeform
  created_at   TEXT DEFAULT (datetime('now'))
);

-- ── App users (email identity, no password — magic link auth later) ───────────
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  email           TEXT UNIQUE NOT NULL,
  name            TEXT,
  magic_token     TEXT,                  -- pending sign-in token
  magic_expires   TEXT,                  -- ISO 8601 expiry
  last_sign_in    TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

-- ── Church membership + roles ─────────────────────────────────────────────────
-- Links app users to churches. admin = full control, wl = set building +
-- read-only roster, viewer = read-only everything.
CREATE TABLE IF NOT EXISTS church_members (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  church_id    TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'viewer', -- 'admin' | 'wl' | 'viewer'
  invited_by   TEXT REFERENCES users(id),
  joined_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_church ON church_members(church_id);
CREATE INDEX IF NOT EXISTS idx_members_user   ON church_members(user_id);

-- ── Worship team members ──────────────────────────────────────────────────────
-- The people on stage — separate from app users. A team member may or may not
-- have a Sunday app account.
CREATE TABLE IF NOT EXISTS people (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  church_id   TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  roles       TEXT DEFAULT '[]',         -- JSON: ["WL","FLV"]
  tier        INTEGER DEFAULT 2,         -- 1=lead 2=regular 3=developing
  avail       TEXT DEFAULT '[1,2,3,4,5]',-- JSON: available week numbers
  notes       TEXT,
  gender      TEXT,                      -- 'M' | 'F' | 'Other'
  generation  TEXT,                      -- 'Gen Z' | 'Millennial' | 'Gen X' | 'Boomer'
  color       TEXT,
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, name)
);

CREATE INDEX IF NOT EXISTS idx_people_church ON people(church_id);

-- ── Recurring services + one-off events ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  church_id   TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,             -- 'sun-am', 'easter-friday'
  name        TEXT NOT NULL,
  day         TEXT,                      -- 'Sunday'
  time        TEXT,                      -- '9:30am'
  date        TEXT,                      -- ISO date for one-off events
  recurring   INTEGER DEFAULT 1,
  sort_order  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_services_church ON services(church_id);

-- ── Song library ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS songs (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  church_id   TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  artist      TEXT,
  category    TEXT DEFAULT 'current',    -- 'praise' | 'current' | 'homegrown' | 'classic'
  key         TEXT,
  bpm         INTEGER,
  tempo       TEXT,
  mins        REAL DEFAULT 4.5,
  notes       TEXT,
  last_used   TEXT,
  times_used  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, title)
);

CREATE INDEX IF NOT EXISTS idx_songs_church ON songs(church_id);

-- ── Saved set lists ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS set_lists (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  church_id    TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  name         TEXT,
  month        TEXT,
  week         TEXT,
  service_slug TEXT,
  songs        TEXT DEFAULT '[]',        -- JSON: [{title,artist,key,cat}]
  ministry     TEXT DEFAULT '[]',        -- JSON: [{title,artist,key}]
  saved_by     TEXT REFERENCES users(id),
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sets_church ON set_lists(church_id);

-- ── Roster state ─────────────────────────────────────────────────────────────
-- Stores the full roster JSON per church. One row per church, upserted on save.
-- Keeps the simple blob approach so the app sync stays fast and cheap,
-- while still being in a queryable relational DB alongside everything else.
CREATE TABLE IF NOT EXISTS roster_state (
  church_id       TEXT PRIMARY KEY REFERENCES churches(id) ON DELETE CASCADE,
  roster          TEXT DEFAULT '{}',     -- JSON: state.roster
  roster_because  TEXT DEFAULT '{}',     -- JSON: state.rosterBecause
  rostering_rules TEXT DEFAULT '',
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ── Admin keys (temporary — replaced by magic link auth later) ───────────────
-- Keeps the current admin/viewer model working while auth is built.
CREATE TABLE IF NOT EXISTS church_keys (
  church_id   TEXT PRIMARY KEY REFERENCES churches(id) ON DELETE CASCADE,
  admin_key   TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);
