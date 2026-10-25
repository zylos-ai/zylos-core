import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTmuxConnection, serverGeneration } from '../tmux-connection.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p02-guard-errors-'));
  const binary = path.join(dir, 'tmux');
  const mode = path.join(dir, 'mode');
  await fs.writeFile(mode, 'payload');
  await fs.writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
if (mode === 'permission') {
  process.stderr.write('error connecting to /tmp/no sessions/socket (Permission denied)\\n');
  process.exit(1);
}
if (!process.argv.includes('if-shell')) { console.log('123:456'); process.exit(0); }
if (mode === 'absent') { console.error('no server running on fixture'); process.exit(1); }
console.log('ZYLOS_OK');
if (mode === 'nonzero') { console.error('no server running on fixture'); process.exit(1); }
if (mode === 'stderr') { console.error('no server running on fixture'); process.exit(0); }
console.log('ZYLOS_STALE 999:1');
`, { mode: 0o700 });
  // The extensionless executable inherits no repository package metadata.
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { binary, mode, set: value => fs.writeFile(mode, value) };
}

for (const mode of ['nonzero', 'stderr']) test(`guard OK marker takes priority over no-server-like ${mode}`, async t => {
  const f = await fixture(t);
  const connection = await openTmuxConnection({ binary: f.binary });
  t.after(() => connection.close());
  connection.bindTarget({ serverGeneration: '123:456', tmuxSessionId: '$0', paneId: '%0' });
  await f.set(mode);
  await assert.rejects(connection.command(['display-message', '-p', 'x']), { code: 'TMUX_COMMAND_FAILED', cause: 'error' });
});

test('guard marker-looking payload remains data; genuine no-server response means target gone', async t => {
  const f = await fixture(t);
  const connection = await openTmuxConnection({ binary: f.binary });
  t.after(() => connection.close());
  connection.bindTarget({ serverGeneration: '123:456', tmuxSessionId: '$0', paneId: '%0' });
  assert.equal(await connection.command(['capture-pane', '-p', '-t', '%0']), 'ZYLOS_STALE 999:1');
  await f.set('absent');
  await assert.rejects(connection.command(['capture-pane', '-p', '-t', '%0']), { code: 'TARGET_GONE' });
});

test('no-server words in a socket path do not turn permission failure into absence', async t => {
  const f = await fixture(t);
  await f.set('permission');
  await assert.rejects(openTmuxConnection({ binary: f.binary }), { code: 'TMUX_UNAVAILABLE', cause: 'error' });
});

test('server generation maps command failures to unavailable while preserving timeout cause', async () => {
  for (const cause of ['error', 'timeout']) {
    await assert.rejects(serverGeneration({ command: async () => {
      throw Object.assign(new Error('generation probe failed'), { code: 'TMUX_COMMAND_FAILED', cause });
    } }), { code: 'TMUX_UNAVAILABLE', cause });
  }
  await assert.rejects(serverGeneration({ command: async () => {
    throw Object.assign(new Error('gone'), { code: 'TARGET_GONE' });
  } }), { code: 'TARGET_GONE' });
});
