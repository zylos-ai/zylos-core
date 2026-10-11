
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      session_token TEXT,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      size_label TEXT,
      mime TEXT,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
  