PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('oauth','custom')),
 provider TEXT NOT NULL CHECK(provider IN ('claude','codex','openai-compatible','anthropic-compatible')),
 identity TEXT, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'connected', secret TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
 last_refresh TEXT, last_check TEXT, cooldown_until TEXT, refresh_lock TEXT, refresh_lock_until TEXT,
 work_lock TEXT, work_lock_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(provider, identity),
 CHECK((kind='oauth' AND provider IN ('claude','codex')) OR (kind='custom' AND provider IN ('openai-compatible','anthropic-compatible')))
);
CREATE TABLE quotas (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 fetched_at TEXT, attempted_at TEXT NOT NULL, source TEXT NOT NULL,
 data TEXT NOT NULL DEFAULT '{}', error TEXT, next_poll_at TEXT NOT NULL, poll_lock_until TEXT
);
CREATE TABLE schedules (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 model TEXT NOT NULL, local_time TEXT NOT NULL, timezone TEXT NOT NULL, weekdays TEXT NOT NULL,
 enabled INTEGER NOT NULL, skip_active INTEGER NOT NULL, preset TEXT NOT NULL DEFAULT 'ping',
 next_run TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX schedules_due ON schedules(enabled, next_run);
CREATE TABLE executions (
 id TEXT PRIMARY KEY, schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
 account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
 schedule_name TEXT NOT NULL, occurrence_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('running','success','failed','skipped','missed')),
 model TEXT NOT NULL, error_code TEXT, http_status INTEGER, quota_before TEXT, quota_after TEXT,
 manual_key TEXT UNIQUE, UNIQUE(schedule_id, occurrence_at)
);
CREATE INDEX executions_history ON executions(schedule_id, occurrence_at DESC);
CREATE TABLE sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE oauth_states (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 secret TEXT NOT NULL, account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL, claimed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE login_limits (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at TEXT NOT NULL);
