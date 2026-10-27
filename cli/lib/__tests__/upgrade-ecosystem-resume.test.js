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
  fs.writeFileSync(template, 'module.exports = { apps: [] };\n');
  maintenance.durable(path.join(transactionDir, 'journal.json'), { initialIdentity: { ecosystemHash: null } });
  const ctx = { tempDir: path.join(root, 'package'), transactionDir, preInstallProtection: true, servicesWereRunning: ['scheduler'] };
  const calls = [];
  const run = (overrides = {}) => step11_startCoreServices(ctx, {
    zylosDir: root, ecosystemPath: destination,
    restartManagedProcess: name => calls.push(name), execSync: () => {}, ...overrides,
  });
  const intent = () => maintenance.read(path.join(transactionDir, 'journal.json')).ecosystemCreationIntent;
  return { root, transactionDir, template, destination, staging: path.join(transactionDir, 'new-ecosystem.cjs'), ctx, calls, run, intent };
}

test('service failure resumes the durable ecosystem hard link without rewriting it', t => {
  const f = fixture(t);
  const failed = f.run({ restartManagedProcess: () => { throw Error('temporarily unavailable'); } });
  assert.equal(failed.status, 'failed');
  const before = fs.statSync(f.destination);
  const originalIntent = f.intent();
  assert.equal(f.run().status, 'done');
  assert.deepEqual(f.calls, ['scheduler']);
  assert.equal(fs.statSync(f.destination).ino, before.ino);
  assert.equal(fs.statSync(f.staging).ino, before.ino);
  assert.deepEqual(f.intent(), originalIntent);
});

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

for (const contents of ['', '// incomplete ecosystem']) test(`ecosystem resume recreates ${contents ? 'corrupt' : 'empty'} private staging`, t => {
  const f = fixture(t);
  assert.equal(f.run({ fs: { ...fs, copyFileSync(source, destination) {
    fs.writeFileSync(destination, contents, { flag: 'wx' });
    throw Error('copy interrupted');
  } } }).status, 'failed');
  const originalIntent = f.intent();
  assert.equal(fs.existsSync(f.destination), false);
  assert.deepEqual(f.calls, []);
  let copies = 0;
  const result = f.run({ fs: { ...fs, copyFileSync(source, destination, flags) {
    copies++;
    assert.equal(flags, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(source, destination, flags);
  } } });
  assert.equal(result.status, 'done');
  assert.equal(copies, 1);
  assert.deepEqual(f.calls, ['scheduler']);
  assert.deepEqual(fs.readFileSync(f.destination), fs.readFileSync(f.template));
  assert.equal(fs.statSync(f.destination).ino, fs.statSync(f.staging).ino);
  assert.deepEqual(f.intent(), originalIntent);
});

for (const defect of ['symlink', 'directory', 'unrelated-destination']) test(`incomplete ecosystem staging rejects ${defect}`, t => {
  const f = fixture(t);
  assert.equal(f.run({ fs: { ...fs, copyFileSync() { throw Error('copy interrupted'); } } }).status, 'failed');
  if (defect === 'symlink') fs.symlinkSync(f.template, f.staging);
  else if (defect === 'directory') fs.mkdirSync(f.staging);
  else {
    fs.writeFileSync(f.staging, '// incomplete staging');
    fs.writeFileSync(f.destination, '// unrelated destination');
  }
  const before = fs.lstatSync(f.staging);
  const result = f.run();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /staging changed/);
  assert.equal(fs.lstatSync(f.staging).ino, before.ino);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readFileSync(f.template), Buffer.from('module.exports = { apps: [] };\n'));
  if (defect === 'unrelated-destination') {
    assert.equal(fs.readFileSync(f.staging, 'utf8'), '// incomplete staging');
    assert.equal(fs.readFileSync(f.destination, 'utf8'), '// unrelated destination');
  } else assert.equal(fs.existsSync(f.destination), false);
});

for (const defect of ['independent-same-bytes', 'changed-link', 'missing-staging', 'symlink', 'intent', 'template']) {
  test(`ecosystem resume rejects ${defect} before restarting services`, t => {
    const f = fixture(t);
    assert.equal(f.run({ restartManagedProcess: () => { throw Error('interrupted'); } }).status, 'failed');
    if (defect === 'independent-same-bytes') {
      fs.unlinkSync(f.destination);
      fs.copyFileSync(f.template, f.destination);
    } else if (defect === 'changed-link') fs.appendFileSync(f.destination, '// independently changed');
    else if (defect === 'missing-staging') fs.unlinkSync(f.staging);
    else if (defect === 'symlink') {
      fs.unlinkSync(f.destination);
      fs.symlinkSync(f.staging, f.destination);
    } else if (defect === 'template') fs.appendFileSync(f.template, '// changed package');
    else {
      const journal = maintenance.read(path.join(f.transactionDir, 'journal.json'));
      journal.ecosystemCreationIntent.staging = f.template;
      maintenance.durable(path.join(f.transactionDir, 'journal.json'), journal);
    }
    const bytes = fs.readFileSync(f.destination);
    const result = f.run();
    assert.equal(result.status, 'failed');
    assert.match(result.error, /provenance|changed/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(fs.readFileSync(f.destination), bytes);
  });
}

test('ecosystem without prior durable creation intent is never adopted', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.destination));
  fs.copyFileSync(f.template, f.destination);
  assert.match(f.run().error, /without provenance/);
  assert.equal(f.intent(), undefined);
  assert.deepEqual(f.calls, []);
});

test('a concurrent ecosystem appearing during exclusive publication is preserved', t => {
  const f = fixture(t);
  const result = f.run({ fs: { ...fs, linkSync(source, destination) {
    fs.writeFileSync(destination, '// concurrent ecosystem');
    fs.linkSync(source, destination);
  } } });
  assert.equal(result.status, 'failed');
  assert.equal(fs.readFileSync(f.destination, 'utf8'), '// concurrent ecosystem');
  assert.deepEqual(f.calls, []);
  assert.equal(f.run().status, 'failed');
});
