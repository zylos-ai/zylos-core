import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMigration } from '../memory-migration.js';

const indexes = ['reference/projects/INDEX.md', 'reference/decisions/INDEX.md'];
function fixture(t, links) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'memory/reference'), { recursive: true });
  const original = links.map(name => `\`${name}\``).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'memory/references.md'), original);
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: 'reference-run' };
  const service = createMigration({ env, now: () => 1000, version: 'test-version',
    readMode: () => ({ mode: 'multi' }), readTransition: () => null,
    observe: () => ({ present: true, ready: true, runId: env.ZYLOS_RUN_ID, f3: { runId: env.ZYLOS_RUN_ID }, rawF2: { ZYLOS_SESSION_GROUP: 'origin' } }),
    lock: async (_directory, action) => action(),
  });
  const record = () => JSON.parse(fs.readFileSync(path.join(root, '.zylos/migrations/references-layout-v1.json'), 'utf8'));
  const prepareCompletion = async () => {
    service.ensure({ createdBy: 'upgrade' });
    await service.apply({ path: 'references.md', expected: original, replacement: original });
  };
  return { root, service, record, prepareCompletion };
}

test('references migration accepts both absent generated indexes and records them as indexed', async t => {
  const f = fixture(t, indexes);
  await f.prepareCompletion();
  assert.equal((await f.service.complete('Index navigation checked')).state, 'done');
  const evidence = f.record().evidence.mechanical;
  assert.deepEqual(evidence.missingPaths, []);
  assert.deepEqual(evidence.indexedPaths, indexes.map(name => `memory/${name}`));
});

test('missing ordinary references still fail while absent generated indexes are omitted', async t => {
  const f = fixture(t, [...indexes, 'reference/other.md']);
  await f.prepareCompletion();
  await assert.rejects(f.service.complete('Missing ordinary page'), error => {
    assert.equal(error.code, 'CHECK_FAILED');
    assert.deepEqual(error.missingPaths, ['memory/reference/other.md']);
    t.diagnostic(JSON.stringify({ missingPaths: error.missingPaths }));
    return true;
  });
  assert.equal(f.service.status().state, 'pending');
});

test('ordinary missing-reference behavior is unchanged without index navigation', async t => {
  const f = fixture(t, ['reference/other.md']);
  await f.prepareCompletion();
  await assert.rejects(f.service.complete('Missing ordinary page'), error => {
    assert.equal(error.code, 'CHECK_FAILED');
    assert.deepEqual(error.missingPaths, ['memory/reference/other.md']);
    return true;
  });
});

test('fresh references navigation with absent generated indexes is immediately done', t => {
  const f = fixture(t, indexes);
  assert.equal(f.service.ensure({ createdBy: 'init', freshInstall: true }).state, 'done');
  assert.equal(f.record().evidence.kind, 'fresh_install');
});

test('a fresh copy of the real memory templates accepts prefixed optional index navigation', t => {
  const f = fixture(t, []);
  fs.cpSync(new URL('../../../templates/memory/', import.meta.url), path.join(f.root, 'memory'), { recursive: true });
  const navigation = fs.readFileSync(path.join(f.root, 'memory/references.md'), 'utf8');
  for (const name of indexes) {
    assert.ok(navigation.includes(`memory/${name}`));
    assert.equal(fs.existsSync(path.join(f.root, 'memory', name)), false);
  }
  assert.equal(f.service.ensure({ createdBy: 'init', freshInstall: true }).state, 'done');
  const evidence = f.record().evidence.mechanical;
  assert.deepEqual(evidence.missingPaths, []);
  for (const name of indexes) assert.ok(evidence.indexedPaths.includes(`memory/${name}`));
});

test('missing project and decision pages remain required alongside optional indexes', async t => {
  const pages = ['reference/projects/some-page.md', 'reference/decisions/some-page.md'];
  const f = fixture(t, [...indexes, ...pages]);
  await f.prepareCompletion();
  await assert.rejects(f.service.complete('Missing category pages'), error => {
    assert.equal(error.code, 'CHECK_FAILED');
    assert.deepEqual(error.missingPaths, pages.map(name => `memory/${name}`));
    return true;
  });
  assert.equal(f.service.status().state, 'pending');
});

test('an index path beneath a regular file is not treated as an optional absence', async t => {
  const f = fixture(t, indexes);
  for (const category of ['projects', 'decisions']) {
    fs.writeFileSync(path.join(f.root, 'memory/reference', category), 'not a directory');
  }
  await f.prepareCompletion();
  await assert.rejects(f.service.complete('Invalid category directories'), error => {
    assert.equal(error.code, 'CHECK_FAILED');
    assert.deepEqual(error.missingPaths, indexes.map(name => `memory/${name}`));
    return true;
  });
  assert.equal(f.service.status().state, 'pending');
});

test('an existing unreadable index is not treated as an optional absence', async t => {
  const f = fixture(t, indexes), target = path.join(f.root, 'memory', indexes[0]);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'index');
  await f.prepareCompletion();
  const access = fs.accessSync;
  t.mock.method(fs, 'accessSync', (name, mode) => {
    if (name === target) throw Object.assign(new Error('Unreadable index'), { code: 'EACCES' });
    return access(name, mode);
  });
  await assert.rejects(f.service.complete('Unreadable existing index'), error => {
    assert.equal(error.code, 'CHECK_FAILED');
    assert.deepEqual(error.missingPaths, ['memory/reference/projects/INDEX.md']);
    return true;
  });
});
