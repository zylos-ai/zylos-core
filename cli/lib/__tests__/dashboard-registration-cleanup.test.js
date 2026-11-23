import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanupDashboardRegistration } from '../dashboard-registration-cleanup.js';
import { assertDashboardUninstalled as assertFinalizerDashboardUninstalled } from '../self-upgrade.js';
import { assertDashboardUninstalled } from '../core-db-backup.js';

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
    installedAt: '2026-11-01T00:00:00.000Z', skillDir: deployedCode, dataDir, source: { type: 'github-release', repo: 'zylos-ai/zylos-dashboard', ref: '0.5.5', refType: 'tag' },
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

test('malformed registry fails without exposing private content or modifying resources', t => {
  const f = fixture(t), privateMarker = crypto.randomUUID();
  fs.writeFileSync(f.registryFile, '{"private":"' + privateMarker);
  const bytes = fs.readFileSync(f.registryFile, 'utf8'), before = retainedDigest(f);
  const result = cleanupDashboardRegistration(f);
  assert.equal(result.success, false); assert.equal(result.error, 'dashboard_cleanup_failed');
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
  assert.equal(fs.readFileSync(f.registryFile, 'utf8'), bytes); assert.equal(retainedDigest(f), before);
});
