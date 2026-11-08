import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectUpgradePrerequisites } from '../upgrade-prerequisites.js';
import { handleSelfCheckOnly } from '../../commands/component.js';

const isolation = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
const isolationRoot = path.dirname(isolation.TMPDIR || '');
assert.match(path.basename(isolationRoot), /^zylos-tests-/);
for (const value of Object.values(isolation)) assert.ok(value && value.startsWith(isolationRoot + path.sep), 'upgrade checks require the official isolated runner');
console.log('Upgrade check isolation:', JSON.stringify({ ...isolation, resources: 'file-only metadata; no database opens, service, tmux or network operations' }));

function fixture(t, { dashboard = true, flat = false, targetVersion = '1.0.0-beta.1' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-check-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installedRoot = path.join(root, 'prefix/lib/node_modules/zylos');
  const targetRoot = path.join(root, 'target');
  const zylosDir = path.join(root, 'deployment');
  for (const [directory, version] of [[installedRoot, '0.9.5'], [targetRoot, targetVersion]]) {
    fs.mkdirSync(path.join(directory, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'zylos', type: 'module', version, bin: { zylos: './cli/zylos.js' } }));
    fs.writeFileSync(path.join(directory, 'cli/zylos.js'), '#!/usr/bin/env node\n');
  }
  const bin = path.join(root, 'prefix/bin'); fs.mkdirSync(bin);
  fs.symlinkSync(path.join(installedRoot, 'cli/zylos.js'), path.join(bin, 'zylos'));
  if (targetVersion.startsWith('1.')) {
    fs.mkdirSync(path.join(targetRoot, 'skills/dashboard'), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, 'cli/lib'), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'cli/lib/upgrade-entry.js'), '// isolated target metadata sentinel; never executed\n');
  }
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  const components = dashboard ? { dashboard: { version: '0.1.0' } } : {};
  fs.writeFileSync(path.join(zylosDir, '.zylos/components.json'), JSON.stringify(flat ? components : { components }));
  for (const relative of ['components/dashboard/dashboard.db', 'comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db']) {
    const file = path.join(zylosDir, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'opaque isolated database sentinel; must never be opened\n');
  }
  fs.writeFileSync(path.join(zylosDir, 'components/dashboard/config.json'), '{"retained":true}\n');
  for (const value of [installedRoot, targetRoot, zylosDir]) assert.ok(fs.realpathSync(value).startsWith(root + path.sep));
  t.diagnostic(JSON.stringify({ root, installedRoot, targetRoot, zylosDir, mode: 'read-only metadata fixture' }));
  return { root, installedRoot, targetRoot, zylosDir, fromVersion: '0.9.5', targetVersion };
}

function snapshot(root) {
  const records = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(records.length < 100, 'fixture tree must stay bounded');
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) records.push([relative, 'link', fs.readlinkSync(file)]);
      else if (stat.isDirectory()) { records.push([relative, 'directory']); walk(file); }
      else records.push([relative, 'file', stat.mode, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  }
  walk(root);
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function dashboardItem(items) { return items.find(item => item.code === 'DASHBOARD_STILL_INSTALLED'); }
function assertDashboardItem(item) {
  assert.ok(item, 'standalone Dashboard must be listed before upgrading');
  assert.equal(item.code, 'DASHBOARD_STILL_INSTALLED');
  assert.match(item.message, /1\.0/);
  assert.match(item.message, /built.in|bundled|includes Dashboard/i);
  assert.match(item.message, /data.*retain|retain.*data/i);
  assert.match(item.next, /zylos uninstall dashboard --yes/);
}

// File-only prerequisite unit boundary. Run when check admission or component
// registry compatibility changes; skip for service/finalization-only changes.
for (const flat of [false, true]) test(`standalone Dashboard in a ${flat ? 'flat' : 'nested'} registry is reported without mutating deployment data`, t => {
  const f = fixture(t, { flat }), before = snapshot(f.root);
  const items = collectUpgradePrerequisites(f);
  assertDashboardItem(dashboardItem(items));
  assert.equal(snapshot(f.root), before);
  assert.equal(fs.existsSync(path.join(f.zylosDir, '.backup')), false);
});

test('retained Dashboard data without a standalone component registration needs no uninstall', t => {
  const f = fixture(t, { dashboard: false }), before = snapshot(f.root);
  assert.equal(dashboardItem(collectUpgradePrerequisites(f)), undefined);
  assert.equal(snapshot(f.root), before);
});

test('a target without bundled Dashboard does not inherit the bundled-core uninstall prerequisite', t => {
  const f = fixture(t, { targetVersion: '0.9.6' }), before = snapshot(f.root);
  assert.equal(dashboardItem(collectUpgradePrerequisites(f)), undefined);
  assert.equal(snapshot(f.root), before);
});

function runCheck(f, options = {}, { hasUpdate = true, downloadFailure } = {}) {
  const calls = [], lines = [], errors = [];
  handleSelfCheckOnly(options, {
    zylosDir: f.zylosDir,
    installedRoot: f.installedRoot,
    console: { log: value => lines.push(String(value)), error: value => errors.push(String(value)) },
    checkForCoreUpdates: input => {
      calls.push(['check', input]);
      return { success: true, hasUpdate, current: f.fromVersion, latest: hasUpdate ? f.targetVersion : f.fromVersion };
    },
    downloadCoreToTemp: (version, branch) => {
      calls.push(['download', version, branch]);
      if (downloadFailure?.throws) throw new Error(downloadFailure.message);
      if (downloadFailure) return { success: false, error: downloadFailure.message };
      return { success: true, tempDir: f.targetRoot };
    },
    fetchRawFile: () => { calls.push(['remote-changelog']); throw new Error('isolated changelog unavailable'); },
    readCoreChangelog: directory => { calls.push(['changelog', directory]); return ''; },
    detectCoreSkillChanges: () => { calls.push(['changes']); return []; },
    cleanupCoreTemp: directory => { calls.push(['cleanup', directory]); },
  });
  assert.deepEqual(errors, []);
  return { calls, text: lines.join('\n') };
}

// Cross-module check command + real file-only collector. Discovery/download,
// changelog and output are injected; no network, database, tmux or service API
// is invoked. Official runner isolates all roots. Run for check/collector wiring
// and presentation changes; skip for installation/finalization-only changes.
for (const branch of [undefined, 'multi-session/prerelease']) for (const dashboard of [false, true]) test(`${branch ? 'branch' : 'release'} JSON check ${dashboard ? 'reports' : 'omits'} standalone Dashboard while preserving successful update discovery`, t => {
  const f = fixture(t, { dashboard }), before = snapshot(f.root);
  const result = runCheck(f, { jsonOutput: true, branch, beta: true });
  const data = JSON.parse(result.text);
  assert.equal(data.success, true); assert.equal(data.hasUpdate, true);
  assert.equal(data.action, 'check'); assert.equal(data.target, 'zylos-core');
  assert.equal(data.current, '0.9.5'); assert.equal(data.latest, f.targetVersion);
  assert.ok(Array.isArray(data.prerequisites));
  if (dashboard) {
    assertDashboardItem(dashboardItem(data.prerequisites));
    assert.match(data.reply, /DASHBOARD_STILL_INSTALLED/); assert.match(data.reply, /zylos uninstall dashboard --yes/);
  } else assert.equal(dashboardItem(data.prerequisites), undefined);
  assert.deepEqual(result.calls.find(call => call[0] === 'check')[1], { branch, beta: true, version: undefined });
  assert.deepEqual(result.calls.find(call => call[0] === 'download').slice(1), [f.targetVersion, branch]);
  assert.deepEqual(result.calls.at(-1), ['cleanup', f.targetRoot]);
  assert.equal(snapshot(f.root), before);
});

for (const dashboard of [false, true]) test(`text check ${dashboard ? 'explains bundled Dashboard and retained data' : 'does not ask to uninstall a missing standalone Dashboard'}`, t => {
  const f = fixture(t, { dashboard }), before = snapshot(f.root);
  const { text } = runCheck(f, { branch: 'multi-session/prerelease' });
  if (dashboard) {
    assert.match(text, /DASHBOARD_STILL_INSTALLED/); assert.match(text, /1\.0/); assert.match(text, /built.in|bundled|includes Dashboard/i);
    assert.match(text, /data.*retain|retain.*data/i); assert.match(text, /zylos uninstall dashboard --yes/);
  } else assert.doesNotMatch(text, /DASHBOARD_STILL_INSTALLED|zylos uninstall dashboard/);
  assert.equal(snapshot(f.root), before);
});

test('legacy target check stays successful without a bundled Dashboard prerequisite', t => {
  const f = fixture(t, { targetVersion: '0.9.6' }), before = snapshot(f.root);
  const data = JSON.parse(runCheck(f, { jsonOutput: true }).text);
  assert.equal(data.success, true); assert.equal(data.hasUpdate, true);
  assert.equal(dashboardItem(data.prerequisites), undefined);
  assert.equal(snapshot(f.root), before);
});

for (const jsonOutput of [false, true]) test(`explicit version ${jsonOutput ? 'JSON' : 'text'} check preserves tag-only discovery without downloading target policy`, t => {
  const f = fixture(t), before = snapshot(f.root);
  const { calls, text } = runCheck(f, { jsonOutput, version: f.targetVersion });
  assert.deepEqual(calls.map(call => call[0]), ['check']);
  assert.equal(calls[0][1].version, f.targetVersion);
  if (jsonOutput) {
    const data = JSON.parse(text);
    assert.equal(data.success, true); assert.equal(data.hasUpdate, true); assert.ok(Array.isArray(data.prerequisites));
    assert.equal(dashboardItem(data.prerequisites), undefined);
  }
  assert.match(text, /tag/i); assert.match(text, /target.*entry|target.*accept|starting.*version/i);
  assert.equal(snapshot(f.root), before);
});

test('no-update check keeps hasUpdate false and does not download or inspect target policy', t => {
  const f = fixture(t), before = snapshot(f.root);
  const { calls, text } = runCheck(f, { jsonOutput: true }, { hasUpdate: false });
  const data = JSON.parse(text);
  assert.equal(data.success, true); assert.equal(data.hasUpdate, false);
  assert.deepEqual(data.prerequisites, []);
  assert.equal(calls.filter(call => ['download', 'changes', 'changelog'].includes(call[0])).length, 0);
  assert.equal(snapshot(f.root), before);
});

for (const kind of ['missing deployment', 'unsupported source version', 'global bin layout', 'core dependency path', 'snapshot destination', 'Dashboard takeover path', 'unfinished recovery']) test(`read-only check reports the ${kind} prerequisite using the existing admission code`, t => {
  const f = fixture(t, { dashboard: false });
  let code, expected;
  if (kind === 'missing deployment') {
    f.zylosDir = path.join(f.root, 'missing'); code = 'ZYLOS_NOT_INITIALIZED'; expected = /zylos init/;
  } else if (kind === 'unsupported source version') {
    f.fromVersion = '0.9.2'; code = 'UPGRADE_SOURCE_TOO_OLD'; expected = /0\.9\.3|upgrade/;
  } else if (kind === 'global bin layout') {
    const bin = path.join(f.root, 'prefix/bin/zylos'); fs.unlinkSync(bin); fs.writeFileSync(bin, 'ordinary shell shim\n');
    code = 'UNSUPPORTED_INSTALL_LAYOUT'; expected = /global npm/;
  } else if (kind === 'core dependency path') {
    const directory = path.join(f.zylosDir, '.claude/skills/dashboard'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'node_modules'), 'invalid dependency file\n');
    code = 'INVALID_CORE_DEPENDENCIES'; expected = /dependenc/;
  } else if (kind === 'snapshot destination') {
    fs.writeFileSync(path.join(f.zylosDir, '.backup'), 'not a directory\n');
    code = 'UPGRADE_FAILED'; expected = /backup destination/;
  } else if (kind === 'Dashboard takeover path') {
    fs.mkdirSync(path.join(f.installedRoot, 'skills')); fs.writeFileSync(path.join(f.installedRoot, 'skills/dashboard'), 'not a directory\n');
    code = 'DASHBOARD_TAKEOVER_INVALID'; expected = /Dashboard directory/;
  } else {
    const directory = path.join(f.zylosDir, '.zylos/upgrade'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'active.json'), '{unreadable marker');
    code = 'UPGRADE_RECOVERY_REQUIRED'; expected = /zylos recovery/;
  }
  const before = snapshot(f.root), items = collectUpgradePrerequisites(f);
  const item = items.find(value => value.code === code);
  assert.ok(item, 'deterministic admission blocker should be listed'); assert.match(item.next, expected);
  assert.equal(snapshot(f.root), before);
});

test('a forced branch check reports prerequisites without changing a false hasUpdate value', t => {
  const f = fixture(t), before = snapshot(f.root);
  const data = JSON.parse(runCheck(f, { jsonOutput: true, branch: 'multi-session/prerelease' }, { hasUpdate: false }).text);
  assert.equal(data.success, true); assert.equal(data.hasUpdate, false); assertDashboardItem(dashboardItem(data.prerequisites));
  assert.equal(snapshot(f.root), before);
});

test('up-to-date checks skip even a missing deployment instead of collecting upgrade prerequisites', t => {
  const f = fixture(t); f.zylosDir = path.join(f.root, 'missing'); const before = snapshot(f.root);
  const data = JSON.parse(runCheck(f, { jsonOutput: true }, { hasUpdate: false }).text);
  assert.equal(data.success, true); assert.equal(data.hasUpdate, false); assert.deepEqual(data.prerequisites, []);
  assert.equal(snapshot(f.root), before);
});

test('an unreadable component registry reports uncertainty without exposing its raw contents', t => {
  const f = fixture(t), privateMarker = crypto.randomUUID();
  fs.writeFileSync(path.join(f.zylosDir, '.zylos/components.json'), '{"private":"' + privateMarker);
  const before = snapshot(f.root), items = collectUpgradePrerequisites(f);
  const item = items.find(value => value.code === 'UPGRADE_FAILED');
  assert.ok(item); assert.equal(item.message, 'Could not inspect the installed component registry.');
  assert.match(item.next, /registry/);
  assert.equal(JSON.stringify(items).includes(privateMarker), false);
  for (const jsonOutput of [true, false]) {
    const { text } = runCheck(f, { jsonOutput });
    assert.match(text, /UPGRADE_FAILED/); assert.match(text, /Could not inspect the installed component registry/);
    assert.equal(text.includes(privateMarker), false);
    if (jsonOutput) { const data = JSON.parse(text); assert.equal(data.success, true); assert.equal(data.hasUpdate, true); }
  }
  assert.equal(snapshot(f.root), before);
});

for (const kind of ['missing metadata', 'malformed metadata', 'wrong package identity', 'Dashboard file']) test(`a downloaded target with ${kind} reports uncertainty instead of a clean prerequisite result`, t => {
  const f = fixture(t), privateMarker = crypto.randomUUID();
  const metadata = path.join(f.targetRoot, 'package.json');
  if (kind === 'missing metadata') fs.unlinkSync(metadata);
  else if (kind === 'malformed metadata') fs.writeFileSync(metadata, '{"private":"' + privateMarker);
  else if (kind === 'wrong package identity') fs.writeFileSync(metadata, JSON.stringify({ name: privateMarker, version: f.targetVersion }));
  else {
    const directory = path.join(f.targetRoot, 'skills/dashboard'); fs.rmdirSync(directory);
    fs.writeFileSync(directory, 'invalid Dashboard target file ' + privateMarker);
  }
  const before = snapshot(f.root), items = collectUpgradePrerequisites(f);
  const item = items.find(value => value.code === 'UPGRADE_FAILED');
  assert.ok(item, 'incomplete or invalid downloaded target must not appear fully checked');
  assert.equal(item.message, kind === 'Dashboard file' ? 'Could not inspect the target Dashboard directory.' : 'Could not inspect the downloaded target package.');
  assert.match(item.next, /readable target package/); assert.equal(JSON.stringify(items).includes(privateMarker), false);
  const { text } = runCheck(f, { jsonOutput: true }); const data = JSON.parse(text);
  assert.equal(data.success, true); assert.equal(data.hasUpdate, true);
  assert.ok(data.prerequisites.some(value => value.code === 'UPGRADE_FAILED'));
  assert.equal(text.includes(privateMarker), false); assert.equal(snapshot(f.root), before);
});


for (const jsonOutput of [true, false]) test(`failed target download keeps ${jsonOutput ? 'JSON' : 'text'} check successful while explicitly marking prerequisite inspection incomplete`, t => {
  const f = fixture(t), before = snapshot(f.root), privateMarker = crypto.randomUUID();
  const { text, calls } = runCheck(f, { jsonOutput, branch: 'multi-session/prerelease' }, {
    downloadFailure: { throws: !jsonOutput, message: 'private transport detail ' + privateMarker },
  });
  assert.match(text, /UPGRADE_FAILED/);
  assert.match(text, /Target-specific upgrade prerequisites could not be inspected because the target download failed/);
  assert.match(text, /Retry this upgrade check when the target package can be downloaded/);
  assert.equal(text.includes(privateMarker), false);
  if (jsonOutput) {
    const data = JSON.parse(text);
    assert.equal(data.success, true); assert.equal(data.hasUpdate, true);
    assert.ok(data.prerequisites.some(item => item.code === 'UPGRADE_FAILED'));
    assert.equal(dashboardItem(data.prerequisites), undefined);
  }
  assert.equal(calls.filter(call => call[0] === 'remote-changelog').length, 2);
  assert.equal(calls.filter(call => call[0] === 'changelog').length, 0);
  assert.equal(snapshot(f.root), before);
});
