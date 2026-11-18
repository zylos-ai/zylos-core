import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Boundary: full Docker shell entrypoint and shared client policy, with private
// fake zylos/PM2/sleep/tmux binaries. Run for Docker tmux-call or directory-policy changes; otherwise
// skip. HOME/ZYLOS_DIR/PM2_HOME/TMPDIR are private; no server or DB is used.
for (const [runtime, mode] of [['claude', 'private'], ['codex', 'private'], ['claude', 'missing'], ['claude', 'shutdown-missing']]) {
  test(`Docker ${runtime} entrypoint uses ${mode} directory policy for startup and shutdown`, { timeout: 10000 }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-tmux-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'h'), bin = path.join(root, 'b'), tmp = path.join(root, 't');
    for (const dir of [home, bin, tmp]) fs.mkdirSync(dir, { mode: 0o700 });
    const zylos = path.join(home, 'zylos');
    const skills = path.join(zylos, '.claude/skills'); fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(fileURLToPath(new URL('../skills/comm-bridge', import.meta.url)), path.join(skills, 'comm-bridge'));
    const calls = path.join(root, 'calls.jsonl');
    fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}\nimport fs from 'node:fs';
fs.appendFileSync(process.env.TMUX_CALLS, JSON.stringify({args:process.argv.slice(2),
identity:process.env.ZYLOS_RUN_ID})+'\\n');
if (process.env.TMUX_REMOVE_ON_LAUNCH === '1' && process.argv.includes('new-session')) fs.renameSync(process.env.TMUX_TMPDIR, process.env.TMUX_TMPDIR+'-gone');
if (process.argv.includes('kill-session')) { console.error('fixture absent session'); process.exit(1); }\n`, { mode: 0o700 });
    for (const name of ['zylos', 'pm2', 'sleep']) fs.writeFileSync(path.join(bin, name),
      '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'p'), TMPDIR: tmp,
      PATH: `${bin}:${process.env.PATH}`, TMUX_CALLS: calls, ZYLOS_RUNTIME: runtime,
      ZYLOS_RUN_ID: 'must-not-inherit', CODEX_API_KEY: 'fixture', OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' };
    if (mode === 'shutdown-missing') env.TMUX_REMOVE_ON_LAUNCH = '1';
    delete env.TMUX;
    env.TMUX_TMPDIR = mode === 'missing' ? path.join(tmp, 'missing') : tmp;
    t.diagnostic(JSON.stringify({ HOME: home, ZYLOS_DIR: zylos, PM2_HOME: env.PM2_HOME,
      TMPDIR: tmp, TMUX_TMPDIR: env.TMUX_TMPDIR ?? null, binary: path.join(bin, 'tmux') }));
    const result = spawnSync('bash', [fileURLToPath(new URL('../docker/entrypoint.sh', import.meta.url))],
      { env, timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    if (mode === 'missing') {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /TMUX_DIR_MISSING/);
      assert.equal(fs.existsSync(calls), false);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /fixture absent session/);
    const rows = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    if (mode === 'shutdown-missing') {
      assert.match(result.stderr, /TMUX_DIR_MISSING/);
      assert.equal(rows.length, 2, 'shutdown stops are rejected before client invocation');
      return;
    }
    assert.equal(rows.length, 4, 'stale-session stop, launch and both shutdown stops');
    const prefix = ['-S', path.join(tmp, `tmux-${process.getuid()}`, 'default')];
    assert.deepEqual(rows.map(row => row.args.slice(0, prefix.length)), rows.map(() => prefix));
    assert.deepEqual(rows.map(row => row.args[prefix.length]), ['kill-session', 'new-session', 'kill-session', 'kill-session']);
    assert.ok(rows.every(row => row.identity === undefined));
  });
}
