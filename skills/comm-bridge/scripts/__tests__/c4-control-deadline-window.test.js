import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { enqueueSingleUpgradeExit, SINGLE_UPGRADE_CHECK_ACK_DEADLINE_SECONDS } from '../../../../cli/lib/request-runtime-restart.js';

const cli = fileURLToPath(new URL('../c4-control.js', import.meta.url));
const clock = fileURLToPath(new URL('./fixtures/second-boundary-clock.js', import.meta.url));
// The enqueue starts 1 ms before a whole second, so any second clock reading during it falls in the next second.
const START_SECONDS = 1_800_000_000;
const START_MS = START_SECONDS * 1000 + 999;

// Each case owns a private root as HOME and ZYLOS_DIR, so the CLI child opens only its own C4 database.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-deadline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'), TMPDIR: root,
    C4_TEST_CLOCK_START_MS: String(START_MS) };
  const enqueue = args => {
    const r = spawnSync(process.execPath, ['--import', clock, cli, 'enqueue', ...args, '--json'], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, true, r.stdout);
    return result.data;
  };
  const row = id => {
    const dbPath = path.join(root, 'comm-bridge/c4.db');
    assert.ok(dbPath.startsWith(root + path.sep));
    const db = new Database(dbPath, { readonly: true });
    try { return db.prepare('SELECT created_at, ack_deadline_at, available_at FROM control_queue WHERE id=?').get(id); }
    finally { db.close(); }
  };
  return { enqueue, row };
}

test('the single-session upgrade check keeps exactly its 60 second window when enqueue crosses a whole second', async t => {
  const { enqueue, row } = fixture(t);
  // The real producer's enqueue arguments; only the prompt text is fixed here.
  const { checkControlId } = await enqueueSingleUpgradeExit({ run: async args => enqueue(args), loadPrompt: async () => 'waiting-work check' });
  assert.equal(SINGLE_UPGRADE_CHECK_ACK_DEADLINE_SECONDS, 60);
  const check = row(checkControlId);
  assert.equal(check.ack_deadline_at - check.created_at, 60);
  assert.deepEqual(check, { created_at: START_SECONDS, ack_deadline_at: START_SECONDS + 60, available_at: null });
});

test('any --ack-deadline and --available-in enqueue measures both from the same reading as created_at', t => {
  const { enqueue, row } = fixture(t);
  const { id } = enqueue(['--content', 'deadline window', '--ack-deadline', '300', '--available-in', '5']);
  assert.deepEqual(row(id), { created_at: START_SECONDS, ack_deadline_at: START_SECONDS + 300, available_at: START_SECONDS + 5 });
});
