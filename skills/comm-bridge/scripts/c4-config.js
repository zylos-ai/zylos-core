import path from 'path';
import os from 'os';

export const POLL_INTERVAL_BASE = 1000;
export const POLL_INTERVAL_MAX = 3000;

export const DELIVERY_DELAY_BASE = 200;
export const DELIVERY_DELAY_PER_KB = 100;
export const DELIVERY_DELAY_MAX = 1000;

export const MAX_RETRIES = 5;
export const RETRY_BASE_MS = 500;

export const ENTER_VERIFY_MAX_RETRIES = 3;
export const ENTER_VERIFY_WAIT_MS = 500;

// For require_idle messages: allow execution time before dispatching the next message.
export const REQUIRE_IDLE_POST_SEND_HOLD_MS = 5000;
export const REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS = 120000;
export const REQUIRE_IDLE_EXECUTION_POLL_MS = 1000;

export const FILE_SIZE_THRESHOLD = 1500; // bytes
export const CONTENT_PREVIEW_CHARS = 100;

export const TMUX_SESSION = 'claude-main';
export const CLAUDE_STATUS_FILE = path.join(os.homedir(), '.claude-status');
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export const DATA_DIR = path.join(ZYLOS_DIR, 'comm-bridge');
export const DB_PATH = path.join(DATA_DIR, 'c4.db');
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
export const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');

export const CHECKPOINT_THRESHOLD = 30;      // unsummarized conversation count to trigger Memory Sync
export const SESSION_INIT_RECENT_COUNT = 6;  // max conversations returned by session-init when above threshold

export const STALE_STATUS_THRESHOLD = 5000; // ms
export const TMUX_MISSING_WARN_THRESHOLD = 30;
