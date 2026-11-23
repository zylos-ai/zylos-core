import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPostUpgradeSync, preparePostCutoff, publishPostCutoff } from '../upgrade-post-cutoff.js';

const sync = await loadPostUpgradeSync();

function fixture(t, runtime = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'zylos'), transactionDir = path.join(root, 'transaction');
  fs.mkdirSync(zylosDir); fs.mkdirSync(transactionDir);
  const write = (relative, value) => { const file = path.join(zylosDir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  write('CLAUDE.md', 'old instructions'); write('.claude/settings.json', '{}');
  const postCutoff = preparePostCutoff({ sync, zylosDir, transactionDir, homeDir: root, runtime,
    replacements: [{ path: 'CLAUDE.md', content: 'new instructions' }, { path: '.claude/settings.json', kind: 'claude_settings', content: '{"new":true}' }] });
  const journal = { transactionId: 'test', zylosDir, phase: 'compensation_closed', snapshotManifestHash: 'a'.repeat(64),
    compensationCutoff: { formatVersion: 1, closed: true, transactionId: 'test', snapshotManifestHash: 'a'.repeat(64), writer: 'finalizer', closedAt: new Date().toISOString() }, postCutoff };
  const ctx = { zylosDir, transactionDir, transactionId: 'test', journal };
  const persist = (j, changes) => { Object.assign(j, changes); fs.writeFileSync(path.join(transactionDir, 'journal.json'), JSON.stringify(j)); };
  const options = { persist, installHook: () => {}, syncConfig: () => ({ attempted: true, fatal: false }) };
  return { root, write, ctx, options, hooks: () => journal.postCutoff.items.hooks };
}

test('publication rejects a symlink below the instance root', async t => {
  const f = fixture(t);
  const original = path.join(f.ctx.zylosDir, '.claude');
  const moved = path.join(f.root, 'settings');
  fs.renameSync(original, moved);
  fs.symlinkSync(moved, original, 'dir');
  const result = await publishPostCutoff(f.ctx, f.options);
  assert.equal(result.lastError.code, 'material_corrupt');
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, 'CLAUDE.md'), 'utf8'), 'old instructions');
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
  const durable = JSON.parse(fs.readFileSync(path.join(f.ctx.transactionDir, 'journal.json'), 'utf8')).postCutoff.items.hooks;
  assert.equal(durable.state, 'failed');
  assert.equal(durable.lastError.code, 'material_corrupt');
  assert.equal(fs.readFileSync(path.join(f.ctx.zylosDir, 'CLAUDE.md'), 'utf8'), 'old instructions');
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
