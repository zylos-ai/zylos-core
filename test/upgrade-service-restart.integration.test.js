import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {test, expect} from '@jest/globals';

const pm2 = process.env.ZYLOS_SERVICE_INTEGRATION_PM2;
const runTest = pm2 ? test : test.skip;

// Covers actual PM2 saved-record stop/start/verification through step11 and
// maintenance.start, with an app absent from the ecosystem. Run when these
// restart boundaries change; skip without an explicitly supplied PM2 binary.
// This does not install npm packages or prove an entire upgrade distribution.
// Run only in isolation: never touch live resources. Isolate HOME, ZYLOS_DIR,
// PM2_HOME and a short TMPDIR; use a private tmux socket and test databases.
// Read back actual arguments, environment and targets before launching, then
// clean only the owned PM2 daemon, socket and fixture resources.
runTest('restores a real custom PM2 application absent from the ecosystem', () => {
  expect(path.isAbsolute(pm2)).toBe(true);
  expect(fs.statSync(fs.realpathSync(pm2)).isFile()).toBe(true);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usr-')));
  fs.chmodSync(root, 0o700);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const name of ['h/zylos', 'pm2', 't', 'tmux', 'tools', 'cache']) fs.mkdirSync(path.join(root, name), {recursive:true});
  const env = {HOME:path.join(root, 'h'), ZYLOS_DIR:path.join(root, 'h/zylos'), PM2_HOME:path.join(root, 'pm2'),
    TMPDIR:path.join(root, 't'), TMUX_TMPDIR:path.join(root, 'tmux'),
    XDG_CONFIG_HOME:path.join(root,'h/.config'), CODEX_HOME:path.join(root,'h/.codex'),
    NPM_CONFIG_PREFIX:path.join(root,'prefix'), NPM_CONFIG_CACHE:path.join(root,'cache'),
    PATH:[path.join(root, 'tools'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TZ:'UTC'};
  fs.symlinkSync(pm2, path.join(root, 'tools/pm2'));
  const socket = path.join(root, 'tmux/private.sock');
  fs.writeFileSync(path.join(root, 'tools/tmux'), `#!/bin/sh\nexec /usr/bin/tmux -S '${socket}' "$@"\n`, {mode:0o700});
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    expect(fs.realpathSync(env[key])).toBe(env[key]);
    expect(env[key].startsWith(root + path.sep)).toBe(true);
  }
  expect(fs.realpathSync(path.join(root, 'tools/pm2'))).toBe(fs.realpathSync(pm2));
  const helper = path.join(repo, 'test/helpers/run-upgrade-service-restart.mjs');
  // Read back the exact child target and isolated environment before launch.
  const args = [helper, JSON.stringify({root, pm2})];
  expect(args[0]).toBe(path.join(repo, 'test/helpers/run-upgrade-service-restart.mjs'));
  expect(socket.startsWith(root + path.sep)).toBe(true);
  expect(Buffer.byteLength(path.join(env.PM2_HOME, 'rpc.sock'))).toBeLessThan(100);
  expect(Buffer.byteLength(socket)).toBeLessThan(100);
  process.stdout.write(JSON.stringify({helper, cwd:root, env, tmuxSocket:socket, databaseRoot:env.ZYLOS_DIR}) + '\n');
  try {
    const result = spawnSync(process.execPath, args, {cwd:root, env, encoding:'utf8', timeout:90000});
    expect(result.error).toBeUndefined();
    if (result.status !== 0) throw Error(`isolated PM2 helper failed (${result.status}): ${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
    expect(report.success).toBe(true);
    expect(report.modes).toEqual(['step11','maintenance']);
    expect(report.identityRejects).toEqual(['step11','maintenance']);
    for (const source of ['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db']) {
      expect(fs.existsSync(path.join(env.ZYLOS_DIR,source))).toBe(false);
    }
  } finally {
    if (fs.existsSync(path.join(env.PM2_HOME, 'pm2.pid'))) {
      const stopped = spawnSync(pm2, ['kill'], {cwd:root, env, encoding:'utf8', timeout:30000});
      expect(stopped.status).toBe(0);
    }
    fs.rmSync(root, {recursive:true, force:true});
  }
}, 120000);
