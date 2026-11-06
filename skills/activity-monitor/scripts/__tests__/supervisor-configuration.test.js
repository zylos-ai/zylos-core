import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSupervisorConfiguration } from '../supervisor-configuration.js';

const worker = fileURLToPath(new URL('./fixtures/supervisor-configuration-worker.js', import.meta.url));
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const config = { session_mode: 'multi', runtime: 'claude', model: 'opus[1m]',
  new_session_threshold: 30, codex_new_session_threshold: 45, session_hot_ttl_seconds: 60, session_evict_min_idle_seconds: 90,
  sync_min_interval_seconds: 12, sync_max_interval_seconds: 1000, origin_sync_threshold: 20, sync_batch_limit: 40 };
const envKeys = ['ZYLOS_SESSION_HOT_TTL_SECONDS', 'ZYLOS_SESSION_EVICT_MIN_IDLE_SECONDS', 'ZYLOS_SYNC_MIN_INTERVAL_SECONDS',
  'ZYLOS_SYNC_MAX_INTERVAL_SECONDS', 'ZYLOS_ORIGIN_SYNC_THRESHOLD', 'ZYLOS_SYNC_BATCH_LIMIT'];
function fromFile(t, environment = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-config-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify(config));
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: repository,
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 't'), TMUX_TMPDIR: path.join(root, 'm') };
  env.TMUX = `${path.join(env.TMUX_TMPDIR, 'private.sock')},0,0`;
  for (const key of ['PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) fs.mkdirSync(env[key]);
  for (const key of envKeys) delete env[key];
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(fs.realpathSync(env[key]) === root || fs.realpathSync(env[key]).startsWith(root + path.sep));
  }
  console.log('Configuration worker isolation:', JSON.stringify({ command: process.execPath,
    args: [worker], root, env: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX'].map(key => [key, env[key]])),
    configPath: path.join(root, '.zylos/config.json') }));
  return JSON.parse(execFileSync(process.execPath, [worker], { env: { ...env, ...environment }, timeout: 15000, encoding: 'utf8' }));
}

// Real config.json must reach supervisor startup settings. Run for lifecycle
// configuration changes; unrelated health-only changes may skip these workers.
// The official runner and this fixture both isolate all runtime destinations;
// worker dependencies forbid external sends and do not launch a real adapter.
test('entry honors the 1M Claude 30% threshold and configured 60s TTL from config.json', t => {
  const result = fromFile(t), resolved = result.configuration;
  assert.deepEqual(resolved.rotationThresholds, { claude: 30, codex: 45 });
  assert.equal(resolved.hotTtlSeconds, 60);
  assert.equal(resolved.evictMinIdleSeconds, 90);
  assert.equal(resolved.syncMinIntervalSeconds, 12);
  assert.equal(resolved.syncMaxIntervalSeconds, 1000);
  assert.equal(resolved.originSyncThreshold, 20);
  assert.equal(resolved.syncBatchLimit, 40);
  assert.equal(resolved.syncThreshold, 15);
  assert.equal(result.controls.length, 1, '50% usage must rotate with the configured 30% threshold');
  assert.deepEqual(result.fences, [{ sessionGroup: 'a', reason: 'ttl', runId: 'run-a' }], '120s idle must expire a 60s TTL');
  assert.equal(result.refreshed.mode, 'single');
  for (const key of ['hotTtlSeconds', 'evictMinIdleSeconds', 'syncMinIntervalSeconds', 'rotationThresholds'])
    assert.deepEqual(result.refreshed[key], resolved[key], 'startup settings change only after restart');
});

test('entry gives valid environment settings priority over real config.json', t => {
  const result = fromFile(t, { ZYLOS_SESSION_HOT_TTL_SECONDS: '300', ZYLOS_SESSION_EVICT_MIN_IDLE_SECONDS: '180', ZYLOS_SYNC_MIN_INTERVAL_SECONDS: '25',
    ZYLOS_SYNC_MAX_INTERVAL_SECONDS: '2000', ZYLOS_ORIGIN_SYNC_THRESHOLD: '35', ZYLOS_SYNC_BATCH_LIMIT: '80' });
  assert.equal(result.configuration.hotTtlSeconds, 300);
  assert.equal(result.configuration.evictMinIdleSeconds, 180);
  assert.equal(result.configuration.syncMinIntervalSeconds, 25);
  assert.equal(result.configuration.syncMaxIntervalSeconds, 2000);
  assert.equal(result.configuration.originSyncThreshold, 35);
  assert.equal(result.configuration.syncBatchLimit, 80);
  assert.deepEqual(result.fences, [], '120s idle must not expire an environment-selected 300s TTL');
});

test('invalid optional values fall through environment, config and defaults without losing thresholds', () => {
  const defaults = parseSupervisorConfiguration({}, {});
  assert.deepEqual(defaults, { hotTtlSeconds: 1800, evictMinIdleSeconds: 300, syncMinIntervalSeconds: 600, syncMaxIntervalSeconds: 21600,
    originSyncThreshold: 50, syncBatchLimit: 200, syncThreshold: 15, rotationThresholds: { claude: 70, codex: 75 } });
  const fields = ['session_hot_ttl_seconds', 'session_evict_min_idle_seconds', 'sync_min_interval_seconds', 'sync_max_interval_seconds', 'origin_sync_threshold', 'sync_batch_limit'];
  for (const invalid of ['', '0', '-1', '1.5', 'NaN', '12x', '9007199254740992']) {
    const env = Object.fromEntries(envKeys.map(key => [key, invalid]));
    assert.deepEqual(parseSupervisorConfiguration(config, env), parseSupervisorConfiguration(config, {}));
    assert.deepEqual(parseSupervisorConfiguration(Object.fromEntries(fields.map(key => [key, invalid])), env), defaults);
  }
  assert.deepEqual(parseSupervisorConfiguration({ new_session_threshold: '30', codex_new_session_threshold: '45' }, {}).rotationThresholds,
    { claude: 30, codex: 45 });
  assert.deepEqual(parseSupervisorConfiguration({ new_session_threshold: 101, codex_new_session_threshold: 0 }, {}).rotationThresholds,
    { claude: 70, codex: 75 });
});
