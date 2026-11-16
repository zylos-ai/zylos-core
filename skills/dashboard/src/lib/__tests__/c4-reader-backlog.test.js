import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../../../comm-bridge/scripts/sqlite-schema.js';
import * as owner from '../../../../comm-bridge/scripts/c4-schema.js';
import { C4Reader } from '../c4-reader.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
import { createGroupBacklog } from '../workbench/group-backlog.js';

test('historical backlog reads real checkpoint coverage and pending frontier without scope commands', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-backlog-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const db = new Database(path.join(root, 'comm-bridge', 'c4.db'));
  guardDatabase(db, owner);
  const reader = new C4Reader(root), group = 'telegram:运维群-测试';
  const currentRoot = path.join(root, 'current'), currentGroup = 'telegram:current';
  fs.mkdirSync(path.join(currentRoot, 'comm-bridge'), { recursive: true });
  const currentDb = new Database(path.join(currentRoot, 'comm-bridge', 'c4.db'));
  guardDatabase(currentDb, owner);
  const currentReader = new C4Reader(currentRoot), core = createStore(currentDb);
  const compareCore = () => {
    const { count, firstAt } = core.getUnsummarizedRange(currentGroup);
    assert.deepEqual(currentReader.getGroupBacklog(currentGroup), { count, firstAt });
    assert.deepEqual(reader.getGroupBacklog(group), { count, firstAt });
  };
  t.after(() => { currentReader.close(); currentDb.close(); reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const insert = 'INSERT INTO conversations(id,direction,channel,content,status,session_group,timestamp) VALUES(?,?,?,?,?,?,?)';
  const seed = db.prepare(insert), currentSeed = currentDb.prepare(insert);
  for (const [id, key, status] of [[5, group, 'delivered'], [15, group, 'delivered'], [16, 'telegram:other', 'delivered'],
    [18, group, 'delivered'], [20, group, 'pending'], [22, group, 'delivered']]) {
    seed.run(id, 'in', 'telegram', 'private fixture', status, key, `2026-11-01 00:00:${id}`);
    currentSeed.run(id, 'in', 'telegram', 'private fixture', status, key === group ? currentGroup : key, `2026-11-01 00:00:${id}`);
  }
  const checkpoint = db.prepare("INSERT INTO checkpoints(summary,end_conversation_id,session_group,no_content) VALUES('fixture',?,?,0)");
  // Latest global checkpoint, rather than maximum global end; maximum group end.
  checkpoint.run(30, '*'); checkpoint.run(8, '*');
  checkpoint.run(12, group); checkpoint.run(10, group);
  const currentCheckpoint = currentDb.prepare("INSERT INTO checkpoints(summary,end_conversation_id,session_group,no_content) VALUES('fixture',?,?,0)");
  currentCheckpoint.run(30, '*'); currentCheckpoint.run(8, '*');
  currentCheckpoint.run(12, currentGroup); currentCheckpoint.run(10, currentGroup);
  let now = 0, commands = 0;
  const backlog = createGroupBacklog({ zylosDir: root, c4Reader: reader, now: () => now,
    runC4Db: async () => { commands++; throw new Error('Legacy names must not enter Core scope validation'); },
    execute: async () => { commands++; throw new Error('Legacy names must not enter filesystem scope validation'); } });
  assert.deepEqual(await backlog(group), { count: 2, firstAt: '2026-11-01 00:00:15', syncing: null, reason: 'backlog_failed' });
  compareCore();
  assert.equal(reader._db.readonly, true);
  db.prepare("UPDATE conversations SET status='failed' WHERE id=20").run();
  currentDb.prepare("UPDATE conversations SET status='failed' WHERE id=20").run();
  now += 30001;
  assert.deepEqual(await backlog(group), { count: 3, firstAt: '2026-11-01 00:00:15', syncing: null, reason: 'backlog_failed' });
  compareCore();
  checkpoint.run(22, '*'); currentCheckpoint.run(22, '*'); now += 30001;
  assert.deepEqual(await backlog(group), { count: 0, firstAt: null, syncing: null, reason: 'backlog_failed' });
  compareCore();
  assert.equal(commands, 0);
});
