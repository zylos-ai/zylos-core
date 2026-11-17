import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../router/scheduler.js';

test('directory loss pauses dispatcher rounds and records exactly one event', async t => {
  const previous = process.env.TMUX_TMPDIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-router-'));
  process.env.TMUX_TMPDIR = path.join(root, 'missing');
  t.after(() => { if (previous === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true }); });
  let calls = 0; const events = [];
  const unexpected = () => { calls++; throw Error('scheduling must pause'); };
  const deps = Object.fromEntries(['readSessionMode','readLiveIdentities','readLiveIdentity','readCurrentSession',
    'listGroupTmuxSessions','readRuntimeHealth','getSessionAdapter','submit','deliverControl','deliverConversation',
    'handleExpired','prepareSingle','findLegacySessions','advanceLegacy'].map(name => [name, unexpected]));
  deps.db = {}; deps.diagnostic = (event, fields) => events.push({ event, ...fields });
  const router = createRouter(deps, { poolSize: () => 1 });
  t.after(() => router.stop());
  router.state.ready = true;
  for (let i = 0; i < 100; i++) router.tick();
  await router.start();
  assert.equal(calls, 0); assert.equal(router.state.round, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'tmux_directory_unavailable');
  assert.equal(events[0].reason, 'TMUX_DIR_MISSING');
});
