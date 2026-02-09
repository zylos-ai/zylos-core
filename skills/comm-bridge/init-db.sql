-- C4 Communication Bridge Database Schema
-- SQLite database for message logging and session management

-- Checkpoints table
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    summary TEXT,
    start_conversation_id INTEGER, -- first conversation id in this checkpoint's range
    end_conversation_id INTEGER    -- last conversation id in this checkpoint's range
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_timestamp ON checkpoints(timestamp);

-- Conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL,        -- 'in' | 'out'
    channel TEXT NOT NULL,          -- 'telegram' | 'lark' | 'scheduler' | 'system'
    endpoint_id TEXT,               -- chat_id, can be NULL (e.g., scheduler)
    content TEXT NOT NULL,          -- message content (large messages: preview + file path)
    status TEXT DEFAULT 'pending',  -- 'pending' | 'delivered' | 'failed' (for direction='in' queue)
    priority INTEGER DEFAULT 3,     -- 1=urgent, 2=high, 3=normal
    require_idle INTEGER DEFAULT 0, -- 1=wait for Claude idle state, 0=deliver immediately
    retry_count INTEGER DEFAULT 0   -- delivery retries for incoming queue
);

CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_priority ON conversations(priority);

-- Control queue table (heartbeat/system control plane)
CREATE TABLE IF NOT EXISTS control_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    require_idle INTEGER DEFAULT 0,
    bypass_state INTEGER DEFAULT 0,
    ack_deadline_at INTEGER,
    status TEXT DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    available_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_control_queue_status_priority_time
  ON control_queue(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_available_at
  ON control_queue(available_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_ack_deadline
  ON control_queue(ack_deadline_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_updated_at
  ON control_queue(updated_at);

-- Create initial checkpoint
INSERT INTO checkpoints (summary) VALUES ('initial');
