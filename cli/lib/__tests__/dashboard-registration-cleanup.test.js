import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectDashboardRegistrationCleanup, cleanupDashboardRegistration } from '../dashboard-registration-cleanup.js';
import { assertDashboardUninstalled } from '../core-db-backup.js';
import { uninstallComponent } from '../../commands/component.js';

const isolation = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
const isolationRoot = path.dirname(isolation.TMPDIR || '');
assert.match(path.basename(isolationRoot), /^zylos-tests-/);
for (const value of Object.values(isolation)) assert.ok(value && value.startsWith(isolationRoot + path.sep), 'Dashboard cleanup tests require the official isolated runner');
console.log('Dashboard cleanup isolation:', JSON.stringify({ ...isolation, resources: 'file-only fixtures and injected PM2; no service, socket, database open or network' }));

function fixture(t, { wrapped = false, dashboard = true, record } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-cleanup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'deployment'), packageRoot = path.join(root, 'package');
  const deployedCode = path.join(zylosDir, '.claude/skills/dashboard'), bundledCode = path.join(packageRoot, 'skills/dashboard');
  const legacyCode = path.join(root, 'standalone-dashboard');
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  for (const directory of [deployedCode, bundledCode, legacyCode]) write(path.join(directory, 'src/index.js'), 'isolated Dashboard code; retained\n');
  write(path.join(zylosDir, 'components/dashboard/config.json'), '{"retained":true}\n');
  for (const suffix of ['', '-wal', '-shm']) write(path.join(zylosDir, 'components/dashboard/dashboard.db' + suffix), 'opaque database sentinel ' + suffix + '\n');
  write(path.join(zylosDir, 'pm2/ecosystem.config.cjs'), '// Core ecosystem; never removed or regenerated\n');
  write(path.join(zylosDir, 'http/Caddyfile'), '# managed Dashboard route; retained\n');
  write(path.join(zylosDir, '.claude/settings.json'), '{"hooks":{"Stop":[]},"statusLine":{"command":"core"}}\n');
  write(path.join(zylosDir, 'bin/dashboard-tool'), 'preserved Core tool\n');
  const registryFile = path.join(zylosDir, '.zylos/components.json');
  const components = { telegram: { version: '1.2.3' } };
  if (dashboard) components.dashboard = record === undefined ? { version: '0.1.0', skillDir: legacyCode, bin: { 'dashboard-tool': 'scripts/tool.js' } } : record;
  write(registryFile, JSON.stringify(wrapped ? { metadata: { retained: true }, components } : components, null, 2) + '\n');
  t.diagnostic(JSON.stringify({ root, zylosDir, packageRoot, legacyCode, registryFile, mode: 'private files; PM2 calls injected' }));
  return { root, zylosDir, packageRoot, deployedCode, bundledCode, legacyCode, registryFile };
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
function processEntry(id, cwd, script = path.join(cwd, 'src/index.js'), name = 'zylos-dashboard') {
  return { pm_id: id, name, pm2_env: { pm_cwd: cwd, pm_exec_path: script, status: 'online' } };
}
function pm2Fixture(entries = [], failure) {
  const calls = [], removed = [];
  const pm2 = (action, args) => {
    calls.push([action, args]);
    if (action === failure) throw new Error('isolated PM2 operation failure');
    if (action === 'jlist') return JSON.stringify(entries.filter(entry => !removed.includes(String(entry.pm_id))));
    if (action === 'delete') removed.push(args[0]);
    return '';
  };
  return { calls, removed, pm2 };
}

// Real cleanup and registry guard; only PM2 transport is injected. Run for
// residual registration/PM2 identity changes, skip unrelated Dashboard UI work.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no real PM2 or DB opens.
for (const wrapped of [false, true]) test(`residual ${wrapped ? 'wrapped' : 'flat'} Dashboard registration is removed while Core code, services and all data remain`, t => {
  const f = fixture(t, { wrapped }), before = retainedDigest(f);
  assert.throws(() => assertDashboardUninstalled(f.zylosDir), { code: 'DASHBOARD_STILL_INSTALLED' });
  const core = processEntry(10, f.deployedCode), bundled = processEntry(11, f.bundledCode);
  const legacy = processEntry(20, f.legacyCode), unrelated = processEntry(30, path.join(f.root, 'unrelated'), undefined, 'unrelated-service');
  const service = pm2Fixture([core, bundled, legacy, unrelated]);
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(registry(f), 'dashboard'), false); assert.equal(registry(f).telegram.version, '1.2.3');
  if (wrapped) assert.equal(JSON.parse(fs.readFileSync(f.registryFile, 'utf8')).metadata.retained, true);
  assert.deepEqual(service.removed, ['20']);
  assert.equal(service.calls.filter(([action]) => action === 'save').length, 1);
  assert.equal(service.calls.some(([action]) => action === 'stop'), false);
  assert.equal(retainedDigest(f), before); assert.doesNotThrow(() => assertDashboardUninstalled(f.zylosDir));
});

test('cleanup preview is read-only even when a separately located legacy service is eligible', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  const service = pm2Fixture([processEntry(20, f.legacyCode)]);
  inspectDashboardRegistrationCleanup(f, { pm2: service.pm2 });
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes); assert.equal(retainedDigest(f), before);
  assert.equal(service.calls.filter(([action]) => action !== 'jlist').length, 0);
});

for (const record of [null, {}, { version: '0.1.0' }]) test(`a present residual registration ${record === null ? 'with a null value' : Object.hasOwn(record, 'version') ? 'without installation paths' : 'with empty metadata'} is removable without guessing service ownership`, t => {
  const f = fixture(t, { record }), before = retainedDigest(f);
  const service = pm2Fixture([processEntry(10, f.deployedCode)]);
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, true); assert.equal(Object.hasOwn(registry(f), 'dashboard'), false);
  assert.deepEqual(service.removed, []); assert.equal(retainedDigest(f), before);
  assert.doesNotThrow(() => assertDashboardUninstalled(f.zylosDir));
});

for (const identity of ['shared Core location', 'Core script with legacy cwd', 'Core cwd with legacy script', 'unrelated service name', 'script outside recorded directory', 'missing process metadata', 'non-numeric PM2 id']) test(`uncertain or Core-owned service identity is preserved: ${identity}`, t => {
  const f = fixture(t), before = retainedDigest(f);
  let entry;
  if (identity === 'shared Core location') {
    const components = registry(f); components.dashboard.skillDir = f.deployedCode;
    fs.writeFileSync(f.registryFile, JSON.stringify(components)); entry = processEntry(10, f.deployedCode);
  } else if (identity === 'Core script with legacy cwd') entry = processEntry(10, f.legacyCode, path.join(f.bundledCode, 'src/index.js'));
  else if (identity === 'Core cwd with legacy script') entry = processEntry(10, f.bundledCode, path.join(f.legacyCode, 'src/index.js'));
  else if (identity === 'unrelated service name') entry = processEntry(10, f.legacyCode, undefined, 'unrelated-service');
  else if (identity === 'script outside recorded directory') entry = processEntry(10, f.legacyCode, path.join(f.legacyCode + '-other', 'src/index.js'));
  else if (identity === 'missing process metadata') entry = { name: 'zylos-dashboard', pm_id: 10 };
  else entry = processEntry('10', f.legacyCode);
  const service = pm2Fixture([entry]);
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, true); assert.equal(Object.hasOwn(registry(f), 'dashboard'), false);
  assert.deepEqual(service.removed, []); assert.equal(retainedDigest(f), before);
});

for (const failure of ['jlist', 'delete', 'save']) test(`failed PM2 ${failure} preserves residual registration for a safe retry`, t => {
  const f = fixture(t), bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  const service = pm2Fixture([processEntry(20, f.legacyCode)], failure);
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, false); assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes); assert.equal(retainedDigest(f), before);
  assert.throws(() => assertDashboardUninstalled(f.zylosDir), { code: 'DASHBOARD_STILL_INSTALLED' });
  if (failure === 'jlist') assert.deepEqual(service.removed, []);
});

for (const inspectOnly of [true, false]) test(`without a standalone registration ${inspectOnly ? 'preview' : 'cleanup'} still refuses Core-managed Dashboard`, t => {
  const f = fixture(t, { dashboard: false }), bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  const service = pm2Fixture([processEntry(10, f.deployedCode)]);
  const result = (inspectOnly ? inspectDashboardRegistrationCleanup : cleanupDashboardRegistration)(f, { pm2: service.pm2 });
  assert.equal(result.success, false); assert.equal(result.error, 'core_managed');
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes); assert.equal(retainedDigest(f), before);
  assert.equal(service.calls.length, 0);
});

test('malformed component registration fails without exposing content or changing Core resources', t => {
  const f = fixture(t), privateMarker = crypto.randomUUID();
  fs.writeFileSync(f.registryFile, '{"private":"' + privateMarker);
  const bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f), service = pm2Fixture([]);
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes(privateMarker), false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes); assert.equal(retainedDigest(f), before); assert.equal(service.calls.length, 0);
});


for (const shape of [null, [], 'invalid', 42, { components: [] }, { components: 'invalid' }]) test(`invalid registry structure is rejected: ${JSON.stringify(shape)}`, t => {
  const f = fixture(t), service = pm2Fixture([]);
  fs.writeFileSync(f.registryFile, JSON.stringify(shape));
  const bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes);
  assert.equal(retainedDigest(f), before);
  assert.equal(service.calls.length, 0);
});

for (const alias of ['registered directory', 'executable']) test(`a symlink through the ${alias} cannot identify Core as a removable legacy service`, t => {
  const f = fixture(t);
  let entry;
  if (alias === 'registered directory') {
    const link = path.join(f.root, 'legacy-alias');
    fs.symlinkSync(f.deployedCode, link, 'dir');
    const components = registry(f); components.dashboard.skillDir = link;
    fs.writeFileSync(f.registryFile, JSON.stringify(components));
    entry = processEntry(20, link);
  } else {
    const link = path.join(f.legacyCode, 'core-entry.js');
    fs.symlinkSync(path.join(f.deployedCode, 'src/index.js'), link);
    entry = processEntry(20, f.legacyCode, link);
  }
  const before = retainedDigest(f), service = pm2Fixture([entry]);
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, true);
  assert.equal(service.removed.length, 0);
  assert.equal(retainedDigest(f), before);
});

test('retry after PM2 save failure persists the already-deleted legacy service before clearing its registration', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.registryFile, 'utf8');
  let failSave = true;
  const service = pm2Fixture([processEntry(20, f.legacyCode)]);
  const pm2 = (action, args) => {
    if (action === 'save' && failSave) throw new Error('isolated startup-list failure');
    return service.pm2(action, args);
  };
  assert.equal(cleanupDashboardRegistration(f, { pm2 }).success, false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes);
  assert.deepEqual(service.removed, ['20']);
  failSave = false;
  assert.equal(cleanupDashboardRegistration(f, { pm2 }).success, true);
  assert.equal(service.calls.filter(([action]) => action === 'save').length, 1);
  assert.deepEqual(service.removed, ['20']);
  assert.doesNotThrow(() => assertDashboardUninstalled(f.zylosDir));
});

for (const response of ['not JSON', '{}', 'null']) test(`invalid PM2 process inventory preserves residual registration: ${response}`, t => {
  const f = fixture(t), bytes = fs.readFileSync(f.registryFile, 'utf8'), calls = [];
  const result = cleanupDashboardRegistration(f, { pm2: (action, args) => { calls.push([action, args]); return response; } });
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes);
  assert.equal(calls.some(([action]) => action !== 'jlist'), false);
});

test('active upgrade recovery preserves the saved startup list and residual retry marker', t => {
  const f = fixture(t), stable = path.join(f.zylosDir, '.zylos/upgrade');
  fs.mkdirSync(stable, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stable, 'active.json'), JSON.stringify({ formatVersion: 1, transactionId: 'interrupted', transactionDir: path.join(f.zylosDir, '.backup/self-upgrade/interrupted') }), { mode: 0o600 });
  const bytes = fs.readFileSync(f.registryFile, 'utf8'), service = pm2Fixture([processEntry(20, f.legacyCode)]);
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes);
  assert.equal(service.calls.some(([action]) => action === 'save' || action === 'delete'), false);
});


// Dispatcher exercises actual CLI routing with the real cleanup helper and
// injected PM2 transport. Run when uninstall flags/routing change; skip for UI.
// All HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and fixture paths are isolated; no live PM2.
for (const mode of ['cleanup', 'preview', 'purge', 'missing registration', 'cancelled', 'confirmed']) test(`Dashboard uninstall dispatcher handles ${mode}`, async t => {
  const f = fixture(t, { dashboard: mode !== 'missing registration' });
  const service = pm2Fixture([processEntry(10, f.deployedCode), processEntry(20, f.legacyCode)]);
  const bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f), output = [];
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  t.mock.method(console, 'log', value => output.push(String(value)));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  let prompts = 0;
  const args = ['dashboard', '--json'];
  if (mode === 'preview') args.push('--check');
  else if (mode === 'purge') args.push('--purge', '--force', '--yes');
  else if (!['cancelled', 'confirmed'].includes(mode)) args.push('--yes');
  const result = await uninstallComponent(args, { zylosDir: f.zylosDir, packageRoot: f.packageRoot, pm2: service.pm2, promptYesNo: async () => { prompts++; return mode === 'confirmed'; } });
  assert.equal(output.length, 1);
  const json = JSON.parse(output[0]);
  assert.equal(json.component, 'dashboard');
  assert.equal(json.action, mode === 'preview' ? 'uninstall_check' : 'uninstall');
  assert.equal(json.success, result.success);
  if (['cleanup', 'confirmed'].includes(mode)) {
    assert.equal(result.success, true);
    assert.deepEqual(service.removed, ['20']);
    assert.doesNotThrow(() => assertDashboardUninstalled(f.zylosDir));
  } else {
    assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes);
    assert.equal(service.calls.some(([action]) => action !== 'jlist'), false);
    if (mode === 'preview') assert.equal(result.success, true);
    else {
      assert.equal(result.error, { purge: 'purge_not_supported', 'missing registration': 'core_managed', cancelled: 'cancelled' }[mode]);
      assert.equal(process.exitCode, 1);
    }
  }
  assert.equal(prompts, ['cancelled', 'confirmed'].includes(mode) ? 1 : 0);
  assert.equal(retainedDigest(f), before);
});

test('a component registry update during service cleanup is preserved for a fresh retry', t => {
  const f = fixture(t), service = pm2Fixture([processEntry(20, f.legacyCode)]);
  let concurrentBytes;
  const result = cleanupDashboardRegistration(f, { pm2: (action, args) => {
    if (action === 'save') {
      const components = registry(f); components.added = { version: '2.0.0' };
      concurrentBytes = JSON.stringify(components);
      fs.writeFileSync(f.registryFile, concurrentBytes);
    }
    return service.pm2(action, args);
  } });
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), concurrentBytes);
  assert.equal(registry(f).added.version, '2.0.0');
  assert.throws(() => assertDashboardUninstalled(f.zylosDir), { code: 'DASHBOARD_STILL_INSTALLED' });
});

for (const metadata of [null, false, 0, '']) test(`falsey components metadata retains the flat residual-registration contract: ${JSON.stringify(metadata)}`, t => {
  const f = fixture(t), entries = registry(f), service = pm2Fixture([]);
  entries.components = metadata;
  fs.writeFileSync(f.registryFile, JSON.stringify(entries));
  assert.throws(() => assertDashboardUninstalled(f.zylosDir), { code: 'DASHBOARD_STILL_INSTALLED' });
  const result = cleanupDashboardRegistration(f, { pm2: service.pm2 });
  assert.equal(result.success, true);
  const value = JSON.parse(fs.readFileSync(f.registryFile, 'utf8'));
  assert.equal(value.components, metadata);
  assert.equal(value.telegram.version, '1.2.3');
  assert.equal(Object.hasOwn(value, 'dashboard'), false);
  assert.doesNotThrow(() => assertDashboardUninstalled(f.zylosDir));
});
