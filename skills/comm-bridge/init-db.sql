-- C4 Communication Bridge Database Schema
-- SQLite database for message logging and session management

-- Checkpoints table (must be created first due to foreign key)
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL  -- 'memory_sync' | 'session_start' | 'manual'
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_timestamp ON checkpoints(timestamp);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL,        -- 'in' | 'out'
    source TEXT NOT NULL,           -- 'telegram' | 'lark' | 'scheduler' | 'system'
    endpoint_id TEXT,               -- chat_id, can be NULL (e.g., scheduler)
    content TEXT NOT NULL,          -- message content
    status TEXT DEFAULT 'pending',  -- 'pending' | 'delivered' (for direction='in' queue)
    priority INTEGER DEFAULT 3,     -- 1=system/idle-required, 2=urgent-user, 3=normal-user
    checkpoint_id INTEGER,          -- associated checkpoint
    FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_checkpoint ON conversations(checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_priority ON conversations(priority);

-- Create initial session_start checkpoint
INSERT INTO checkpoints (type) VALUES ('session_start');
