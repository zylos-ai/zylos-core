import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preparePostCutoff, publishPostCutoff, removeLegacyDashboardHooks, dashboardHookCommands } from '../upgrade-post-cutoff.js';
import { installCoreCodexHook, coreSessionStartCommand } from '../codex-hooks.js';

function fixture(t, runtime = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'zylos'), transactionDir = path.join(root, 'transaction');
  fs.mkdirSync(zylosDir); fs.mkdirSync(transactionDir);
  const write = (relative, value) => { const file = path.join(zylosDir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  write('CLAUDE.md', 'old instructions'); write('.claude/settings.json', '{}');
  const postCutoff = preparePostCutoff({ zylosDir, transactionDir, homeDir: root, runtime,
    replacements: [{ path: 'CLAUDE.md', content: 'new instructions' }, { path: '.claude/settings.json', kind: 'claude_settings', content: '{"new":true}' }] });
  const journal = { transactionId: 'test', zylosDir, phase: 'compensation_closed', snapshotManifestHash: 'a'.repeat(64),
    compensationCutoff: { formatVersion: 1, closed: true, transactionId: 'test', snapshotManifestHash: 'a'.repeat(64), writer: 'finalizer', closedAt: new Date().toISOString() }, postCutoff };
  const ctx = { zylosDir, transactionDir, transactionId: 'test', journal };
  const persist = (j, changes) => { Object.assign(j, changes); fs.writeFileSync(path.join(transactionDir, 'journal.json'), JSON.stringify(j)); };
  const options = { persist, installHook: () => {}, syncConfig: () => ({ attempted: true, fatal: false }) };
  return { root, write, ctx, options, hooks: () => journal.postCutoff.items.hooks };
}

test('staging leaves shared bytes unchanged and no-Codex state omits reconcile targets', t => {
  const f = fixture(t);
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, 'CLAUDE.md'), 'utf8'), 'old instructions');
  assert.equal(f.hooks().targets.length, 2);
  assert.equal(fs.existsSync(path.join(f.ctx.zylosDir, '.codex')), false);
});

test('replace conflict preserves bytes; repair retries and done drift never rolls back done', async t => {
  const f = fixture(t);
  f.write('.claude/settings.json', 'conflict');
  const failed = await publishPostCutoff(f.ctx, f.options);
  assert.equal(failed.lastError.code, 'runtime_config_conflict');
  assert.equal(failed.lastError.targetId, 't02');
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, '.claude/settings.json'), 'utf8'), 'conflict');
  f.write('.claude/settings.json', '{}');
  assert.equal((await publishPostCutoff(f.ctx, f.options)).ok, true);
  assert.equal(f.hooks().attempts, 2);
  f.write('CLAUDE.md', 'user drift');
  assert.equal((await publishPostCutoff(f.ctx, f.options)).lastError.code, 'runtime_config_conflict');
  assert.equal(f.hooks().state, 'done');
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, 'CLAUDE.md'), 'utf8'), 'user drift');
});

for (const damage of ['missing', 'hash', 'traversal', 'symlink']) test(`all materials validated before any write: ${damage}`, async t => {
  const f = fixture(t);
  const target = f.hooks().targets[1];
  const file = path.join(f.ctx.transactionDir, target.beforeFile);
  if (damage === 'missing') fs.unlinkSync(file);
  if (damage === 'hash') fs.writeFileSync(file, 'damaged');
  if (damage === 'traversal') target.beforeFile = '../outside';
  if (damage === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(path.join(f.ctx.zylosDir, '.claude/settings.json'), file); }
  assert.equal((await publishPostCutoff(f.ctx, f.options)).lastError.code, 'material_corrupt');
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, 'CLAUDE.md'), 'utf8'), 'old instructions');
});

test('deadline before first publication leaves pending; expiration after file retains committed bytes', async t => {
  const f = fixture(t);
  const expired = () => { throw Error('expired'); };
  const initial = await publishPostCutoff(f.ctx, { ...f.options, checkBudget: expired });
  assert.equal(initial.lastError.code, 'deadline_exceeded'); assert.equal(f.hooks().state, 'pending');
  let deadline = false;
  const result = await publishPostCutoff(f.ctx, { ...f.options, afterStep: () => { deadline = true; }, checkBudget: () => { if (deadline) expired(); } });
  assert.equal(result.lastError.code, 'deadline_exceeded');
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, 'CLAUDE.md'), 'utf8'), 'new instructions');
  assert.equal((await publishPostCutoff(f.ctx, f.options)).ok, true);
});

test('exact Dashboard command removal preserves mixed user hooks and similar commands', () => {
  const root = '/isolated/zylos', command = [...dashboardHookCommands(root)][1];
  const original = { hooks: { SessionStart: [{ matcher: 'x', hooks: [{ command }, { command: command + ' --user' }, { command: 'echo user' }] }] } };
  const next = removeLegacyDashboardHooks(original, root);
  assert.equal(original.hooks.SessionStart[0].hooks.length, 3);
  assert.deepEqual(next.hooks.SessionStart[0].hooks.map(h => h.command), [command + ' --user', 'echo user']);
});

for (const [name, response, code] of [
  ['fatal', { attempted: true, fatal: true, error: 'write failed' }, 'codex_config_reconcile_failed'],
  ['state changed', { attempted: false }, 'codex_config_reconcile_failed'],
  ['unchanged success', { attempted: true, fatal: false, changed: false }, null],
  ['warning', { attempted: true, fatal: false, warning: true, error: 'write failed' }, null],
]) test(`Codex result mapping: ${name}`, async t => {
  const f = fixture(t, 'codex');
  const result = await publishPostCutoff(f.ctx, { ...f.options, syncConfig: () => response });
  assert.equal(result.lastError?.code || null, code);
  assert.equal(f.hooks().state, code ? 'failed' : 'done');
  assert.equal(f.hooks().warnings.length, name === 'warning' ? 2 : 0);
  if (code) assert.equal(result.lastError.targetId, 't04');
});

for (const [relative, value, id] of [['.codex/hooks.json', '{"hooks":', 't03'], ['.codex/config.toml', 'foo = "', 't04']]) test(`unparseable ${relative} invokes no Codex writer`, async t => {
  const f = fixture(t, 'codex'); f.write(relative, value);
  let calls = 0;
  const result = await publishPostCutoff(f.ctx, { ...f.options, installHook: () => calls++, syncConfig: () => calls++ });
  assert.equal(result.lastError.code, 'codex_config_unparseable'); assert.equal(result.lastError.targetId, id);
  assert.equal(calls, 0); assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, relative), 'utf8'), value);
});

test('Codex writer exception is retryable, done never reconciles again', async t => {
  const f = fixture(t, 'codex');
  const result = await publishPostCutoff(f.ctx, { ...f.options, installHook: () => { throw Error('unwritable'); } });
  assert.equal(result.lastError.code, 'codex_config_reconcile_failed'); assert.equal(result.lastError.targetId, 't03');
  assert.equal((await publishPostCutoff(f.ctx, f.options)).ok, true);
  assert.equal((await publishPostCutoff(f.ctx, { ...f.options, installHook: () => { throw Error('must not run'); } })).ok, true);
  assert.equal(f.hooks().attempts, 2);
});

for (const stillWarn of [false, true]) test(`warnings from interrupted attempt replaced without duplicates: ${stillWarn}`, async t => {
  const f = fixture(t, 'codex');
  const warning = () => ({ attempted: true, fatal: false, warning: true, error: 'cannot write' });
  await publishPostCutoff(f.ctx, { ...f.options, syncConfig: warning, afterStep: step => { if (step === 'before_done') throw Error('interrupted'); } });
  assert.equal(f.hooks().state, 'failed'); assert.deepEqual(f.hooks().warnings, []);
  await publishPostCutoff(f.ctx, { ...f.options, ...(stillWarn ? { syncConfig: warning } : {}) });
  assert.equal(f.hooks().warnings.length, stillWarn ? 2 : 0);
  if (stillWarn) assert.deepEqual(f.hooks().warnings.map(w => w.targetId), ['t04', 't05']);
});

test('CODEX_HOME ignored and same project/global TOML deduplicated', t => {
  const f = fixture(t, 'codex');
  assert.equal(f.hooks().codexGlobalDir, path.join(f.root, '.codex'));
  const staged = preparePostCutoff({ transactionDir: f.ctx.transactionDir, zylosDir: f.ctx.zylosDir, homeDir: f.ctx.zylosDir, runtime: 'codex', replacements: [] });
  assert.equal(staged.items.hooks.targets.filter(x => x.kind === 'codex_toml').length, 1);
});

for (const crashAt of ['t02', 'dashboard_hooks_removed', 'codex_hook_installed', 'codex_config_synced', 'before_done']) test(`process death at ${crashAt} resumes solely from durable journal and staged inputs`, async t => {
  const f = fixture(t, 'codex');
  f.options.persist(f.ctx.journal, {});
  const moduleUrl = new URL('../upgrade-post-cutoff.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { publishPostCutoff } from ${JSON.stringify(moduleUrl)};
    const transactionDir = process.argv[1];
    const journal = JSON.parse(fs.readFileSync(transactionDir + '/journal.json'));
    await publishPostCutoff({transactionDir, journal, transactionId: journal.transactionId}, {
      persist: (j, changes) => {Object.assign(j, changes); fs.writeFileSync(transactionDir+'/journal.json', JSON.stringify(j));},
      installHook: () => fs.writeFileSync(journal.zylosDir+'/.codex/hooks.json', '{"hooks":{}}'),
      syncConfig: () => ({attempted:true, fatal:false}),
      afterStep: step => {if(step === process.argv[2]) process.kill(process.pid, 'SIGKILL');}
    });`;
  // t03's parent is absent before install; create only its isolated test directory.
  fs.mkdirSync(path.join(f.ctx.zylosDir, '.codex'), { recursive: true });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.ctx.transactionDir, crashAt], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const restarted = { ...f.ctx, journal: JSON.parse(fs.readFileSync(path.join(f.ctx.transactionDir, 'journal.json'))) };
  const publishedAt = fs.statSync(path.join(f.ctx.zylosDir, '.claude/settings.json')).mtimeMs;
  const result = await publishPostCutoff(restarted, f.options);
  assert.equal(result.ok, true);
  assert.equal(fs.statSync(path.join(f.ctx.zylosDir, '.claude/settings.json')).mtimeMs, publishedAt);
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, 'CLAUDE.md'), 'utf8'), 'new instructions');
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, '.claude/settings.json'), 'utf8'), '{"new":true}');
});

test('real Core Codex reconciler matches direct reuse after exact Dashboard removal; trust is untouched', async t => {
  const f = fixture(t, 'codex');
  const dashboard = [...dashboardHookCommands(f.ctx.zylosDir)][1];
  const core = coreSessionStartCommand(f.ctx.zylosDir);
  const original = { hooks: { SessionStart: [
    { hooks: [{ type: 'command', command: dashboard }] },
    { hooks: [{ type: 'command', command: core }] },
    { matcher: 'user', hooks: [{ type: 'command', command: core }, { type: 'command', command: 'echo user' }] },
  ] } };
  f.write('.codex/hooks.json', JSON.stringify(removeLegacyDashboardHooks(original, f.ctx.zylosDir)));
  installCoreCodexHook({ zylosDir: f.ctx.zylosDir });
  const expected = fs.readFileSync(path.join(f.ctx.zylosDir, '.codex/hooks.json'), 'utf8');
  f.write('.codex/hooks.json', JSON.stringify(original));
  f.write('.codex/hooks.trust.json', 'trust-marker-sentinel');
  const result = await publishPostCutoff(f.ctx, { ...f.options, installHook: installCoreCodexHook });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, '.codex/hooks.json'), 'utf8'), expected);
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, '.codex/hooks.trust.json'), 'utf8'), 'trust-marker-sentinel');
  assert.equal(fs.existsSync(path.join(f.root, '.codex/config.toml')), false);
});

test('real Codex publication uses captured home, preserves user TOML, and ignores CODEX_HOME', t => {
  const f = fixture(t, 'codex');
  f.write('.zylos/config.json', '{"runtime":"codex"}');
  f.write('.codex/config.toml', 'user_setting = "project"\n');
  fs.mkdirSync(path.join(f.root, '.codex'));
  fs.writeFileSync(path.join(f.root, '.codex/config.toml'), 'user_setting = "global"\n');
  f.write('.codex/hooks.trust.json', 'marker sentinel');
  f.options.persist(f.ctx.journal, {});
  const moduleUrl = new URL('../upgrade-post-cutoff.js', import.meta.url).href;
  const script = `import fs from 'node:fs'; import {publishPostCutoff} from ${JSON.stringify(moduleUrl)};
    const transactionDir=process.argv[1], journal=JSON.parse(fs.readFileSync(transactionDir+'/journal.json'));
    const result=await publishPostCutoff({transactionDir,journal,transactionId:journal.transactionId}, {
      persist:(j,c)=>{Object.assign(j,c);fs.writeFileSync(transactionDir+'/journal.json',JSON.stringify(j));}
    }); console.log(JSON.stringify(result)); if(!result.ok) process.exitCode=1;`;
  const otherHome = path.join(f.root, 'other-codex-home');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.ctx.transactionDir], {
    env: { ...process.env, HOME: f.root, ZYLOS_DIR: f.ctx.zylosDir, CODEX_HOME: otherHome }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(path.join(f.root, '.codex/config.toml'), 'utf8'), /user_setting = "global"/);
  assert.match(fs.readFileSync(path.join(f.ctx.zylosDir, '.codex/config.toml'), 'utf8'), /user_setting = "project"/);
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, '.codex/hooks.trust.json'), 'utf8'), 'marker sentinel');
  assert.equal(fs.existsSync(otherHome), false);
});
