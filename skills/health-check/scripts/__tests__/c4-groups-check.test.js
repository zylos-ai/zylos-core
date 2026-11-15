import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { C4GroupsCheckError, interpretGroupsResult } from '../c4-groups-check.js';
import { C4_DB_CLI, c4Cli, createIsolatedZylos } from './helpers/isolated-zylos.js';

const SCRIPT_PATH = fileURLToPath(new URL('../c4-groups-check.js', import.meta.url));
const CONTENT_SENTINEL = 'MESSAGE_CONTENT_SHOULD_NOT_ESCAPE';
const GROUP_SENTINEL = 'privategroupname';

function withIsolatedZylos(fn) {
  const zylos = createIsolatedZylos();
  try { return fn(zylos); } finally { zylos.cleanup(); }
}

function seedMessages({ env, zylosDir }) {
  assert.equal(c4Cli(env, ['insert', 'in', 'system', 'null', `${CONTENT_SENTINEL} origin`, '--json']).status, 0);
  mkdirSync(join(zylosDir, '.claude', 'skills', 'telegram'), { recursive: true });
  const grouped = c4Cli(env, ['insert', 'in', 'telegram', 'null', `${CONTENT_SENTINEL} telegram`,
    '--session-group', GROUP_SENTINEL, '--json']);
  assert.equal(grouped.status, 0, grouped.stdout + grouped.stderr);
}

function runCheck(env) {
  return spawnSync(process.execPath, [SCRIPT_PATH], { env, encoding: 'utf8', timeout: 60_000 });
}

function snapshotFiles(directory) {
  return Object.fromEntries(readdirSync(directory).sort().map(name => {
    const file = join(directory, name);
    return [name, createHash('sha256').update(readFileSync(file)).digest('hex')];
  }));
}

function assertNoPrivateText(result) {
  for (const text of [result.stdout, result.stderr]) {
    assert.equal(text.includes(CONTENT_SENTINEL), false);
    assert.equal(text.includes(GROUP_SENTINEL), false);
  }
}

test('readable C4 database exits 0 with a count and leaves the database unchanged', () => {
  withIsolatedZylos((zylos) => {
    seedMessages(zylos);
    const dataDir = join(zylos.zylosDir, 'comm-bridge');
    const before = snapshotFiles(dataDir);

    const result = runCheck(zylos.env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'C4 session groups OK: 2 groups listed\n');
    assert.equal(result.stderr, '');
    assertNoPrivateText(result);
    assert.deepEqual(snapshotFiles(dataDir), before);
  });
});

test('corrupted C4 database exits non-zero with the C4 error code', () => {
  withIsolatedZylos((zylos) => {
    seedMessages(zylos);
    writeFileSync(zylos.dbPath, `not a database ${CONTENT_SENTINEL}`.repeat(200));
    for (const suffix of ['-wal', '-shm']) assert.equal(existsSync(zylos.dbPath + suffix), false);
    const before = snapshotFiles(join(zylos.zylosDir, 'comm-bridge'));

    const result = runCheck(zylos.env);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'C4 session groups FAILED [SQLITE_NOTADB]: C4 could not read the session group list\n');
    assertNoPrivateText(result);
    assert.deepEqual(snapshotFiles(join(zylos.zylosDir, 'comm-bridge')), before);
  });
});

test('unreadable C4 database file exits non-zero with DB_UNREADABLE', { skip: process.getuid?.() === 0 && 'root can read mode 000 files' }, () => {
  withIsolatedZylos((zylos) => {
    seedMessages(zylos);
    chmodSync(zylos.dbPath, 0o000);
    try {
      const result = runCheck(zylos.env);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'C4 session groups FAILED [DB_UNREADABLE]: C4 message database file is not readable\n');
    } finally {
      chmodSync(zylos.dbPath, 0o600);
    }
  });
});

test('missing C4 database exits non-zero without creating one', () => {
  withIsolatedZylos((zylos) => {
    const result = runCheck(zylos.env);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'C4 session groups FAILED [DB_MISSING]: C4 message database file not found\n');
    assert.equal(existsSync(join(zylos.zylosDir, 'comm-bridge')), false);
  });
});

test('empty C4 database file exits non-zero without initializing it', () => {
  withIsolatedZylos((zylos) => {
    mkdirSync(join(zylos.zylosDir, 'comm-bridge'));
    writeFileSync(zylos.dbPath, '');

    const result = runCheck(zylos.env);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'C4 session groups FAILED [DB_EMPTY]: C4 message database file is empty\n');
    assert.equal(statSync(zylos.dbPath).size, 0);
    assert.deepEqual(readdirSync(join(zylos.zylosDir, 'comm-bridge')), ['c4.db']);
  });
});

test('a row with an integer timestamp gives the same outcome as the C4 groups read', () => {
  withIsolatedZylos((zylos) => {
    seedMessages(zylos);
    const db = new Database(zylos.dbPath);
    try { db.prepare('UPDATE conversations SET timestamp = 1700000000 WHERE id = (SELECT MAX(id) FROM conversations)').run(); }
    finally { db.close(); }

    const direct = c4Cli(zylos.env, ['groups', '--json']);
    const envelope = JSON.parse(direct.stdout);
    const result = runCheck(zylos.env);

    assertNoPrivateText(result);
    if (envelope.ok) {
      assert.equal(result.status, 0, result.stderr);
      const count = envelope.data.length;
      assert.equal(result.stdout, `C4 session groups OK: ${count} ${count === 1 ? 'group' : 'groups'} listed\n`);
    } else {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `C4 session groups FAILED [${envelope.error.code}]: C4 could not read the session group list\n`);
    }
  });
});

// Runs checkC4Groups in a child process so C4 resolves the database path from
// the isolated environment; the read command is replaced by a recorder.
function checkWithRecorder(env) {
  const moduleUrl = new URL('../c4-groups-check.js', import.meta.url).href;
  const source = `const { default: assert } = await import('node:assert/strict');
const { checkC4Groups } = await import(${JSON.stringify(moduleUrl)});
const calls = [];
const run = (command, args, options) => {
  assert.equal(options.timeout, 30000);
  calls.push([command, args]); return { status: 0, stdout: '{"ok":true,"data":[{}]}' };
};
let outcome;
try { outcome = { result: checkC4Groups({ run }) }; } catch (error) { outcome = { code: error.code }; }
process.stdout.write(JSON.stringify({ ...outcome, calls }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('checkC4Groups runs the C4 groups read and does not start it for a missing file', () => {
  withIsolatedZylos((zylos) => {
    assert.deepEqual(checkWithRecorder(zylos.env), { code: 'DB_MISSING', calls: [] });

    seedMessages(zylos);
    assert.deepEqual(checkWithRecorder(zylos.env), {
      result: { groups: 1 },
      calls: [[process.execPath, [C4_DB_CLI, 'groups', '--json']]],
    });
  });
});

test('interpretGroupsResult maps read failures to codes without echoing output', () => {
  const sentinel = 'CHILD_OUTPUT_SHOULD_NOT_ESCAPE';
  const cases = [
    [{ error: Object.assign(new Error(sentinel), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null }, 'TIMEOUT'],
    [{ error: Object.assign(new Error(sentinel), { code: 'ENOBUFS' }), status: null }, 'INVALID_OUTPUT'],
    [{ error: Object.assign(new Error(sentinel), { code: 'ENOENT' }), status: null }, 'SPAWN_FAILED'],
    [{ status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'READ_FAILED', message: sentinel } }) }, 'READ_FAILED'],
    [{ status: 1, stdout: JSON.stringify({ ok: false, error: { code: `bad code ${sentinel}`, message: sentinel } }) }, 'READ_FAILED'],
    [{ status: 1, stdout: '', stderr: `Error: ${sentinel}\n    at stack` }, 'READ_FAILED'],
    [{ status: 0, stdout: `{not json ${sentinel}` }, 'INVALID_OUTPUT'],
    [{ status: 0, stdout: JSON.stringify({ ok: true, data: { groups: [sentinel] } }) }, 'INVALID_OUTPUT'],
  ];
  for (const [result, code] of cases) {
    assert.throws(() => interpretGroupsResult(result), (error) => error instanceof C4GroupsCheckError
      && error.code === code && !error.message.includes(sentinel), code);
  }
  assert.deepEqual(interpretGroupsResult({ status: 0, stdout: JSON.stringify({ ok: true, data: [] }) }), { groups: 0 });
});

test('health-check instructions and the scheduled prompt include the C4 session group check', () => {
  const healthSkill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
  const machineTasks = readFileSync(
    new URL('../../../activity-monitor/scripts/supervisor-machine-tasks.js', import.meta.url),
    'utf8',
  );

  assert.match(healthSkill, /node ~\/zylos\/\.claude\/skills\/health-check\/scripts\/c4-groups-check\.js/);
  assert.match(machineTasks, /health-check skill c4-groups-check\.js helper; a non-zero exit is an issue/);
});
