import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from '../skills/comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { readConfigStrict } from '../cli/lib/config-store.js';
import { C4Reader } from '../skills/dashboard/src/lib/c4-reader.js';
import { createGroupBacklog } from '../skills/dashboard/src/lib/workbench/group-backlog.js';

// Cross-module: the Dashboard's group reader against Core's own commands over the same private instance
// (`c4-db.js unsummarized` and `sync-lock.js status`, run as real child processes with ZYLOS_DIR set to a
// temporary directory). Run under the official runner (private HOME, ZYLOS_DIR, PM2_HOME, TMPDIR and
// TMUX_TMPDIR, so no tmux server is reachable). Teardown removes the directory.
// Run when the Dashboard backlog reader, Core's unsummarized calculation or `sync-lock.js status` changes;
// skip for presentation-only Dashboard changes.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

function instance(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-core-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.symlinkSync(path.join(repo, 'skills'), path.join(root, '.claude/skills'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify(config));
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  guardDatabase(db, c4Schema);
  const reader = new C4Reader(root);
  t.after(() => { reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const env = { ...process.env, ZYLOS_DIR: root };
  delete env.ZYLOS_SESSION_GROUP; delete env.ZYLOS_RUN_ID;
  const groupBacklog = createGroupBacklog({ zylosDir: root, c4Reader: reader, env,
    readConfig: () => readConfigStrict(path.join(root, '.zylos/config.json')), getSnapshot: async () => ({ view: config.session_mode }) });
  const core = async (...args) => JSON.parse((await run(process.execPath, [path.join(repo, 'skills/comm-bridge/scripts/c4-db.js'), 'unsummarized', ...args, '--json'], { env })).stdout).data;
  return { root, db, groupBacklog, core };
}

// One history for both modes: a global baseline checkpoint, Origin with its own checkpoint, a group whose
// undelivered inbound message cuts its range short, a group with only outbound replies and an empty group.
function seed(db) {
  const put = db.prepare('INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group,timestamp) VALUES(?,?,?,?,?,?,?,?)');
  const rows = [
    [1, 'in', 'telegram', 'a', 'old', 'delivered', 'telegram:a', '2026-11-01 08:00:00'],
    [2, 'in', 'telegram', 'o', 'old', 'delivered', 'origin', '2026-11-01 08:05:00'],
    [3, 'in', 'telegram', 'o', 'covered', 'delivered', 'origin', '2026-11-02 09:00:00'],
    [4, 'out', 'telegram', 'o', 'reply', 'delivered', 'origin', '2026-11-02 09:01:00'],
    [5, 'in', 'telegram', 'a', 'new', 'delivered', 'telegram:a', '2026-11-03 10:00:00'],
    [6, 'in', 'telegram', 'o', 'new', 'delivered', 'origin', '2026-11-03 10:30:00'],
    [7, 'in', 'telegram', 'a', 'waiting', 'pending', 'telegram:a', '2026-11-03 11:00:00'],
    [8, 'in', 'telegram', 'a', 'after the gap', 'delivered', 'telegram:a', '2026-11-03 11:05:00'],
    [9, 'out', 'telegram', 'b', 'reply', 'delivered', 'telegram:b', '2026-11-03 12:00:00'],
    [10, 'in', 'telegram', 'o', 'newest', 'delivered', 'origin', '2026-11-03 12:30:00'],
  ];
  for (const row of rows) put.run(...row);
  const checkpoint = db.prepare("INSERT INTO checkpoints(summary,start_conversation_id,end_conversation_id,session_group,no_content) VALUES('s',?,?,?,0)");
  checkpoint.run(1, 2, '*');
  checkpoint.run(3, 4, 'origin');
}

for (const mode of ['multi', 'single']) {
  test(`counts and oldest times match c4-db.js unsummarized for each group in ${mode} mode`, { timeout: 30000 }, async t => {
    const f = instance(t, { session_mode: mode });
    seed(f.db);
    const groups = ['origin', 'telegram:a', 'telegram:b', 'telegram:empty'];
    // In the single view Origin is the whole machine, which Core reads without --group.
    const reads = await f.groupBacklog.many(groups);
    for (const [index, group] of groups.entries()) {
      const expected = group === 'origin' && mode === 'single' ? await f.core() : await f.core('--group', group);
      assert.deepEqual([reads[index].count, reads[index].firstAt], [expected.count, expected.firstAt], group);
    }
    if (mode === 'multi') {
      assert.deepEqual(reads.map(read => read.count), [2, 1, 1, 0], 'the cases differ: baseline, own checkpoint, gap, outbound only, empty');
    }
    assert.ok(reads.every(read => read.syncing === false && !read.reason), 'no marker, no Sync');
  });
}

test('Core\'s single-mode Origin range (an Origin conversation in single mode) matches the reader when the view is multi', { timeout: 30000 }, async t => {
  // The config says single while the snapshot view says multi: Core's Origin range still reads the config.
  const f = instance(t, { session_mode: 'single' });
  seed(f.db);
  const multiView = createGroupBacklog({ zylosDir: f.root, c4Reader: new C4Reader(f.root),
    readConfig: () => readConfigStrict(path.join(f.root, '.zylos/config.json')), getSnapshot: async () => ({ view: 'multi' }) });
  const [origin] = await multiView.many(['origin']);
  const expected = await f.core('--group', 'origin');
  assert.deepEqual([origin.count, origin.firstAt], [expected.count, expected.firstAt]);
});

test('a Sync marker that has expired or belongs to an earlier run shows as not syncing, through sync-lock.js status', { timeout: 30000 }, async t => {
  const f = instance(t, { session_mode: 'multi' });
  seed(f.db);
  const now = Date.now();
  for (const [group, marker] of [
    ['telegram:a', { runId: 'run-1', kind: 'group', token: 'a'.repeat(32), expiresAt: now - 1000 }],
    ['telegram:b', { runId: 'earlier-run', kind: 'group', token: 'b'.repeat(32), expiresAt: now + 1800000 }],
  ]) {
    fs.mkdirSync(path.join(f.root, 'activity-monitor/session-groups', group), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'activity-monitor/session-groups', group, 'sync.lock'), JSON.stringify(marker));
  }
  const reads = await f.groupBacklog.many(['telegram:a', 'telegram:b', 'origin']);
  assert.deepEqual(reads.map(read => [read.syncing, read.reason ?? null]), [[false, null], [false, null], [false, null]]);
});
