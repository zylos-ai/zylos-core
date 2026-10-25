import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendInbox, appendSession } from '../memory-append.js';
const fixture = group => ({ ZYLOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'memory-append-')), ZYLOS_RUN_ID: 'run-1', ...(group ? { ZYLOS_SESSION_GROUP: group } : {}) });

test('IB-52 group/global append, configured TZ dates, multiline session', async () => {
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

test('IB-52 invalid records do not write; partial write rolls back under F8', async () => {
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

// P07 §4 residual-risk control: a writer bypassing F8 can append after the
// consumer read the renamed segment; that text is outside the guarantee.
test('unlocked open-before-rotation control demonstrates the documented loss window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-unlocked-control-'));
  const inbox = path.join(root, 'inbox.md'); const segment = path.join(root, 'inbox.segment.md');
  fs.writeFileSync(inbox, 'before\n');
  const fd = fs.openSync(inbox, 'a');
  try {
    fs.renameSync(inbox, segment);
    const consumed = fs.readFileSync(segment, 'utf8');
    fs.writeSync(fd, 'late-unlocked-record\n');
    fs.unlinkSync(segment);
    assert.equal(consumed, 'before\n');
    assert.equal(fs.existsSync(inbox), false); assert.equal(fs.existsSync(segment), false);
  } finally { fs.closeSync(fd); }
});
