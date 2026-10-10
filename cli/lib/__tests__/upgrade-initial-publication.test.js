import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginUpgrade, maintenance as m, protectedDataReady } from '../upgrade-protection.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coreDir = path.join(root, 'old-package');
  const tempDir = path.join(root, 'new-package');
  const skillsDir = path.join(root, '.claude', 'skills');
  for (const dir of [path.join(coreDir, 'skills', 'core'), path.join(tempDir, 'skills', 'core'), path.join(coreDir, 'cli', 'lib'), path.join(skillsDir, 'core')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(coreDir, 'package.json'), '{"version":"old"}');
  fs.writeFileSync(path.join(coreDir, 'cli', 'lib', 'core-db-backup-worker.js'), '// fixture');
  for (const name of ['.zylos', '.backup']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.chmodSync(path.join(root, name), 0o775);
  }
  const services = m.services;
  m.services = () => [];
  t.after(() => { m.services = services; });
  return { root, skillsDir, ctx: { coreDir, tempDir, from: 'old', to: 'new' } };
}

test('ordinary unconfigured adoption deploys bootstrap and atomically publishes a live controller', t => {
  const f = fixture(t);
  beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir });
  t.after(() => f.ctx.releaseControl());
  assert.equal(fs.existsSync(path.join(f.root, '.zylos/upgrade/bootstrap.cjs')), true);
  assert.deepEqual(f.ctx.bootCapability, { declared: false, verified: false });
  const current = m.transaction(f.root, f.ctx.transactionDir);
  assert.equal(current.phase, 'preparing');
  assert.equal(current.installationIntent, false);
  assert.equal(m.alive(m.read(path.join(f.ctx.transactionDir, 'controller.json'))), true);
  assert.equal(fs.readdirSync(path.join(f.root, '.backup/self-upgrade-staging')).length, 0);
});

test('initial metadata error publishes no transaction and leaves ordinary databases available', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'foreign'), path.join(f.skillsDir, 'invalid'));
  fs.mkdirSync(path.join(f.ctx.tempDir, 'skills', 'invalid'));
  assert.throws(() => beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir }), /individual real directory/);
  assert.equal(m.discover(f.root).blocked, false);
  assert.doesNotThrow(() => m.assertCoreDatabaseAvailable(f.root));
});

test('journal write failure stays outside discovery and cannot poison normal database access', t => {
  const f = fixture(t);
  const update = m.update;
  m.update = () => { throw Error('injected initial journal failure'); };
  try {
    assert.throws(() => beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir }), /initial journal failure/);
  } finally { m.update = update; }
  assert.deepEqual(m.discover(f.root).diagnostics, []);
  assert.equal(m.discover(f.root).blocked, false);
  assert.equal(fs.readdirSync(path.join(f.root, '.backup/self-upgrade')).length, 0);
});

test('declared invalid boot capability fails before transaction publication or stopping services', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.zylos/upgrade'), { mode: 0o700 });
  m.durable(path.join(f.root, '.zylos/upgrade/capability.json'), { formatVersion: 1 });
  let checked = false;
  assert.throws(() => beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir }, {
    verifyBoot: ({ bootstrapPath }) => {
      checked = true;
      assert.equal(fs.existsSync(bootstrapPath), true);
      assert.equal(m.discover(f.root).candidates.length, 0);
      throw Error('injected boot prerequisite failure');
    }
  }), /boot prerequisite failure/);
  assert.equal(checked, true);
  assert.equal(m.discover(f.root).blocked, false);
  assert.equal(f.ctx.preInstallProtection, undefined);
});

test('symlink deployment root records canonical transaction identities', t => {
  const f = fixture(t), alias = f.root + '-alias';
  fs.symlinkSync(f.root, alias);
  t.after(() => fs.unlinkSync(alias));
  beginUpgrade(f.ctx, { zylosDir: alias, skillsDir: path.join(alias, '.claude/skills') });
  t.after(() => f.ctx.releaseControl());
  assert.equal(f.ctx.journal.zylosDir, f.root);
  assert.equal(f.ctx.journal.skillsDir, f.skillsDir);
  assert.equal(m.discover(alias).diagnostics.length, 0);
});

test('data-ready publication refreshes parent context before later durable writes', t => {
  const f = fixture(t);
  beginUpgrade(f.ctx, { zylosDir: f.root, skillsDir: f.skillsDir });
  t.after(() => f.ctx.releaseControl());
  const preflight = m.preflight;
  m.preflight = () => ({ success: true });
  try { protectedDataReady(f.ctx); } finally { m.preflight = preflight; }
  assert.equal(f.ctx.journal.phase, 'new_data_ready');
  m.update(f.ctx.transactionDir, f.ctx.journal, { ecosystemCreationIntent: { test: true } });
  assert.equal(m.read(path.join(f.ctx.transactionDir, 'journal.json')).phase, 'new_data_ready');
});
