import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { guardDatabase } from '../../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../../comm-bridge/scripts/c4-schema.js';
import { sendViaC4 } from '../../runtime.js';
import { isolatedTmux, tmuxClientEnv } from '../../../../../test/helpers/isolated-tmux.js';

// Real receive CLI, filesystem validation, route fallback and D1 persistence.
// The private tmux socket and absent AM socket cannot reach a live instance.
export function realReceive(t, { health, noticeExit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-real-receive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = tmuxClientEnv(isolatedTmux(t), { ...process.env, HOME: root, ZYLOS_DIR: root });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  for (const component of ['telegram', 'lark']) {
    const dir = path.join(root, '.claude', 'skills', component, 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    if (noticeExit !== undefined) fs.writeFileSync(path.join(dir, 'send.js'), `process.exit(${noticeExit});\n`);
  }
  if (health) {
    const dir = path.join(root, 'activity-monitor', 'runtime-health');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude.json'), JSON.stringify({ v: 1, runtime: 'claude', health,
      reason: health, updatedAt: 1, hook: {}, unavailableSince: 0, cooldownUntil: 0,
      recoveringStartedAt: 0, lastUserMessageRecoveryAt: 0, restartFailureCount: 0,
      lastRecoveryAt: 0, lastDownCheckAt: 0, rateLimitResetTime: '' }));
  }
  const data = path.join(root, 'comm-bridge');
  fs.mkdirSync(data, { recursive: true });
  const db = new Database(path.join(data, 'c4.db'));
  guardDatabase(db, schema); db.pragma('journal_mode=WAL');
  t.after(() => db.close());
  const receivePath = fileURLToPath(new URL('../../../../comm-bridge/scripts/c4-receive.js', import.meta.url));
  const calls = [];
  const send = (message, options) => sendViaC4(message, options, { receivePath,
    execute(command, args, settings) {
      calls.push({ command, args: args.slice(1), settings });
      return execFileSync(command, args, { ...settings, env });
    } });
  return { send, calls, db, root, rows: () => db.prepare('SELECT * FROM conversations ORDER BY id').all() };
}
