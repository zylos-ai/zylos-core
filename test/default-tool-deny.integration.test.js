import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('./helpers/default-tool-deny.js', import.meta.url));

// Boundary: real init template deployment and upgrade settings synchronization,
// including backups and unchanged Codex assets. Run for default deny, template,
// or settings persistence changes; unrelated changes may skip. No authenticated
// runtime, service manager, tmux server or live database is started.
for (const scenario of ['fresh', 'missing', 'custom', 'partial', 'no-deny',
  'invalid-deny', 'null-deny', 'invalid-permissions', 'array-permissions', 'null-permissions', 'dry-run']) {
  test(`default tool deny settings: ${scenario}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-deny-'));
    const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
      PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp') };
    try {
      for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
        fs.mkdirSync(env[key]);
        assert.ok(fs.realpathSync(env[key]).startsWith(fs.realpathSync(root) + path.sep), key);
      }
      console.log('Default tool deny isolation:', JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
        PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, tmux: 'not launched', database: 'not opened' }));
      const child = spawnSync(process.execPath, [helper, scenario], { env, encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, 0, `${child.error || ''}\n${child.stderr}\n${child.stdout}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
