import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  Pm2SnapshotError,
  collectPm2Snapshot,
  sanitizePm2Processes,
} from '../pm2-snapshot.js';

const SCRIPT_PATH = fileURLToPath(new URL('../pm2-snapshot.js', import.meta.url));
const FIXTURE_BIN = fileURLToPath(new URL('./fixtures', import.meta.url));

test('sanitizePm2Processes returns only health fields', () => {
  const sentinel = 'SENTINEL_SECRET_SHOULD_NOT_ESCAPE';
  const snapshot = sanitizePm2Processes([
    {
      name: 'scheduler',
      pid: 123,
      pm2_env: {
        status: 'online',
        restart_time: 2,
        env: {
          API_TOKEN: sentinel,
        },
      },
      monit: { memory: 50_000_000 },
    },
    {
      name: 'worker',
      pid: 456,
      pm2_env: {
        status: 'stopped',
        restart_time: 4,
      },
    },
  ]);

  assert.deepEqual(snapshot, {
    total: 2,
    online: 1,
    services: [
      { name: 'scheduler', status: 'online', pid: 123, restart_time: 2 },
      { name: 'worker', status: 'stopped', pid: 456, restart_time: 4 },
    ],
  });
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  assert.equal(JSON.stringify(snapshot).includes('pm2_env'), false);
  assert.equal(JSON.stringify(snapshot).includes('monit'), false);
});

test('collectPm2Snapshot does not echo output from a failed PM2 command', () => {
  const sentinel = 'FAILED_COMMAND_SECRET';
  const run = () => ({
    status: 1,
    stdout: `[${JSON.stringify({ pm2_env: { env: { TOKEN: sentinel } } })}]`,
    stderr: `failure: ${sentinel}`,
  });

  assert.throws(
    () => collectPm2Snapshot(run),
    (error) => error instanceof Pm2SnapshotError
      && error.message === 'Unable to collect PM2 process status'
      && !error.message.includes(sentinel),
  );
});

test('collectPm2Snapshot rejects malformed JSON without echoing it', () => {
  const sentinel = 'MALFORMED_JSON_SECRET';
  const run = () => ({ status: 0, stdout: `{not-json:${sentinel}}`, stderr: '' });

  assert.throws(
    () => collectPm2Snapshot(run),
    (error) => error instanceof Pm2SnapshotError
      && error.message === 'PM2 returned invalid JSON'
      && !error.message.includes(sentinel),
  );
});

test('CLI failure keeps raw PM2 output out of stdout and stderr', () => {
  const sentinel = 'CLI_SECRET_SHOULD_NOT_ESCAPE';
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
      PM2_TEST_MODE: 'malformed',
      PM2_TEST_SENTINEL: sentinel,
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^PM2 health snapshot failed: PM2 returned invalid JSON\n$/);
  assert.equal(result.stderr.includes(sentinel), false);
});

test('CLI success emits sanitized JSON without inherited environment values', () => {
  const sentinel = 'SUCCESS_SECRET_SHOULD_NOT_ESCAPE';
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${process.env.PATH}`,
      PM2_TEST_MODE: 'valid',
      PM2_TEST_SENTINEL: sentinel,
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    total: 1,
    online: 1,
    services: [
      { name: 'scheduler', status: 'online', pid: 123, restart_time: 2 },
    ],
  });
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stdout.includes('pm2_env'), false);
});

test('health-check instructions route PM2 inspection through the sanitizer', () => {
  const healthSkill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
  const monitor = readFileSync(
    new URL('../../../activity-monitor/scripts/monitor.js', import.meta.url),
    'utf8',
  );

  assert.match(healthSkill, /health-check\/scripts\/pm2-snapshot\.js/);
  assert.doesNotMatch(healthSkill, /```bash\s+pm2 jlist\s+```/);
  assert.match(monitor, /Use the health-check skill sanitized helper/);
  assert.doesNotMatch(monitor, /Check PM2 services \(pm2 jlist\)/);
});
