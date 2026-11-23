import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readWorkMemory } from '../read-work-memory.js';

// Most cases inject a parser to isolate the snapshot contract; one uses below.
const lockModule = new URL('../../../skills/zylos-memory/scripts/sync-lock.js', import.meta.url).href;
const { withMemoryLock } = await import(lockModule);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id1 = '20261019T081500123Z', id2 = '20261019T091200456Z';
function fixture(t, grouped = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-control-work-memory-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_RUN_ID: 'read-1', TMPDIR: root };
  delete env.ZYLOS_SESSION_GROUP;
  if (grouped) env.ZYLOS_SESSION_GROUP = 'origin';
  const memory = path.join(root, 'memory', ...(grouped ? ['session-groups', 'origin'] : []));
  const run = path.join(root, 'activity-monitor', 'session-groups', 'origin');
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'state.md'), 'captured state\n');
  fs.writeFileSync(path.join(memory, 'inbox.md'), 'current inbox\n');
  fs.writeFileSync(path.join(memory, `inbox.${id2}.md`), 'second segment\n');
  fs.writeFileSync(path.join(memory, `inbox.${id1}.md`), 'first segment\n');
  const parseStateHeader = (_text, { scope }) => ({ valid: true, scope, coverage: 42, inboxCommitted: [id1] });
  return { root, env, memory, run, options: { env, withMemoryLock, parseStateHeader } };
}

test('same-lock snapshot excludes committed segments, hashes exact bytes and never changes source files', async t => {
  const f = fixture(t);
  const before = Object.fromEntries(fs.readdirSync(f.memory).map(name => [name, fs.readFileSync(path.join(f.memory, name))]));
  let held = false, parseHeld = false;
  const result = await readWorkMemory({ ...f.options,
    withMemoryLock: (run, action, options) => withMemoryLock(run, () => {
      held = true;
      try { return action(); } finally { held = false; }
    }, options),
    parseStateHeader: (text, options) => { parseHeld = held; return f.options.parseStateHeader(text, options); },
    readFile: file => { assert.equal(held, true); return fs.readFileSync(file); },
  });
  assert.equal(parseHeld, true);
  assert.equal(result.data.scope, 'origin');
  assert.deepEqual(result.data.segments.map(part => part.id), [id2]);
  assert.equal(result.data.state.sha256, sha(before['state.md']));
  assert.equal(result.data.state.bytes, before['state.md'].length);
  assert.match(result.data.text, /second segment/);
  assert.doesNotMatch(result.data.text, /first segment/);
  for (const [name, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(f.memory, name)), bytes);
});

test('rotate/commit waits until capture releases ; output uses its original snapshot', async t => {
  const f = fixture(t);
  let change;
  const result = await readWorkMemory({ ...f.options, readFile: file => {
    const bytes = fs.readFileSync(file);
    if (file.endsWith('state.md')) change = withMemoryLock(f.run, () => {
      fs.writeFileSync(path.join(f.memory, 'state.md'), 'new committed state');
      fs.writeFileSync(path.join(f.memory, 'inbox.md'), 'new inbox');
      fs.unlinkSync(path.join(f.memory, `inbox.${id2}.md`));
    });
    return bytes;
  } });
  await change;
  assert.match(result.data.text, /captured state/);
  assert.match(result.data.text, /current inbox/);
  assert.match(result.data.text, /second segment/);
  assert.doesNotMatch(result.data.text, /new committed state/);
});

test('large UTF-8 output spills the same captured bytes after unlocking', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.memory, 'state.md'), 'abc '.repeat(12000));
  let held = false;
  const result = await readWorkMemory({ ...f.options,
    withMemoryLock: async (run, action, options) => {
      const captured = await withMemoryLock(run, () => {
      held = true; try { return action(); } finally { held = false; }
      }, options);
      fs.writeFileSync(path.join(f.memory, 'state.md'), 'changed after capture');
      return captured;
    },
    readFile: file => {
      assert.equal(held, true, 'source reads must end before releasing F8');
      return fs.readFileSync(file);
    },
    writeFile: (file, bytes, options) => {
      assert.equal(held, false);
      return fs.writeFileSync(file, bytes, options);
    },
  });
  assert.ok(Buffer.byteLength(result.output) < 32768);
  const bytes = fs.readFileSync(result.data.spill.path);
  assert.equal(bytes.length, result.data.spill.bytes);
  assert.equal(sha(bytes), result.data.spill.sha256);
  const snapshot = JSON.parse(bytes).data;
  assert.match(snapshot.text, /abc abc/);
  assert.doesNotMatch(snapshot.text, /changed after capture/);
  assert.equal(snapshot.state.bytes, 48000);
  assert.equal(fs.statSync(result.data.spill.path).mode & 0o777, 0o600);
});

test('expired total budget, non-UTF-8 and spill failure never return partial success', async t => {
  const f = fixture(t);
  let clock = 0, reads = 0;
  await assert.rejects(readWorkMemory({ ...f.options, timeoutMs: 2100, now: () => clock,
    readFile: file => {
      reads++;
      const bytes = fs.readFileSync(file);
      if (file.endsWith('state.md')) clock = 2100;
      return bytes;
    },
  }), error => error.code === 'READ_FAILED' && error.parts.includes('snapshot'));
  assert.equal(reads, 1);
  await withMemoryLock(f.run, () => {}, { waitMs: 1000 });
  fs.writeFileSync(path.join(f.memory, 'inbox.md'), Buffer.from([0xff]));
  await assert.rejects(readWorkMemory(f.options), { code: 'READ_FAILED' });
  fs.writeFileSync(path.join(f.memory, 'inbox.md'), 'restored');
  fs.writeFileSync(path.join(f.memory, 'state.md'), 'x'.repeat(40000));
  await assert.rejects(readWorkMemory({ ...f.options, writeFile: () => { throw Error('disk full'); } }),
    error => error.code === 'READ_FAILED' && error.parts[0] === 'spill');
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('zylos-work-memory-')), false);
});

test('environment scope only, global and grouped reads cannot fall back across scopes', async t => {
  const global = fixture(t, false);
  assert.equal((await readWorkMemory(global.options)).data.scope, '*');
  delete global.env.ZYLOS_RUN_ID;
  assert.equal((await readWorkMemory(global.options)).data.scope, '*');
  const f = fixture(t);
  f.env.ZYLOS_SESSION_GROUP = '';
  await assert.rejects(readWorkMemory(f.options), { code: 'SCOPE_INVALID' });
  f.env.ZYLOS_SESSION_GROUP = 'origin';
  fs.unlinkSync(path.join(f.memory, 'state.md'));
  fs.mkdirSync(path.join(f.root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'memory/state.md'), 'wrong-scope secret marker');
  const result = await readWorkMemory(f.options);
  assert.equal(result.data.state.valid, false);
  assert.doesNotMatch(result.data.text, /wrong-scope/);
});
