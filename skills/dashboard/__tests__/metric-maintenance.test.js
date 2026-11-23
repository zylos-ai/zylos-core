import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { migrateDashboardFile } from './helpers/explicit-migration.js';

import { migrateSchema13 } from './fixtures/schema13.js';
import { runMetricMaintenance } from '../src/lib/metric-maintenance.js';

const sunday = new Date('2026-06-07T01:00:00Z');

function fixture(t, { legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-maintenance-'));
  const file = path.join(dir, 'dashboard.db');
  if (legacy) {
    const db = new Database(file);
    migrateSchema13(db);
    db.exec('CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES (\'keep me\')');
    db.close();
    migrateDashboardFile(file);
  }
  const store = new Store(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

// SQLite integration: run for schema/Store or maintenance changes; skip UI-only
// edits. Fixture owns its temporary database and closes it before cleanup; no
// child processes, network, PM2 or tmux are used.

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
