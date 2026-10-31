import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { migrateSchema13 } from './fixtures/schema13.js';
import { runMetricMaintenance } from '../src/lib/metric-maintenance.js';

const sunday = new Date('2026-06-07T01:00:00Z');
const monday = new Date('2026-06-08T01:00:00Z');

function fixture(t, { legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-maintenance-'));
  const file = path.join(dir, 'dashboard.db');
  if (legacy) {
    const db = new Database(file);
    migrateSchema13(db);
    db.exec('CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES (\'keep me\')');
    db.close();
  }
  const store = new Store(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function fillOldMetrics(store, count = 1500) {
  const insert = store.db.prepare(`INSERT INTO metric_points
    (timestamp, runtime, metric_name, metric_value, dimensions, source, confidence)
    VALUES ('2025-01-01T00:00:00.000Z', 'codex', 'usage_event', 0, ?, 'jsonl_usage', 'actual')`);
  const dimensions = JSON.stringify({ cost: 0.01, padding: 'x'.repeat(6000) });
  store.db.transaction(() => { for (let i = 0; i < count; i++) insert.run(dimensions); })();
  store.walCheckpoint();
}

test('new databases enable incremental vacuum before schema creation', (t) => {
  const store = fixture(t);
  assert.equal(store.autoVacuumMode(), 2);
  assert.equal(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 20);
});

test('legacy database is not converted at startup or on a non-Sunday maintenance', async (t) => {
  const store = fixture(t, { legacy: true });
  assert.equal(store.autoVacuumMode(), 0);
  const result = await runMetricMaintenance(store, { now: monday });
  assert.equal(result.conversion, null);
  assert.equal(store.autoVacuumMode(), 0);
  assert.equal(store.db.prepare('SELECT value FROM retained').get().value, 'keep me');
});

test('Sunday converts once and later Sundays never do a full VACUUM', async (t) => {
  const store = fixture(t, { legacy: true });
  let fullVacuums = 0;
  const vacuum = store.vacuum.bind(store);
  store.vacuum = () => { fullVacuums++; return vacuum(); };
  const first = await runMetricMaintenance(store, { now: sunday });
  assert.equal(first.conversion.converted, true);
  assert.equal(store.autoVacuumMode(), 2);
  assert.equal(fullVacuums, 1);
  const again = await runMetricMaintenance(store, { now: new Date('2026-06-14T01:00:00Z') });
  assert.equal(again.conversion, null);
  assert.equal(fullVacuums, 1);
  assert.equal(store.db.prepare('SELECT value FROM retained').get().value, 'keep me');
});

test('conversion failure records the attempt date and retries only on a later Sunday', async (t) => {
  const store = fixture(t, { legacy: true });
  let attempts = 0;
  const enable = store.enableIncrementalVacuum.bind(store);
  store.enableIncrementalVacuum = (...args) => {
    attempts++;
    if (attempts === 1) throw new Error('simulated VACUUM failure');
    return enable(...args);
  };
  const lines = [];
  t.mock.method(process.stderr, 'write', (line) => { lines.push(line); return true; });
  const first = await runMetricMaintenance(store, { now: sunday });
  assert.equal(first.conversion.failed, true);
  assert.equal(first.lastConversionDate, '2026-06-07');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /simulated VACUUM failure/);
  assert.equal(store.autoVacuumMode(), 0);
  const sameDay = await runMetricMaintenance(store, {
    now: new Date('2026-06-07T02:00:00Z'), lastConversionDate: first.lastConversionDate,
  });
  assert.equal(sameDay.conversion, null);
  assert.equal(attempts, 1);
  const nextWeek = await runMetricMaintenance(store, {
    now: new Date('2026-06-14T01:00:00Z'), lastConversionDate: sameDay.lastConversionDate,
  });
  assert.equal(nextWeek.conversion.converted, true);
  assert.equal(attempts, 2);
  assert.equal(store.autoVacuumMode(), 2);
});

test('conversion measures effective pages rather than the bloated file size', async (t) => {
  const store = fixture(t, { legacy: true });
  fillOldMetrics(store, 100);
  store.db.exec('DELETE FROM metric_points');
  const effectiveBytes = store.spaceUsage().effectiveBytes;
  assert.ok(store.dbSizeBytes() > effectiveBytes * 2);
  store.diskFreeBytes = () => effectiveBytes * 2;
  const result = await runMetricMaintenance(store, { now: sunday, conversionMaxBytes: effectiveBytes });
  assert.equal(result.conversion.converted, true);
  assert.equal(store.autoVacuumMode(), 2);
});

for (const [name, space, disk, reason] of [
  ['effective data over 2 GiB', 2 * 1024 ** 3 + 4096, 10 * 1024 ** 3, 'effective_data_too_large'],
  ['disk below twice effective data', 1024, 2047, 'insufficient_disk_space'],
  ['unknown disk space', 1024, null, 'disk_space_unknown'],
]) {
  test(`Sunday conversion skips ${name}, logs both sizes, and is not retried that day`, async (t) => {
    const store = fixture(t, { legacy: true });
    store.spaceUsage = () => ({ effectiveBytes: space });
    store.diskFreeBytes = () => disk;
    const lines = [];
    t.mock.method(process.stderr, 'write', (line) => { lines.push(line); return true; });
    const first = await runMetricMaintenance(store, { now: sunday });
    assert.equal(first.conversion.reason, reason);
    assert.equal(store.autoVacuumMode(), 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`effectiveBytes=${space}, freeBytes=${disk ?? 'unknown'}`));
    assert.match(lines[0], /docs\/modules\/db-maintenance\.md/);
    const again = await runMetricMaintenance(store, { now: sunday, lastConversionDate: first.lastConversionDate });
    assert.equal(again.conversion, null);
    assert.equal(lines.length, 1);
  });
}

test('conversion allows exactly 2 GiB effective data and twice that free disk', (t) => {
  const store = fixture(t, { legacy: true });
  store.spaceUsage = () => ({ effectiveBytes: 2 * 1024 ** 3 });
  store.diskFreeBytes = () => 4 * 1024 ** 3;
  assert.equal(store.enableIncrementalVacuum().converted, true);
  assert.equal(store.autoVacuumMode(), 2);
});

test('hourly cleanup reclaims real free pages in bounded chunks and yields to timers', async (t) => {
  const store = fixture(t);
  fillOldMetrics(store);
  const initialSize = store.dbSizeBytes();
  const initialFree = store.spaceUsage().freePages;
  let timerRan = false;
  let secondChunkSawTimer = false;
  const calls = [];
  const vacuum = store.incrementalVacuum.bind(store);
  store.incrementalVacuum = (pages) => {
    if (calls.length > 0) secondChunkSawTimer ||= timerRan;
    const start = performance.now();
    const freed = vacuum(pages);
    calls.push({ pages, freed, ms: performance.now() - start });
    return freed;
  };
  setImmediate(() => { timerRan = true; });
  const result = await runMetricMaintenance(store, { now: monday, vacuumMaxPages: 2000 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM metric_points').get().n, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.pages <= 1000 && call.freed <= call.pages));
  assert.ok(result.pagesFreed > 0);
  assert.ok(secondChunkSawTimer);
  assert.ok(store.spaceUsage().freePages > 0, 'total work is capped even with pages remaining');
  assert.ok(store.dbSizeBytes() < initialSize);
  t.diagnostic(JSON.stringify({ initialSize, finalSize: store.dbSizeBytes(), initialFree, finalFree: store.spaceUsage().freePages, pagesFreed: result.pagesFreed, calls }));
});

test('shutdown abort stops reclamation between chunks', async (t) => {
  const store = fixture(t);
  fillOldMetrics(store);
  const abort = new AbortController();
  setImmediate(() => abort.abort());
  const result = await runMetricMaintenance(store, { now: monday, signal: abort.signal });
  assert.equal(result.chunks, 1);
  assert.ok(store.spaceUsage().freePages > 0);
});
