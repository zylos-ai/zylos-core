import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import { createModeSwitchConverter } from '../../skills/activity-monitor/scripts/mode-switch-convert.js';
const [root, point] = process.argv.slice(2);
const db = new Database(path.join(root, 'c4.db'));
const store = createStore(db);
const fsImpl = { ...fs, renameSync(source, target) {
  fs.renameSync(source, target);
  const match = point === 'archive' ? target.includes('/previous/') && !target.endsWith('/.done')
    : point === 'skeleton' ? target.endsWith('/state.md') && !target.includes('/previous/')
      : point === 'handoff' ? target.endsWith('/handoff.md') && !target.includes('/previous/') : false;
  if (match) process.kill(process.pid, 'SIGKILL');
} };
createModeSwitchConverter({ db: store, zylosDir: root, fsImpl })(store.getModeTransition());
db.close();
