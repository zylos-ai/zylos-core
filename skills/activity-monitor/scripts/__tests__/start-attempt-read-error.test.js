import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { HealthStore } from '../health-store.js';

// IF-62 unreadable is distinct from missing/corrupt health. Inject an actual
// read error at the store boundary; root-run tests cannot rely on chmod denial.
test('IF-62 A unreadable F10 yields not_restricted with no write, association or F11 access', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-read-error-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const disk = new HealthStore({ zylosDir: root }), value = disk.read(); value.health = 'auth_failed'; disk.write(value);
  const before = fs.readFileSync(disk.file, 'utf8'); let reads = 0, writes = 0, caches = 0, scenes = 0;
  const owner = new RuntimeHealthCoordinator({ zylosDir: root, readMode: () => 'multi', resolveTargetRuntime: () => 'claude',
    listScenes: () => { scenes++; return []; }, readNegativeCache: () => { caches++; return null; },
    createStore: () => ({ read: () => { reads++; throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); }, write: () => { writes++; } }) });
  const request = { version: 1, type: 'start_attempt', requestId: 'sa-1792000000000-123456789abc', runtime: 'claude', sessionGroup: 'telegram:a', runId: randomUUID() };
  assert.deepEqual(await owner.registerStartAttempt(request), { version: 1, type: 'start_attempt', requestId: request.requestId, ok: true, result: 'not_restricted' });
  assert.deepEqual({ reads, writes, caches, scenes }, { reads: 1, writes: 0, caches: 0, scenes: 0 });
  assert.equal(owner.associations.size, 0); assert.equal(fs.readFileSync(disk.file, 'utf8'), before);
});
