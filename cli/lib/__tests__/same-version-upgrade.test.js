import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../../skills/comm-bridge/scripts/sqlite-driver.js';
import { migrateDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import * as schedulerSchema from '../../../skills/scheduler/scripts/schema.js';
import { upgradeSelfCore } from '../../commands/component.js';

// An installation already at the latest version can still hold older databases,
// because ordinary opens only check. `zylos upgrade --self` then hands the
// installed package to the protected transaction instead of answering "up to
// date". The probe and the package copy are real; the protected transaction
// itself is covered by the finalizer and recovery suites, so it stops at the
// handoff here. Private HOME/ZYLOS_DIR/TMPDIR; no service, npm or network use.
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const history = fileURLToPath(new URL('../../../skills/comm-bridge/scripts/__tests__/fixtures/migration-history/', import.meta.url));
const VERSION = '1.0.0';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'same-version-upgrade-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const zylosDir = path.join(home, 'zylos');
  // The live skills provide the SQLite driver the probe opens databases with.
  fs.mkdirSync(path.join(zylosDir, '.claude/skills'), { recursive: true });
  for (const owner of ['comm-bridge', 'scheduler']) fs.symlinkSync(path.join(repo, 'skills', owner), path.join(zylosDir, '.claude/skills', owner));
  // A minimal installed package: its schemas are the real ones.
  const installedRoot = path.join(home, 'prefix/lib/node_modules/zylos');
  fs.mkdirSync(path.join(installedRoot, 'cli/lib'), { recursive: true });
  fs.mkdirSync(path.join(installedRoot, 'node_modules/dependency'), { recursive: true });
  fs.writeFileSync(path.join(installedRoot, 'node_modules/dependency/index.js'), 'dependency');
  fs.writeFileSync(path.join(installedRoot, 'package.json'), JSON.stringify({ name: 'zylos', version: VERSION }));
  fs.writeFileSync(path.join(installedRoot, 'cli/lib/upgrade-entry.js'), '// installed entry\n');
  fs.symlinkSync(path.join(repo, 'skills'), path.join(installedRoot, 'skills'));
  const file = relative => path.join(zylosDir, relative);
  const create = (relative, sql) => {
    fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
    const db = new Database(file(relative));
    try { db.exec(fs.readFileSync(path.join(history, sql), 'utf8')); } finally { db.close(); }
  };
  const bytes = () => Object.fromEntries(['comm-bridge/c4.db', 'scheduler/scheduler.db']
    .filter(relative => fs.existsSync(file(relative))).map(relative => [relative, fs.readFileSync(file(relative))]));
  const calls = { handoff: [], downloads: 0, prompts: [] };
  const logs = [], errors = [];
  const deps = {
    zylosDir, installedRoot,
    checkForCoreUpdates: () => ({ success: true, current: VERSION, latest: VERSION, hasUpdate: false }),
    checkCoreTargetVersion: version => ({ success: true, current: VERSION, latest: version, hasUpdate: false }),
    recoverBeforeUpgrade: () => ({ active: false }),
    downloadCoreToTemp() { calls.downloads++; return { success: false, error: 'no download for the installed version' }; },
    promptYesNo: async question => { calls.prompts.push(question); return true; },
    runDownloadedUpgrade(handoff) {
      // Inspect the package while it still exists; the caller removes it afterwards.
      calls.handoff.push({ ...handoff,
        packageJson: fs.readFileSync(path.join(handoff.tempDir, 'package.json'), 'utf8'),
        hasNodeModules: fs.existsSync(path.join(handoff.tempDir, 'node_modules')),
        schema: fs.existsSync(path.join(handoff.tempDir, 'skills/comm-bridge/scripts/c4-schema.js')),
        databases: bytes() });
      return 0;
    },
    console: { log: value => logs.push(String(value)), error: value => errors.push(String(value)) },
  };
  return { home, zylosDir, installedRoot, file, create, bytes, calls, logs, errors, deps };
}

const migrateTo = (file, owner) => { const db = new Database(file); try { migrateDatabase(db, owner, { strict: false }); } finally { db.close(); } };
const noTransaction = f => assert.equal(fs.existsSync(path.join(f.zylosDir, '.backup')), false);

for (const explicit of [false, true]) test(`already current Core with older C4 and scheduler databases runs the protected transaction on the installed package${explicit ? ' (explicit --version)' : ''}`, async t => {
  const f = fixture(t);
  f.create('comm-bridge/c4.db', 'c4-v0.9.0-v1.sql');
  f.create('scheduler/scheduler.db', 'scheduler-v0.9.0-v1.sql');
  const before = f.bytes();
  const options = explicit ? { version: VERSION } : {};
  assert.equal(await upgradeSelfCore({ ...options }, f.deps), true);
  assert.equal(f.calls.downloads, 0);
  assert.equal(f.calls.handoff.length, 1);
  const [handoff] = f.calls.handoff;
  assert.equal(handoff.schemaVersion, 1);
  assert.equal(handoff.fromVersion, VERSION);
  assert.equal(handoff.installedRoot, f.installedRoot);
  assert.equal(handoff.zylosDir, f.zylosDir);
  assert.notEqual(handoff.tempDir, f.installedRoot);
  assert.equal(handoff.packageJson, fs.readFileSync(path.join(f.installedRoot, 'package.json'), 'utf8'));
  assert.equal(handoff.hasNodeModules, false);
  assert.equal(handoff.schema, true);
  // Deciding and preparing the handoff changes no data; the transaction snapshots first.
  assert.deepEqual(handoff.databases, before);
  assert.deepEqual(f.bytes(), before);
  noTransaction(f);
  assert.equal(fs.existsSync(handoff.tempDir), false, 'the package copy is removed after the transaction');
  assert.deepEqual(f.calls.prompts, ['Migrate them now (services stop during the migration)? [y/N]: ']);
  assert.ok(f.logs.some(line => /zylos-core.* is up to date \(v1\.0\.0\); these databases need migration:/.test(line)), f.logs.join('\n'));
  assert.ok(f.logs.includes(`  comm-bridge/c4.db: 1 → ${c4Schema.SUPPORTED_SCHEMA_VERSION}`), f.logs.join('\n'));
  assert.ok(f.logs.includes(`  scheduler/scheduler.db: 1 → ${schedulerSchema.SUPPORTED_SCHEMA_VERSION}`), f.logs.join('\n'));
  assert.deepEqual(f.errors, []);
});

test('declining the same-version migration changes nothing', async t => {
  const f = fixture(t);
  f.create('scheduler/scheduler.db', 'scheduler-v0.9.0-v1.sql');
  const before = f.bytes();
  f.deps.promptYesNo = async () => false;
  assert.equal(await upgradeSelfCore({}, f.deps), true);
  assert.equal(f.calls.handoff.length, 0);
  assert.ok(f.logs.includes('Upgrade cancelled.'));
  assert.deepEqual(f.bytes(), before);
  noTransaction(f);
});

for (const state of ['current', 'missing']) test(`already current Core with ${state} databases still reports up to date without a transaction`, async t => {
  const f = fixture(t);
  if (state === 'current') {
    f.create('comm-bridge/c4.db', 'c4-v0.9.0-v1.sql');
    f.create('scheduler/scheduler.db', 'scheduler-v0.9.0-v1.sql');
    migrateTo(f.file('comm-bridge/c4.db'), c4Schema);
    migrateTo(f.file('scheduler/scheduler.db'), schedulerSchema);
  }
  const before = f.bytes();
  for (const explicit of [false, true]) {
    f.logs.length = 0;
    assert.equal(await upgradeSelfCore(explicit ? { version: VERSION } : {}, f.deps), true);
    assert.deepEqual(f.logs, [explicit ? `zylos-core is already at version ${VERSION} (SemVer precedence).` : `zylos-core is up to date (v${VERSION})`]);
  }
  assert.equal(f.calls.handoff.length, 0);
  assert.equal(f.calls.downloads, 0);
  assert.deepEqual(f.calls.prompts, []);
  assert.deepEqual(f.bytes(), before);
  if (state === 'missing') assert.deepEqual(fs.readdirSync(f.zylosDir), ['.claude']);
  noTransaction(f);
});

test('a database newer than the installed code fails the check instead of reporting up to date', async t => {
  const f = fixture(t);
  f.create('comm-bridge/c4.db', 'c4-v0.9.0-v1.sql');
  migrateTo(f.file('comm-bridge/c4.db'), c4Schema);
  const db = new Database(f.file('comm-bridge/c4.db'));
  db.pragma(`user_version = ${c4Schema.SUPPORTED_SCHEMA_VERSION + 1}`); db.close();
  const before = f.bytes();
  for (const jsonOutput of [false, true]) {
    f.logs.length = 0; f.errors.length = 0;
    assert.equal(await upgradeSelfCore({ jsonOutput }, f.deps), false);
    if (jsonOutput) {
      const [reply] = f.logs.map(line => JSON.parse(line));
      assert.equal(reply.success, false);
      assert.equal(reply.code, 'SCHEMA_TOO_NEW');
      assert.match(reply.error, /exceeds supported/);
    } else {
      assert.match(f.errors[0], /^Error: Database version check failed: .*exceeds supported/);
      assert.equal(f.logs.some(line => /up to date/.test(line)), false);
    }
  }
  assert.equal(f.calls.handoff.length, 0);
  assert.deepEqual(f.bytes(), before);
  noTransaction(f);
});
