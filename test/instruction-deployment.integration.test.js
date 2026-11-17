import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const driver = fileURLToPath(new URL('./helpers/instruction-deployment.js', import.meta.url));

// Boundary: actual init skill sync/template deployment, split activation and
// upgrade preparation/publication APIs, plus installed reference. No full
// installer, service manager, tmux or authenticated runtimes. Run for packaged
// system templates, handoff references, sync or instruction generation changes;
// unrelated frontend changes may skip. Every bounded child uses private paths,
// read back before launch; cleanup runs even on child failure.
for (const mode of ['fresh', 'refresh']) test(`${mode} instruction deployment preserves owner instructions and installs handoff guidance`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-deploy-'));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp'), TZ: 'Asia/Singapore',
    ZYLOS_PACKAGE_ROOT: repo };
  try {
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
      fs.mkdirSync(env[key]);
      assert.ok(fs.realpathSync(env[key]).startsWith(fs.realpathSync(root) + path.sep), key);
    }
    console.log('Instruction deployment isolation:', JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
      PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, TZ: env.TZ, tmux: 'not launched', pm2: 'not launched' }));
    const deployed = spawnSync(process.execPath, [driver, mode], { env, cwd: repo, encoding: 'utf8', timeout: 30000 });
    assert.equal(deployed.status, 0, `${deployed.error || ''}\n${deployed.stderr}\n${deployed.stdout}`);
    const initialized = spawnSync(process.execPath, [path.join(repo, 'skills/comm-bridge/scripts/c4-session-init.js')],
      { env, cwd: repo, encoding: 'utf8', timeout: 15000 });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.ok(initialized.stdout.includes(path.join(env.ZYLOS_DIR, 'memory/handoff.md')));
    assert.ok(initialized.stdout.includes(path.join(env.ZYLOS_DIR, '.claude/skills/comm-bridge/references/handoff-follow-up.md')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
