import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectDashboardRegistrationCleanup, cleanupDashboardRegistration } from '../dashboard-registration-cleanup.js';
import { assertDashboardUninstalled as assertFinalizerDashboardUninstalled } from '../self-upgrade.js';
import { assertDashboardUninstalled } from '../core-db-backup.js';
import { uninstallComponent } from '../../commands/component.js';

const isolation = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
const admissionGuards = [assertDashboardUninstalled, assertFinalizerDashboardUninstalled];
const isolationRoot = path.dirname(isolation.TMPDIR || '');
assert.match(path.basename(isolationRoot), /^zylos-tests-/);
for (const value of Object.values(isolation)) assert.ok(value && value.startsWith(isolationRoot + path.sep), 'Dashboard cleanup tests require the official isolated runner');
console.log('Dashboard cleanup isolation:', JSON.stringify({ ...isolation, resources: 'file-only fixtures; no service, socket, database open or network' }));

function fixture(t, { wrapped = false, dashboard = true, record } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-cleanup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'deployment');
  const deployedCode = path.join(zylosDir, '.claude/skills/dashboard');
  const dataDir = path.join(zylosDir, 'components/dashboard');
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  write(path.join(deployedCode, 'src/index.js'), 'retained Core Dashboard code\n');
  write(path.join(dataDir, 'config.json'), '{"retained":true}\n');
  for (const suffix of ['', '-wal', '-shm']) write(path.join(dataDir, 'dashboard.db' + suffix), 'opaque database sentinel ' + suffix + '\n');
  write(path.join(zylosDir, 'pm2/ecosystem.config.cjs'), '// Core ecosystem; retained\n');
  write(path.join(zylosDir, 'pm2/dump.pm2'), '[{"name":"zylos-dashboard"}]\n');
  write(path.join(zylosDir, 'http/Caddyfile'), '# Dashboard route; retained\n');
  write(path.join(zylosDir, '.claude/settings.json'), '{"hooks":{"Stop":[]}}\n');
  write(path.join(zylosDir, 'bin/dashboard-tool'), 'retained tool\n');
  const registryFile = path.join(zylosDir, '.zylos/components.json');
  const components = { telegram: { version: '1.2.3' } };
  // The standalone installer uses this same skill/data directory as Core.
  if (dashboard) components.dashboard = record === undefined ? {
    version: '0.5.5', repo: 'zylos-ai/zylos-dashboard', type: 'declarative', isThirdParty: false,
    installedAt: '2026-11-01T00:00:00.000Z', skillDir: deployedCode, dataDir, source: 'registry',
  } : record;
  write(registryFile, JSON.stringify(wrapped ? { metadata: { retained: true }, components } : components, null, 2) + '\n');
  t.diagnostic(JSON.stringify({ root, zylosDir, deployedCode, registryFile, mode: 'private files only; no PM2 or database opens' }));
  return { root, zylosDir, deployedCode, registryFile };
}

function retainedDigest(f) {
  const records = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(records.length < 100, 'fixture tree stays bounded');
      const file = path.join(directory, entry.name);
      if (file === f.registryFile) continue;
      if (entry.isDirectory()) { records.push([path.relative(f.root, file), 'directory']); walk(file); }
      else if (entry.isSymbolicLink()) records.push([path.relative(f.root, file), 'symlink', fs.readlinkSync(file)]);
      else records.push([path.relative(f.root, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  }
  walk(f.root);
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}
function registry(f) {
  const value = JSON.parse(fs.readFileSync(f.registryFile, 'utf8'));
  return value.components || value;
}

// File-only cleanup plus real admission guards. Run for registration semantics;
// skip unrelated Dashboard UI. Official runner isolates all four runtime paths.
for (const wrapped of [false, true]) test(`residual ${wrapped ? 'wrapped' : 'flat'} registration is removed while shared Core files and all data remain`, t => {
  const f = fixture(t, { wrapped }), before = retainedDigest(f);
  for (const guard of admissionGuards) assert.throws(() => guard(f.zylosDir), { code: 'DASHBOARD_STILL_INSTALLED' });
  const result = cleanupDashboardRegistration(f);
  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(registry(f), 'dashboard'), false);
  assert.equal(registry(f).telegram.version, '1.2.3');
  if (wrapped) assert.equal(JSON.parse(fs.readFileSync(f.registryFile, 'utf8')).metadata.retained, true);
  assert.equal(retainedDigest(f), before);
  for (const guard of admissionGuards) assert.doesNotThrow(() => guard(f.zylosDir));
});

test('cleanup preview does not change registration, shared Core code or data', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  assert.equal(inspectDashboardRegistrationCleanup(f).success, true);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes);
  assert.equal(retainedDigest(f), before);
});

for (const record of [null, false, {}]) test(`own dashboard property is removable regardless of its value: ${JSON.stringify(record)}`, t => {
  const f = fixture(t, { record });
  assert.equal(cleanupDashboardRegistration(f).success, true);
  for (const guard of admissionGuards) assert.doesNotThrow(() => guard(f.zylosDir));
});

for (const inspectOnly of [true, false]) test(`without residual registration ${inspectOnly ? 'preview' : 'cleanup'} refuses Core-managed Dashboard`, t => {
  const f = fixture(t, { dashboard: false }), bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  const result = (inspectOnly ? inspectDashboardRegistrationCleanup : cleanupDashboardRegistration)(f);
  assert.equal(result.success, false); assert.equal(result.error, 'core_managed');
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes); assert.equal(retainedDigest(f), before);
});

test('missing components.json returns core_managed without creating registration', t => {
  const f = fixture(t); fs.unlinkSync(f.registryFile);
  const before = retainedDigest(f);
  for (const operation of [inspectDashboardRegistrationCleanup, cleanupDashboardRegistration]) {
    const result = operation(f);
    assert.equal(result.success, false); assert.equal(result.error, 'core_managed');
  }
  assert.equal(fs.existsSync(f.registryFile), false); assert.equal(retainedDigest(f), before);
});

for (const mode of [0o600, 0o640]) test(`atomic registration replacement preserves file permissions ${mode.toString(8)}`, t => {
  const f = fixture(t); fs.chmodSync(f.registryFile, mode);
  const previousUmask = process.umask(0o077);
  try { assert.equal(cleanupDashboardRegistration(f).success, true); }
  finally { process.umask(previousUmask); }
  assert.equal(fs.statSync(f.registryFile).mode & 0o777, mode);
  assert.deepEqual(fs.readdirSync(path.dirname(f.registryFile)), ['components.json']);
});

for (const shape of [null, [], 'invalid', 42, { components: [] }, { components: 'invalid' }]) test(`invalid registry structure fails safely: ${JSON.stringify(shape)}`, t => {
  const f = fixture(t); fs.writeFileSync(f.registryFile, JSON.stringify(shape));
  const bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  assert.equal(cleanupDashboardRegistration(f).success, false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes); assert.equal(retainedDigest(f), before);
});

test('malformed registry fails without exposing private content or modifying resources', t => {
  const f = fixture(t), privateMarker = crypto.randomUUID();
  fs.writeFileSync(f.registryFile, '{"private":"' + privateMarker);
  const bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  const result = cleanupDashboardRegistration(f);
  assert.equal(result.success, false); assert.equal(result.error, 'dashboard_cleanup_failed');
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes); assert.equal(retainedDigest(f), before);
});

for (const metadata of [null, false, 0, '']) test(`falsey components metadata preserves flat registry semantics: ${JSON.stringify(metadata)}`, t => {
  const f = fixture(t), entries = registry(f); entries.components = metadata;
  fs.writeFileSync(f.registryFile, JSON.stringify(entries));
  assert.equal(cleanupDashboardRegistration(f).success, true);
  const value = JSON.parse(fs.readFileSync(f.registryFile, 'utf8'));
  assert.equal(value.components, metadata); assert.equal(value.telegram.version, '1.2.3');
  for (const guard of admissionGuards) assert.doesNotThrow(() => guard(f.zylosDir));
});

// Actual command dispatcher with real cleanup helper; only the confirmation
// answer and console are injected. Run for uninstall routing/flag changes.
for (const mode of ['cleanup', 'preview', 'purge', 'missing registration', 'cancelled', 'confirmed']) test(`Dashboard uninstall dispatcher handles ${mode}`, async t => {
  const f = fixture(t, { dashboard: mode !== 'missing registration' });
  const bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f), output = [];
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  t.mock.method(console, 'log', value => output.push(String(value)));
  t.mock.method(console, 'error', () => {});
  let prompts = 0;
  const args = ['dashboard', '--json'];
  if (mode === 'preview') args.push('--check');
  else if (mode === 'purge') args.push('--purge', '--force', '--yes');
  else if (!['cancelled', 'confirmed'].includes(mode)) args.push('--yes');
  const result = await uninstallComponent(args, { zylosDir: f.zylosDir, promptYesNo: async question => {
    prompts++; assert.match(question, /\[y\/N\]/); return mode === 'confirmed';
  } });
  assert.equal(output.length, 1);
  const json = JSON.parse(output[0]);
  assert.equal(json.component, 'dashboard'); assert.equal(json.action, mode === 'preview' ? 'uninstall_check' : 'uninstall');
  assert.equal(json.success, result.success);
  if (['cleanup', 'confirmed'].includes(mode)) {
    assert.equal(result.success, true);
    for (const guard of admissionGuards) assert.doesNotThrow(() => guard(f.zylosDir));
    assert.match(result.message, /zylos upgrade --self/);
  } else {
    assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes);
    if (mode === 'preview') assert.equal(result.success, true);
    else {
      assert.equal(result.error, { purge: 'purge_not_supported', 'missing registration': 'core_managed', cancelled: 'cancelled' }[mode]);
      assert.equal(process.exitCode, 1);
    }
  }
  assert.equal(prompts, ['cancelled', 'confirmed'].includes(mode) ? 1 : 0);
  assert.equal(retainedDigest(f), before);
});
