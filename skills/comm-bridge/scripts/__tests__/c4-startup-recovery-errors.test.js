import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

const hookSource = new URL('../c4-session-init.js', import.meta.url);

function fixture(t, bootstrap) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-recovery-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const stable = path.join(root, '.zylos/upgrade');
  const hook = path.join(root, 'hook/c4-session-init.js');
  for (const directory of [stable, path.dirname(hook), path.join(root, 'home'), path.join(root, 'pm2'), path.join(root, 'tmp')]) {
    fs.mkdirSync(directory, {recursive:true, mode:0o700});
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(hookSource, hook);
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode:0o600});
  fs.writeFileSync(path.join(stable, 'maintenance.cjs'), 'module.exports = {};\n', {mode:0o600});
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), bootstrap, {mode:0o600});
  return {root, stable, hook};
}

function runHook(f) {
  // No C4, SQLite, PM2 or runtime modules exist in this fixture. Reaching normal
  // startup imports would fail, so success proves the file-only recovery boundary.
  const env = {
    HOME:path.join(f.root, 'home'), ZYLOS_DIR:f.root, PM2_HOME:path.join(f.root, 'pm2'),
    TMPDIR:path.join(f.root, 'tmp'), TMUX_TMPDIR:path.join(f.root, 'tmp'), PATH:process.env.PATH,
  };
  const result = spawnSync(process.execPath, [f.hook], {
    cwd:f.root, env, encoding:'utf8', timeout:10000, maxBuffer:64*1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /=== UPGRADE RECOVERY TASK ===/);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function details(output) {
  const start = output.lastIndexOf('\n{\n');
  const end = output.indexOf('\n=== END UPGRADE RECOVERY TASK ===', start);
  assert.ok(start >= 0 && end > start, 'displayed recovery block includes structured diagnostics');
  return JSON.parse(output.slice(start + 1, end));
}

// Boundary: real hook entry, trusted bootstrap failure, no normal database graph.
// Run when hook recovery formatting/discovery changes; unrelated routing may skip.
test('startup hook displays the discovery error code, cause and next action without loading C4', t => {
  const f = fixture(t, `exports.bootstrap = () => { throw Object.assign(Error('EACCES: cleanup code denied'), {
    code:'UPGRADE_RECOVERY_REQUIRED', next:'Run zylos recovery status, then zylos recovery resume.'
  }); };\n`);
  const output = runHook(f);
  assert.deepEqual(details(output), {
    code:'UPGRADE_RECOVERY_REQUIRED', error:'EACCES: cleanup code denied',
    next:'Run zylos recovery status, then zylos recovery resume.',
  });
  assert.equal(fs.existsSync(path.join(f.stable, 'active.json')), true);
});

// Boundary: older bootstrap fields must be visible even if its prompt is generic.
// Run when recoveryBlock changes; no services or transaction runner are started.
test('startup hook renders failure fields returned beside an older generic prompt', t => {
  const f = fixture(t, `exports.bootstrap = () => ({active:true, blocked:true, recovery_required:true,
    prompt:'SYSTEM RECOVERY TASK: recovery failed', code:'MANUAL_RECOVERY_REQUIRED',
    error:'process identities cannot be recognized', next:'Preserve transaction materials; inspect manually.'});\n`);
  assert.deepEqual(details(runHook(f)), {
    code:'MANUAL_RECOVERY_REQUIRED', error:'process identities cannot be recognized',
    next:'Preserve transaction materials; inspect manually.',
  });
});

// Boundary: real file validation, not just a synthetic error object.
// Run when the hook's stable-material validation or catch path changes.
test('startup hook preserves a filesystem discovery failure and supplies a recovery next action', t => {
  const f = fixture(t, 'exports.bootstrap = () => { throw Error("must not execute"); };\n');
  fs.unlinkSync(path.join(f.stable, 'maintenance.cjs'));
  const out = details(runHook(f));
  assert.equal(out.code, 'ENOENT');
  assert.match(out.error, /ENOENT/);
  assert.match(out.error, /maintenance\.cjs/);
  assert.match(out.next, /zylos recovery status.*zylos recovery resume/);
});

// Boundary: uncoded dependency errors keep their actual cause and receive a code.
// Run for error normalization changes; ordinary context projection may skip.
test('startup hook keeps an uncoded bootstrap error and supplies the existing recovery code', t => {
  const f = fixture(t, 'exports.bootstrap = () => { throw Error("trusted bootstrap unavailable"); };\n');
  const out = details(runHook(f));
  assert.equal(out.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.equal(out.error, 'trusted bootstrap unavailable');
  assert.match(out.next, /zylos recovery status.*zylos recovery resume/);
});

// Boundary: bounded, data-only diagnostic rendering, including hostile text.
// Run when diagnostic formatting/limits change; no shell executes error text.
test('startup hook bounds long diagnostic fields and renders command-like text only as data', t => {
  const marker = 'must-not-create';
  const hostile = '$(touch ' + marker + ') `touch ' + marker + '`\n';
  const f = fixture(t, `exports.bootstrap = () => { throw Object.assign(Error(${JSON.stringify(hostile)} + 'x'.repeat(9000)), {
    code:'C'.repeat(200), next:'N'.repeat(3000)
  }); };\n`);
  const out = details(runHook(f));
  assert.equal(out.code.length, 128);
  assert.equal(out.error.length, 8192);
  assert.equal(out.next.length, 2048);
  for (const value of Object.values(out)) assert.match(value, / \[truncated\]$/);
  assert.ok(out.error.startsWith(hostile));
  assert.equal(fs.existsSync(path.join(f.root, marker)), false);
});

test('recovery documentation recommends resume and retains only the fixed read-only bootstrap command', () => {
  const document = fs.readFileSync(new URL('../../../../docs/self-upgrade-recovery.md', import.meta.url), 'utf8');
  assert.match(document, /zylos recovery resume/);
  assert.match(document, /bootstrap\.cjs.*--status/);
  assert.doesNotMatch(document, /bootstrap\.cjs[^\n]*--once/);
  assert.match(document, /zylos upgrade --resume-finalize/);
  assert.match(document, /subsequent upgrade deploys the new stable bootstrap/);
  assert.match(document, /frozen recovery files and hashes/);
});

// Parent-path discovery must not replace an underlying stat error with a generic
// validation failure. Run for file-discovery catch changes; no runner is loaded.
test('startup hook preserves a dangling metadata directory discovery error', t=>{
  const f=fixture(t,'throw Error("bootstrap must not load");');
  fs.rmSync(path.join(f.root,'.zylos'),{recursive:true});
  fs.symlinkSync(path.join(f.root,'absent-metadata'),path.join(f.root,'.zylos'),'dir');
  const out=details(runHook(f));
  assert.equal(out.code,'ENOENT');assert.match(out.error,/ENOENT/);
  assert.match(out.next,/zylos recovery status/);
});
