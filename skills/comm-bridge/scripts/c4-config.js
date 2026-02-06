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

export const FILE_SIZE_THRESHOLD = 1500; // bytes

export const TMUX_SESSION = 'claude-main';
export const CLAUDE_STATUS_FILE = path.join(os.homedir(), '.claude-status');
export const ATTACHMENTS_DIR = path.join(os.homedir(), 'zylos', 'comm-bridge', 'attachments');
export const SKILLS_DIR = path.join(os.homedir(), 'zylos', '.claude', 'skills');

export const STALE_STATUS_THRESHOLD = 5000; // ms
export const TMUX_MISSING_WARN_THRESHOLD = 60;
