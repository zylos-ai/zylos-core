import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn, spawnSync} from 'node:child_process';
import {test, expect} from '@jest/globals';

const driverRoot = process.env.ZYLOS_RECOVERY_INTEGRATION_DRIVER_ROOT;
const integration = process.platform === 'linux' && driverRoot ? test : test.skip;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function fixture() {
  assert.ok(path.isAbsolute(driverRoot));
  assert.ok(fs.statSync(path.join(driverRoot, 'better-sqlite3/package.json')).isFile());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ubr-')));
  for (const directory of ['h/zylos', 'pm2', 't', 'tmux', 'bin', 'cache']) fs.mkdirSync(path.join(root, directory), {recursive:true});
  const env = {HOME:path.join(root, 'h'), ZYLOS_DIR:path.join(root, 'h/zylos'), PM2_HOME:path.join(root, 'pm2'),
    TMPDIR:path.join(root, 't'), TMUX_TMPDIR:path.join(root, 'tmux'), XDG_CONFIG_HOME:path.join(root, 'h/.config'),
    CODEX_HOME:path.join(root, 'h/.codex'), NPM_CONFIG_PREFIX:path.join(root, 'prefix'), NPM_CONFIG_CACHE:path.join(root, 'cache'),
    PATH:[path.join(root, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TZ:'UTC'};
  const calls = path.join(root, 'pm2-calls.jsonl'), state = path.join(root, 'service-state');
  fs.writeFileSync(state, 'online');
  const script = path.join(env.ZYLOS_DIR, '.claude/skills/comm-bridge/service.cjs');
  fs.writeFileSync(path.join(root, 'bin/pm2'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),state=${JSON.stringify(state)};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='jlist') console.log(JSON.stringify([{name:'fixture-custom',pid:fs.readFileSync(state,'utf8')==='online'?process.pid:0,pm2_env:{status:fs.readFileSync(state,'utf8'),pm_exec_path:${JSON.stringify(script)}}}]));
else if(args[0]==='stop') fs.writeFileSync(state,'stopped');
else if(args[0]==='restart') fs.writeFileSync(state,'online');
else if(args[0]!=='save') process.exit(2);
`, {mode:0o700});
  const socket = path.join(root, 'tmux/private.sock');
  fs.writeFileSync(path.join(root, 'bin/tmux'), `#!/bin/sh\nexec /usr/bin/tmux -S '${socket}' "$@"\n`, {mode:0o700});
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.equal(fs.realpathSync(env[key]), env[key]);
    assert.ok(env[key].startsWith(root + path.sep));
  }
  assert.ok(socket.startsWith(root + path.sep));
  const bootstrap = path.join(env.ZYLOS_DIR, '.zylos/upgrade/bootstrap.cjs');
  const run = flag => {
    const result = spawnSync(process.execPath, [bootstrap, '--root', env.ZYLOS_DIR, flag], {cwd:root, env, encoding:'utf8', timeout:30000});
    assert.ifError(result.error);
    return {...result, output:JSON.parse(result.stdout.trim().split('\n').at(-1))};
  };
  return {root, env, calls, state, script, bootstrap, run};
}

async function crashController(f, closed) {
  const helper = path.join(repo, 'test/helpers/prepare-upgrade-recovery.mjs');
  assert.ok(fs.statSync(helper).isFile());
  const child = spawn(process.execPath, [helper, JSON.stringify({root:f.root, driverRoot, closed})], {cwd:f.root, env:f.env, stdio:['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('controller preparation timed out: ' + stderr)), 30000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('\n')) {
          clearTimeout(timer);
          try { resolve(JSON.parse(stdout.trim().split('\n').at(-1))); } catch (error) { reject(error); }
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(Error(`controller exited ${code}/${signal}: ${stderr}`)); });
    });
    expect(ready.installationIntent).toBe(true);
    const m = require(path.join(f.env.ZYLOS_DIR, '.zylos/upgrade/maintenance.cjs'));
    expect(m.alive(m.read(path.join(ready.transactionDir, 'controller.json')))).toBe(true);
    return {...ready, m};
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
}

// Covers real prepareProtectedInstall descriptor production, durable controller
// crash admission and fixed bootstrap execution. Run when these contracts change.
// Skip without an explicit SQLite dependency root. No npm install, real PM2,
// live database, channel or live tmux socket is used. The private SQLite database
// is snapshotted but kept unchanged during compensation; this case does not prove
// schema migration or database replacement. All writable targets and
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR are private and removed after each case.
integration('recovers a prepared transaction after its controller crashes before the cutoff', async () => {
  const f = fixture();
  try {
    const prepared = await crashController(f, false);
    const result = f.run('--once');
    expect(result.status).toBe(0);
    expect(result.output).toEqual({active:false, resumed:true});
    expect(prepared.m.read(path.join(prepared.transactionDir, 'journal.json')).phase).toBe('restored_complete');
    expect(fs.readFileSync(f.script, 'utf8')).toBe('original deployment\n');
    expect(fs.readFileSync(f.state, 'utf8')).toBe('online');
    const discovered = prepared.m.discover(f.env.ZYLOS_DIR);
    expect(discovered.candidates).toEqual([]);
    expect(discovered.diagnostics).toEqual([]);
    expect(discovered.marker).toBeNull();
    expect(fs.existsSync(path.join(f.env.ZYLOS_DIR, '.zylos/upgrade/active.json'))).toBe(false);
    expect(prepared.m.hash(path.join(f.env.ZYLOS_DIR, 'comm-bridge/c4.db'))).toBe(prepared.databaseHash);
    for (const source of ['scheduler/scheduler.db', 'web-console/web-console.db']) expect(fs.existsSync(path.join(f.env.ZYLOS_DIR, source))).toBe(false);
  } finally { fs.rmSync(f.root, {recursive:true, force:true}); }
}, 60000);

// Same isolation as above; additionally proves the documented --once command
// does not stop a manually restarted service after compensation has closed.
integration('requires consistent manual completion without stopping services after the cutoff', async () => {
  const f = fixture();
  try {
    const prepared = await crashController(f, true);
    fs.writeFileSync(f.state, 'online');
    fs.writeFileSync(f.calls, '');
    const status = f.run('--status'), once = f.run('--once');
    expect(once.status).toBe(1);
    expect(status.status).toBe(1);
    const startupResult = spawnSync(process.execPath, [path.join(repo, 'test/helpers/read-upgrade-startup.mjs'), f.env.ZYLOS_DIR],
      {cwd:f.root, env:f.env, encoding:'utf8', timeout:30000});
    assert.ifError(startupResult.error);
    expect(startupResult.status).toBe(0);
    const startup = JSON.parse(startupResult.stdout);
    for (const output of [status.output, once.output, startup]) {
      expect(output.code).toBe('UPGRADE_MANUAL_COMPLETION_REQUIRED');
      expect(output.next).toBe('docs/self-upgrade-recovery.md#manual-forward-repair-after-the-cutoff');
      expect(output.automaticResume).toBe(false);
      expect(output.recovery_required).toBe(true);
      expect(output.prompt).not.toMatch(/"resume":/);
    }
    expect(once.stdout + once.stderr).not.toMatch(/hash.*(?:missing|mismatch)|missing.*hash/i);
    expect(fs.readFileSync(f.calls, 'utf8')).toBe('');
    expect(fs.readFileSync(f.state, 'utf8')).toBe('online');
    expect(prepared.m.read(path.join(prepared.transactionDir, 'journal.json')).phase).toBe('recovery_required');
  } finally { fs.rmSync(f.root, {recursive:true, force:true}); }
}, 60000);

// Same private prepare/crash boundary; terminal cleanup must use the stable
// recovery entry even when per-transaction executable material is unavailable.
integration('finishes a verified terminal cleanup through the stable recovery entry', async () => {
  const f = fixture();
  try {
    const prepared = await crashController(f, true);
    const j = prepared.m.read(path.join(prepared.transactionDir, 'journal.json'));
    prepared.m.update(prepared.transactionDir, j, {phase:'upgrade_complete',
      terminalEvidence:{verified:true, kind:'code_data_services'},
      cleanup:{complete:false, codeRemoved:false, servicesRestored:true}});
    expect(prepared.m.terminalValid(j)).toBe(true);
    fs.unlinkSync(path.join(prepared.transactionDir, 'descriptor.json'));
    fs.writeFileSync(f.calls, '');
    const result = f.run('--once');
    expect(result.status).toBe(0);
    expect(result.output).toEqual({active:false, resumed:true});
    const terminal = prepared.m.read(path.join(prepared.transactionDir, 'journal.json'));
    expect(terminal.cleanup.complete).toBe(true);
    expect(terminal.cleanup.codeRemoved).toBe(true);
    expect(fs.existsSync(path.join(prepared.transactionDir, 'code'))).toBe(false);
    expect(prepared.m.discover(f.env.ZYLOS_DIR).candidates).toEqual([]);
    expect(fs.readFileSync(f.calls, 'utf8')).toBe('');
  } finally { fs.rmSync(f.root, {recursive:true, force:true}); }
}, 60000);
