import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { migrateDashboardFile } from './helpers/explicit-migration.js';
import { TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { MetricResolver } from '../src/lib/metric-resolver.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-metric-'));
  const file = path.join(dir, 'dashboard.db');
  const store = new Store(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, file };
}

test('latestMetric preserves source/runtime/window and breaks timestamp ties by id', t => {
  const { store } = fixture(t);
  const insert = store.db.prepare(`INSERT INTO metric_points(timestamp,runtime,metric_name,metric_value,source,dimensions) VALUES (?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  insert.run(now, 'claude', 'context_pct', 1, 'statusline', '{}');
  insert.run(now, '', 'context_pct', 2, 'statusline', '{"legacy":true}');
  insert.run(now, 'codex', 'context_pct', 3, 'statusline', '{}');
  insert.run(now, 'claude', 'context_pct', 4, 'system', '{}');
  insert.run('2000-01-01', 'claude', 'context_pct', 100, 'statusline', '{}');
  const query = { name: 'context_pct', source: 'statusline', since: '2020', until: '2099' };
  assert.equal(store.latestMetric({ ...query, runtime: 'claude' }).metric_value, 2);
  assert.equal(store.latestMetric({ ...query, runtime: 'codex' }).metric_value, 3);
  assert.equal(store.latestMetric({ ...query, runtime: null }).metric_value, 3);
  assert.equal(store.latestMetric({ ...query, runtime: 'other' }), null);
  assert.equal(store.latestMetric({ ...query, since: '2090' }), null);
  const resolver = new MetricResolver(store, {}, { runtime: 'codex' });
  store.queryMetrics = () => { throw new Error('full scan must not be used'); };
  assert.equal(resolver._getLatestMetric('context_pct', 'statusline').metric_value, 3);
  assert.equal(resolver._getLatestMetric('context_pct', 'system').metric_value, 4);
});

// SQLite migration integration: run for schema/Store index changes; skip UI-only
// edits. All database handles and files belong to this temporary fixture; no
// child processes, network, PM2 or tmux are used.
test('v13 adds indexes idempotently without changing cost totals', t => {
  const { store, file } = fixture(t);
  const insert = store.db.prepare(`INSERT INTO metric_points(timestamp,session_id,metric_name,metric_value,source,dimensions) VALUES (?,?,?,?,?,?)`);
  insert.run('2026-10-27', 's', 'usage_event', 1, 'hook', '{"cost":0.5}');
  insert.run('2026-10-27', 's', 'api_request_cost', 0.25, 'hook', '{}');
  insert.run('2026-10-26', 'other', 'usage_event', 1, 'hook', '{"cost":1.25}');
  insert.run('2026-10-27', 's', 'usage_event', 1, 'hook', '{}');
  const before = [store.aggregateCost(), store.aggregateCost({ sessionId: 's' }), store.aggregateCost({ since: '2026-10-27' })];
  assert.deepEqual(before, [2, 0.75, 0.75]);
  store.db.exec(`
    DROP INDEX idx_metric_latest;
    DROP INDEX idx_metric_cost_time;
    DROP INDEX idx_metric_cost_session;
    DROP TABLE group_display_names;
    DROP TABLE usage_transcripts;
    DROP INDEX idx_metric_points_group_ts;
    ALTER TABLE metric_points DROP COLUMN session_group;
    DROP TABLE core_log_cursors;
    DROP INDEX idx_events_group_seq;
    DROP INDEX idx_events_group_run_seq;
    DROP INDEX idx_events_group_type_ts;
    ALTER TABLE runtime_events DROP COLUMN session_group;
    ALTER TABLE runtime_events DROP COLUMN run_id;
    DELETE FROM schema_migrations WHERE version>=13;
  `);
  assert.throws(() => new Store(file), { code: 'SCHEMA_UPGRADE_REQUIRED' });
  migrateDashboardFile(file);
  const migrated = new Store(file);
  assert.equal(migrated.db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, TARGET_SCHEMA_VERSION);
  assert.deepEqual([migrated.aggregateCost(), migrated.aggregateCost({ sessionId: 's' }), migrated.aggregateCost({ since: '2026-10-27' })], before);
  const plan = migrated.db.prepare("EXPLAIN QUERY PLAN SELECT SUM(json_extract(dimensions,'$.cost')) FROM metric_points WHERE metric_name='usage_event' AND session_id='s' AND timestamp >= '2026'").all();
  assert.ok(plan.some(row => row.detail.includes('idx_metric_cost_session')));
  migrated.close();
  const reopened = new Store(file);
  assert.equal(reopened.aggregateCost(), 2);
  reopened.close();
});
