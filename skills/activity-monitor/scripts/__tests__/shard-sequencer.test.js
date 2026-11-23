import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  flagPath,
  flagRoot,
  sessionFlagDir,
  waitForFlag,
  writeFlag,
} from '../shard-sequencer.js';

const tmpDirs = [];

function makeTmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-seq-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('shard-sequencer flag chain', () => {

  it('sanitizes hostile session ids to a single segment under the flag root', () => {
    const tmpdir = makeTmpdir();
    const dir = sessionFlagDir('../../etc/passwd', { tmpdir });
    // Path separators are flattened, so the id cannot traverse out of the
    // flag root — it must resolve to a direct child directory.
    assert.equal(path.dirname(dir), flagRoot({ tmpdir }));
  });

});

describe('shard-sequencer session isolation (failure-mode case C/C\')', () => {
  // Isolation is a correctness requirement: the design experiments showed a
  // shared flag directory pre-planted with stale flags reverses the whole
  // chain (every wait returns instantly, order degrades to completion order,
  // memory shards land last). These tests pin the isolation behavior.

  it('a full stale flag set from another session is invisible: the real chain still waits', async () => {
    const tmpdir = makeTmpdir();
    // Pre-plant a complete flag set under a stale session directory.
    for (const name of ['identity', 'references', 'state', 'c4-checkpoint', 'c4-conversations']) {
      writeFlag('stale-session', name, { tmpdir });
    }

    // The real session must NOT see them: its wait times out (fail-open)
    // instead of returning instantly off the stale flags.
    const poisonedWait = await waitForFlag('real-session', 'identity', { deadlineMs: 100, pollMs: 10, tmpdir });
    assert.equal(poisonedWait.ok, false, 'stale flags from another session must not satisfy a wait');

    // And a real flag in the real session satisfies it normally.
    writeFlag('real-session', 'identity', { tmpdir });
    const realWait = await waitForFlag('real-session', 'identity', { deadlineMs: 100, pollMs: 10, tmpdir });
    assert.equal(realWait.ok, true);
  });

});

describe('shard-sequencer same-session re-trigger (compact keeps session_id)', () => {
  // Compact fires SessionStart with the SAME session_id as startup (verified
  // on a live Claude Code session, 2026-07-10), so per-session isolation does
  // not protect a second trigger: the startup round's flags would satisfy
  // every compact-round wait instantly and the chain would degrade to
  // completion order. Freshness is what closes that hole.

  function backdateFlag(sessionId, name, tmpdir, ageMs = 60 * 60 * 1000) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(flagPath(sessionId, name, { tmpdir }), past, past);
  }

  it('a previous round\'s full flag set in the SAME session does not satisfy waits', async () => {
    const tmpdir = makeTmpdir();
    // Round 1 (startup) completed: full flag set exists, aged past tolerance.
    for (const name of ['identity', 'references', 'state', 'c4-checkpoint', 'c4-conversations']) {
      writeFlag('sess-a', name, { tmpdir });
      backdateFlag('sess-a', name, tmpdir);
    }

    // Round 2 (compact, same session id): old flags must read as absent.
    const wait = await waitForFlag('sess-a', 'identity', { deadlineMs: 100, pollMs: 10, tmpdir });
    assert.equal(wait.ok, false, 'stale same-session flags must not satisfy a re-trigger wait');
  });

});

