import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { step11_startCoreServices } from '../self-upgrade.js';

const maintenance = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transactionDir = path.join(root, 'transaction');
  const template = path.join(root, 'package/templates/pm2/ecosystem.config.cjs');
  const destination = path.join(root, 'pm2/ecosystem.config.cjs');
  fs.mkdirSync(path.dirname(template), { recursive: true });
  fs.mkdirSync(transactionDir);
  fs.writeFileSync(template, 'module.exports = { apps: [{name:"scheduler"}] };\n');
  maintenance.durable(path.join(transactionDir, 'journal.json'), { initialIdentity: { ecosystemHash: null } });
  const ctx = { tempDir: path.join(root, 'package'), transactionDir, upgradeProtected: true, servicesWereRunning: ['scheduler'] };
  const calls = [];
  const run = (overrides = {}) => step11_startCoreServices(ctx, {
    zylosDir: root, ecosystemPath: destination,
    restartManagedProcess: name => calls.push(name), execSync: () => {}, ...overrides,
  });
  const intent = () => maintenance.read(path.join(transactionDir, 'journal.json')).ecosystemCreationIntent;
  return { root, transactionDir, template, destination, staging: path.join(transactionDir, 'new-ecosystem.cjs'), ctx, calls, run, intent };
}

for (const cutoff of ['intent', 'staging', 'link']) test(`ecosystem creation resumes after interruption at ${cutoff}`, t => {
  const f = fixture(t);
  const interruptedFs = { ...fs };
  const method = cutoff === 'intent' ? 'copyFileSync' : 'linkSync';
  interruptedFs[method] = (...args) => {
    if (cutoff === 'link') fs.linkSync(...args);
    throw Error('simulated interruption');
  };
  assert.equal(f.run({ fs: interruptedFs }).status, 'failed');
  assert.ok(f.intent());
  assert.deepEqual(f.calls, []);
  assert.equal(f.run().status, 'done');
  assert.equal(fs.statSync(f.destination).ino, fs.statSync(f.staging).ino);
});
