// This worker belongs to the isolated Dashboard process group. The sandbox
// reclaims it even when the real notice timeout kills only its direct parent.
import fs from 'node:fs';
fs.writeFileSync(process.env.CHAT_NOTICE_STARTED, JSON.stringify({ pid: process.pid,
  HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME,
  TMPDIR: process.env.TMPDIR, TMUX_TMPDIR: process.env.TMUX_TMPDIR }));
await new Promise(resolve => setTimeout(resolve, 60_000));
