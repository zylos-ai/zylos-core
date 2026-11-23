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
