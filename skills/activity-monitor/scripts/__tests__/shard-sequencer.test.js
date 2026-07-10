import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  DEFAULT_FLAG_FRESH_TOLERANCE_MS,
  DEFAULT_T_LINK_MS,
  defaultFreshAfterMs,
  flagFreshToleranceMs,
  flagPath,
  flagRoot,
  ladderDeadlineMs,
  perUserSuffix,
  sessionFlagDir,
  sweepStaleFlags,
  tLinkMs,
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

describe('shard-sequencer ladder deadlines', () => {
  it('gives shard k (1-based) a (k-1) x T_LINK wait budget', () => {
    assert.equal(ladderDeadlineMs(0, 1000), 0);
    assert.equal(ladderDeadlineMs(1, 1000), 1000);
    assert.equal(ladderDeadlineMs(4, 1000), 4000);
    assert.equal(ladderDeadlineMs(4, 250), 1000);
  });

  it('reads T_LINK from the environment with a 1s default', () => {
    assert.equal(tLinkMs({}), DEFAULT_T_LINK_MS);
    assert.equal(tLinkMs({ ZYLOS_SHARD_T_LINK_MS: '250' }), 250);
    assert.equal(tLinkMs({ ZYLOS_SHARD_T_LINK_MS: 'nonsense' }), DEFAULT_T_LINK_MS);
    assert.equal(tLinkMs({ ZYLOS_SHARD_T_LINK_MS: '-5' }), DEFAULT_T_LINK_MS);
  });
});

describe('shard-sequencer flag chain', () => {
  it('wait resolves once the predecessor flag lands', async () => {
    const tmpdir = makeTmpdir();
    const pending = waitForFlag('sess-a', 'identity', { deadlineMs: 2000, pollMs: 10, tmpdir });
    setTimeout(() => writeFlag('sess-a', 'identity', { tmpdir }), 60);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.ok(result.waitedMs >= 40, `waited ${result.waitedMs}ms, expected a real wait`);
  });

  it('wait fails open at the deadline when the predecessor never flags (crash mode)', async () => {
    const tmpdir = makeTmpdir();
    const result = await waitForFlag('sess-a', 'identity', { deadlineMs: 120, pollMs: 10, tmpdir });
    assert.equal(result.ok, false);
    assert.ok(result.waitedMs >= 120);
  });

  it('sanitizes hostile session ids to a single segment under the flag root', () => {
    const tmpdir = makeTmpdir();
    const dir = sessionFlagDir('../../etc/passwd', { tmpdir });
    // Path separators are flattened, so the id cannot traverse out of the
    // flag root — it must resolve to a direct child directory.
    assert.equal(path.dirname(dir), flagRoot({ tmpdir }));
  });

  it('keys the flag root per user so multi-user hosts cannot collide on a shared /tmp root', () => {
    // A fixed root name is created 0755 by the first user and is then
    // unwritable for every other user — flag writes fail silently and the
    // chain degrades to completion order. The suffix pins per-user roots.
    const tmpdir = makeTmpdir();
    const suffix = perUserSuffix();
    assert.ok(suffix.length > 0 && !/[/\\]/.test(suffix));
    assert.equal(flagRoot({ tmpdir }), path.join(tmpdir, `zylos-shard-flags-${suffix}`));
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

  it('documents the broken-isolation fingerprint: same-directory stale flags short-circuit to WAIT=ok:0', async () => {
    const tmpdir = makeTmpdir();
    // This is case C' — what happens WHEN isolation is broken (both runs
    // keyed to the same directory). Every wait returns instantly; the
    // all-zero waitedMs pattern is the diagnostic fingerprint.
    writeFlag('shared', 'identity', { tmpdir });
    const result = await waitForFlag('shared', 'identity', { deadlineMs: 1000, pollMs: 10, tmpdir });
    assert.equal(result.ok, true);
    assert.ok(result.waitedMs <= 20, `expected instant (poisoned) wait, got ${result.waitedMs}ms`);
  });

  it('flags for the same shard name are distinct files per session', () => {
    const tmpdir = makeTmpdir();
    assert.notEqual(
      flagPath('sess-a', 'identity', { tmpdir }),
      flagPath('sess-b', 'identity', { tmpdir })
    );
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

  it('the predecessor\'s rewrite this round bumps mtime and unblocks the wait', async () => {
    const tmpdir = makeTmpdir();
    writeFlag('sess-a', 'identity', { tmpdir });
    backdateFlag('sess-a', 'identity', tmpdir);

    const pending = waitForFlag('sess-a', 'identity', { deadlineMs: 2000, pollMs: 10, tmpdir });
    setTimeout(() => writeFlag('sess-a', 'identity', { tmpdir }), 60);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.ok(result.waitedMs >= 40, `waited ${result.waitedMs}ms, expected a real wait until the rewrite`);
  });

  it('an explicit freshAfterMs cutoff overrides the process-start default', async () => {
    const tmpdir = makeTmpdir();
    writeFlag('sess-a', 'identity', { tmpdir });
    const future = Date.now() + 60_000;
    const rejected = await waitForFlag('sess-a', 'identity', {
      deadlineMs: 80, pollMs: 10, tmpdir, freshAfterMs: future,
    });
    assert.equal(rejected.ok, false, 'a flag older than the cutoff must not count');

    const accepted = await waitForFlag('sess-a', 'identity', {
      deadlineMs: 80, pollMs: 10, tmpdir, freshAfterMs: 0,
    });
    assert.equal(accepted.ok, true);
  });

  it('reads the freshness tolerance from the environment with a sane default', () => {
    assert.equal(flagFreshToleranceMs({}), DEFAULT_FLAG_FRESH_TOLERANCE_MS);
    assert.equal(flagFreshToleranceMs({ ZYLOS_SHARD_FLAG_FRESH_TOLERANCE_MS: '250' }), 250);
    assert.equal(flagFreshToleranceMs({ ZYLOS_SHARD_FLAG_FRESH_TOLERANCE_MS: '0' }), 0);
    assert.equal(flagFreshToleranceMs({ ZYLOS_SHARD_FLAG_FRESH_TOLERANCE_MS: 'nonsense' }), DEFAULT_FLAG_FRESH_TOLERANCE_MS);
    assert.equal(flagFreshToleranceMs({ ZYLOS_SHARD_FLAG_FRESH_TOLERANCE_MS: '-5' }), DEFAULT_FLAG_FRESH_TOLERANCE_MS);
    // The default cutoff sits at or before "now": process start minus tolerance.
    assert.ok(defaultFreshAfterMs() <= Date.now());
  });
});

describe('shard-sequencer TTL sweep', () => {
  it('removes expired session directories and keeps fresh ones', () => {
    const tmpdir = makeTmpdir();
    writeFlag('old-session', 'identity', { tmpdir });
    writeFlag('fresh-session', 'identity', { tmpdir });
    const oldDir = sessionFlagDir('old-session', { tmpdir });
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(oldDir, past, past);

    const removed = sweepStaleFlags({ ttlMs: 60 * 60 * 1000, tmpdir });

    assert.equal(removed, 1);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(sessionFlagDir('fresh-session', { tmpdir })), true);
  });

  it('is a no-op when the flag root does not exist', () => {
    const tmpdir = makeTmpdir();
    assert.equal(sweepStaleFlags({ tmpdir }), 0);
  });
});
