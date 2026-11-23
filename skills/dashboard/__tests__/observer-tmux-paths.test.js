import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import { observerSocketRoot, mkdirPrivate } from '../src/lib/observer-tmux-state.js';
import { assertObserverTestIsolation } from './helpers/observer-isolation.js';

assertObserverTestIsolation();

// Canonical /private/tmp fixtures on macOS exceed the 16-byte root budget
// needed by these data-path and 103/104-byte boundary cases.
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'darwin'
  ? 'Requires a canonical fixture root <=16 bytes; macOS /private/tmp is too long' : false }, fn);

const nonce = '0123456789abcdef0123456789abcdef';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(fsSync.existsSync('/dev/shm') ? '/dev/shm' : '/tmp', 'o')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'd');
  const temporary = path.join(base, 't');
  for (const root of [dataDir, temporary]) await fs.mkdir(root, { mode: 0o700 });
  return { base, dataDir, temporary };
}

test('foreign directory ownership is refused without changing its mode', async t => {
  const f = await fixture(t);
  const parent = path.join(f.dataDir, 'observer', 'sockets');
  await mkdirPrivate(parent);
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async file => file === parent
    ? Object.assign(await lstat(file), { uid: process.getuid() + 1 }) : lstat(file));
  await assert.rejects(observerSocketRoot(f.dataDir, nonce), { code: 'unsafe_runtime_state' });
});
