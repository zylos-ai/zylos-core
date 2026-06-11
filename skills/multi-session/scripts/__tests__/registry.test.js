import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generateId,
  loadRegistry,
  saveRegistry,
  addWorker,
  getWorker,
  updateWorker,
  listWorkers,
  activeWorkers,
  inFlightWorkers,
  STATUSES,
} from '../registry.js';

let tmpDir;
let regPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msreg-'));
  regPath = path.join(tmpDir, 'registry.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateId', () => {
  it('starts with worker- prefix and is unique', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^worker-[a-z0-9]+-[a-f0-9]+$/);
  });
});

describe('loadRegistry', () => {
  it('returns empty registry when file is missing', () => {
    assert.deepEqual(loadRegistry(regPath), { workers: [] });
  });

  it('throws on corrupt JSON', () => {
    fs.writeFileSync(regPath, '{not json');
    assert.throws(() => loadRegistry(regPath));
  });

  it('throws on missing workers array', () => {
    fs.writeFileSync(regPath, '{"foo": 1}');
    assert.throws(() => loadRegistry(regPath), /Corrupt registry/);
  });
});

describe('saveRegistry atomic write', () => {
  it('writes via temp file + rename, leaving no temp files behind', () => {
    saveRegistry({ workers: [] }, regPath);
    assert.ok(fs.existsSync(regPath));
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('replaces existing content fully', () => {
    saveRegistry({ workers: [{ id: 'a' }] }, regPath);
    saveRegistry({ workers: [] }, regPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(regPath, 'utf8')), { workers: [] });
  });

  it('creates parent directories as needed', () => {
    const nested = path.join(tmpDir, 'deep', 'dir', 'registry.json');
    saveRegistry({ workers: [] }, nested);
    assert.ok(fs.existsSync(nested));
  });
});

describe('addWorker / getWorker', () => {
  it('adds a worker with defaults and persists it', () => {
    const w = addWorker({ task: 'build docs' }, regPath);
    assert.equal(w.status, 'pending');
    assert.ok(w.createdAt > 0);
    assert.equal(w.createdAt, w.updatedAt);
    const loaded = getWorker(w.id, regPath);
    assert.deepEqual(loaded, w);
  });

  it('requires a task description', () => {
    assert.throws(() => addWorker({}, regPath), /task/);
  });

  it('rejects invalid status', () => {
    assert.throws(() => addWorker({ task: 't', status: 'bogus' }, regPath), /Invalid status/);
  });

  it('rejects duplicate ids', () => {
    addWorker({ id: 'worker-x', task: 't' }, regPath);
    assert.throws(() => addWorker({ id: 'worker-x', task: 't2' }, regPath), /already exists/);
  });
});

describe('updateWorker', () => {
  it('updates allowed fields and bumps updatedAt', () => {
    const w = addWorker({ task: 't' }, regPath);
    const updated = updateWorker(w.id, { status: 'running', teammate: 'researcher' }, regPath);
    assert.equal(updated.status, 'running');
    assert.equal(updated.teammate, 'researcher');
    assert.ok(updated.updatedAt >= w.updatedAt);
  });

  it('rejects unknown fields and unknown workers', () => {
    const w = addWorker({ task: 't' }, regPath);
    assert.throws(() => updateWorker(w.id, { createdAt: 0 }, regPath), /not updatable/);
    assert.throws(() => updateWorker('worker-none', { status: 'done' }, regPath), /not found/);
  });

  it('accepts every documented status', () => {
    const w = addWorker({ task: 't' }, regPath);
    for (const status of STATUSES) {
      assert.equal(updateWorker(w.id, { status }, regPath).status, status);
    }
  });
});

describe('listWorkers / activeWorkers / inFlightWorkers', () => {
  it('filters by status sets', () => {
    addWorker({ task: 'a', status: 'pending' }, regPath);
    addWorker({ task: 'b', status: 'running' }, regPath);
    addWorker({ task: 'c', status: 'done' }, regPath);
    addWorker({ task: 'd', status: 'accepted' }, regPath);
    addWorker({ task: 'e', status: 'failed' }, regPath);

    assert.equal(listWorkers({}, regPath).length, 5);
    assert.equal(listWorkers({ statuses: ['failed'] }, regPath).length, 1);
    assert.deepEqual(activeWorkers(regPath).map((w) => w.task), ['a', 'b']);
    assert.deepEqual(inFlightWorkers(regPath).map((w) => w.task), ['a', 'b', 'c']);
  });
});
