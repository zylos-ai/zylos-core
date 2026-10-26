import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { attachCommand } from '../../../commands/attach.js';
import { collectDiagnostics, buildDiagnosticJson } from '../../../commands/doctor.js';
import { resolveCliSession } from '../../cli-session.js';

test('review P2: attach installs a real client-attached hint for an unknown runtime', async t => {
  const f = readyTmuxTarget(t, { prefix: 'cli-attach-real-', ledger: false });
  const selected = await resolveCliSession({ mode: () => ({ mode: 'single' }),
    identity: async () => ({ present: true, runtime: 'unknown', tmuxName: 'zylos-group-origin' }),
    adapter: () => assert.fail('unknown F2 must not select an adapter') });
  let attached = false;
  await attachCommand({ resolve: async () => selected, exec: (command, argv) => {
    assert.equal(command, 'tmux');
    if (argv[0] === 'attach') { attached = true; return ''; }
    return execFileSync(f.binary, ['-S', f.socketPath, ...argv], { encoding: 'utf8' });
  } });
  assert.equal(attached, true);
  assert.match(f.tmux('show-hooks', '-t', '=zylos-group-origin:'), /client-attached.*Ctrl\+B d to detach/);
});

test('review P2: doctor finds an exact isolated tmux session with unreadable runtime identity', async t => {
  const f = readyTmuxTarget(t, { prefix: 'cli-doctor-real-', ledger: false });
  const previous = Object.fromEntries(['PATH', 'TMUX', 'TMUX_TMPDIR'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = f.env[key];
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const resolve = () => resolveCliSession({ mode: () => ({ mode: 'single' }),
    identity: async () => ({ present: true, runtime: 'unknown', tmuxName: 'zylos-group-origin' }),
    adapter: () => assert.fail('unknown must not construct an adapter') });
  const options = { resolve, pm2Check: () => ({ installed: false }),
    network: () => assert.fail('unknown runtime must not choose a provider') };
  const diag = await collectDiagnostics({}, options);
  assert.equal(diag.services.session, true);
  assert.equal(diag.ai.authStatus, 'uncertain');
  assert.equal(diag.ai.cli.reason, 'runtime_unknown');
  const view = buildDiagnosticJson(diag, { success: true, version: 'fixture' });
  assert.ok(view.issues.some(issue => issue.id === 'runtime_unknown'));
  assert.equal(view.issues.some(issue => issue.id === 'cli_missing'), false);
  f.tmux('kill-session', '-t', '=zylos-group-origin');
  assert.equal((await collectDiagnostics({}, options)).services.session, false);
});

test('review status: real CLI is read-only and single mode does not expose group sessions', t => {
  const f = readyTmuxTarget(t, { prefix: 'cli-status-readonly-', ledger: false });
  f.tmux('new-session', '-d', '-s', 'zylos-group-telegram-g123', 'sleep', '60');
  const snapshot = () => {
    const entries = {};
    const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) entries[path.relative(f.root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } };
    walk(f.root); return entries;
  };
  const before = snapshot();
  const text = execFileSync(process.execPath, [new URL('../../../zylos.js', import.meta.url).pathname, 'status', '--json'], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(text.trim().split('\n').length, 1);
  const result = JSON.parse(text);
  assert.equal(result.ok, true);
  assert.equal(result.data.view, 'single');
  assert.deepEqual(result.data.groups, []);
  assert.deepEqual(snapshot(), before, 'status wrote or changed a fixture file');
});
