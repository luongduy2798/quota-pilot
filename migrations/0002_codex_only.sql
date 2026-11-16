PRAGMA foreign_keys = ON;

DELETE FROM accounts WHERE kind='oauth' AND provider<>'codex';

PRAGMA foreign_keys = OFF;

CREATE TABLE accounts_codex_only (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('oauth','custom')),
 provider TEXT NOT NULL CHECK(provider IN ('codex','openai-compatible','anthropic-compatible')),
 identity TEXT, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'connected', secret TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
 last_refresh TEXT, last_check TEXT, cooldown_until TEXT, refresh_lock TEXT, refresh_lock_until TEXT,
 work_lock TEXT, work_lock_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(provider, identity),
 CHECK((kind='oauth' AND provider='codex') OR (kind='custom' AND provider IN ('openai-compatible','anthropic-compatible')))
);

INSERT INTO accounts_codex_only
SELECT id,kind,provider,identity,name,enabled,status,secret,config,last_refresh,last_check,
       cooldown_until,refresh_lock,refresh_lock_until,work_lock,work_lock_until,created_at,updated_at
FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_codex_only RENAME TO accounts;

PRAGMA foreign_keys = ON;
