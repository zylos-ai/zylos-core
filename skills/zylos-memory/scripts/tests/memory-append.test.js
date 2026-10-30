import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryScope, withMemoryLock } from '../sync-lock.js';
import { appendInbox, appendSession } from '../memory-append.js';
const fixture = group => ({ ZYLOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'memory-append-')), ZYLOS_RUN_ID: 'run-1', ...(group ? { ZYLOS_SESSION_GROUP: group } : {}) });

test('group/global append, configured TZ dates, multiline session', async () => {
  for (const group of [undefined, 'lark:oc_b']) {
    const env = fixture(group);
    fs.writeFileSync(path.join(env.ZYLOS_DIR, '.env'), 'TZ=Asia/Singapore\n');
    const a = await appendInbox({ kind: 'decision', content: 'first\n', env }, { now: () => new Date('2026-10-10T15:59:00Z') });
    await appendInbox({ kind: 'fact', content: 'second', env }, { now: () => new Date('2026-10-10T16:01:00Z') });
    await appendInbox({ kind: 'commitment', content: 'third', env }, { now: () => new Date('2026-10-10T16:02:00Z') });
    assert.equal(fs.readFileSync(a.path, 'utf8'), '### 2026-10-10\n- 23:59 decision: first\n### 2026-10-11\n- 00:01 fact: second\n- 00:02 commitment: third\n');
    assert.equal(a.path.includes('session-groups'), Boolean(group));
    const s = await appendSession({ content: 'line1\nline2\n', env }, { now: () => new Date('2026-10-10T16:01:00Z') });
    assert.ok(s.path.endsWith('sessions/2026-10-11.md'));
    assert.equal(fs.readFileSync(s.path, 'utf8'), 'line1\nline2\n');
    assert.equal(fs.existsSync(path.join(path.dirname(s.path), 'current.md')), false);
  }
});

test('invalid records do not write; partial write rolls back under', async () => {
  const env = fixture('lark:oc_b');
  for (const content of ['', '\n', 'a\nb', 'a\r\nb', 'a\u2028b']) {
    await assert.rejects(appendInbox({ kind: 'fact', content, env }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(appendInbox({ kind: 'wrong', content: 'a', env }), { code: 'INVALID_INPUT' });
  await assert.rejects(appendInbox({ kind: 'fact', content: 'a', env: { ...env, ZYLOS_SESSION_GROUP: '../bad' } }), { code: 'SESSION_GROUP_INVALID' });
  const result = await appendInbox({ kind: 'fact', content: 'original', env });
  const before = fs.readFileSync(result.path);
  let writes = 0;
  const io = { ...fs, writeSync(fd, bytes, offset, length) {
    if (writes++ === 0) return fs.writeSync(fd, bytes, offset, Math.min(7, length));
    throw new Error('injected partial write');
  } };
  await assert.rejects(appendInbox({ kind: 'decision', content: 'will fail', env }, { io }), /injected partial write/);
  assert.deepEqual(fs.readFileSync(result.path), before);
});


// A P2-1 / DM F8: legacy and single writers of global memory share origin F8.
test('legacy global append contends on the same origin memory lock as single Sync', async () => {
  const env = fixture();
  const single = await memoryScope(env);
  const legacyEnv = { ZYLOS_DIR: env.ZYLOS_DIR };
  const legacy = await memoryScope(legacyEnv);
  assert.equal(legacy.runDir, single.runDir);
  assert.equal(legacy.memoryDir, single.memoryDir);
  await withMemoryLock(single.runDir, async () => {
    await assert.rejects(appendInbox({ kind: 'fact', content: 'blocked', env: legacyEnv, waitMs: 50 }), { code: 'LOCK_TIMEOUT' });
  });
  assert.equal(fs.existsSync(path.join(legacy.memoryDir, 'inbox.md')), false);
  await appendInbox({ kind: 'fact', content: 'after release', env: legacyEnv });
});

// session append needs only the final byte, not the entire daily log.
test('session append reads one trailing byte and preserves a missing newline', async () => {
  const env = fixture();
  const now = () => new Date('2026-10-10T12:00:00Z');
  const first = await appendSession({ content: 'first', env }, { now });
  fs.writeFileSync(first.path, 'older text');
  let reads = 0;
  const io = { ...fs, readFileSync() { assert.fail('must not read full session'); },
    readSync(fd, buffer, offset, length, position) {
      reads++; assert.equal(length, 1); assert.equal(position, 9);
      return fs.readSync(fd, buffer, offset, length, position);
    } };
  await appendSession({ content: 'next', env }, { now, io });
  assert.equal(reads, 1);
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'older text\nnext\n');
});
