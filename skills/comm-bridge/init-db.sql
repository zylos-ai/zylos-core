-- C4 Communication Bridge Database Schema
-- SQLite database for message logging and session management

-- Checkpoints table (must be created first due to foreign key)
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,    -- 'memory_sync' | 'session_start' | 'manual'
    summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_timestamp ON checkpoints(timestamp);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL,        -- 'in' | 'out'
    channel TEXT NOT NULL,          -- 'telegram' | 'lark' | 'scheduler' | 'system'
    endpoint_id TEXT,               -- chat_id, can be NULL (e.g., scheduler)
    content TEXT NOT NULL,          -- message content or summary for attachments
    status TEXT DEFAULT 'pending',  -- 'pending' | 'delivered' | 'failed' (for direction='in' queue)
    priority INTEGER DEFAULT 3,     -- 1=urgent, 2=high, 3=normal
    require_idle INTEGER DEFAULT 0, -- 1=wait for Claude idle state, 0=deliver immediately
    last_checkpoint_id INTEGER,     -- associated checkpoint at insert time
    retry_count INTEGER DEFAULT 0,  -- delivery retries for incoming queue
    attachment_path TEXT,           -- path to attachment directory
    FOREIGN KEY (last_checkpoint_id) REFERENCES checkpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_last_checkpoint ON conversations(last_checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_priority ON conversations(priority);

-- Create initial session_start checkpoint
INSERT INTO checkpoints (type) VALUES ('session_start');
