import assert from 'node:assert/strict';
import test from 'node:test';
import { command, processSnapshot } from '../src/lib/observer-tmux-state.js';

const row = '123 1 Sun Sep 27 12:00:00 2026 S /test/worker ';
const commandLine = 'x'.repeat(1024);
const output = `${row}${commandLine}\n`.repeat(256);

test('process snapshot parses inventories larger than the general command limit', async () => {
  assert.ok(Buffer.byteLength(output) > 128 * 1024);
  const snapshot = await processSnapshot(async (file, args, options) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-axo', 'pid=,ppid=,lstart=,stat=,command=']);
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    return { stdout: output };
  });
  assert.equal(snapshot.length, 256);
  assert.equal(snapshot[255].command, `/test/worker ${commandLine}`);
  assert.equal(snapshot[255].pid, 123);
});

test('snapshot buffer override survives real subprocess IO while ordinary commands stay bounded', async () => {
  const script = `process.stdout.write((${JSON.stringify(row)} + 'x'.repeat(1024) + '\\n').repeat(256))`;
  const snapshot = await processSnapshot((_file, _args, options) => command(process.execPath, ['-e', script], options));
  assert.equal(snapshot.length, 256);
  await assert.rejects(command(process.execPath, ['-e', script]), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  await assert.rejects(processSnapshot((_file, _args, options) =>
    command(process.execPath, ['-e', script], { ...options, maxBuffer: 128 * 1024 })),
  { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
});
