import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKickVerifier } from '../kick-verify.js';

const KICK = '[ZYLOS_INTERNAL_SESSION_START] lifecycle=first_boot. Internal lifecycle trigger, not a human message.';
const SESSION = 'codex-main';
const PANE_PID = 100;

/**
 * Build a verifier over a fake process table with a virtual clock.
 * table: { [pid]: { ppid: number, argv: string[] } }
 * mutate(t) — optional hook called as virtual time advances, to change the
 * table mid-run (e.g. simulate a child exiting).
 */
function makeVerifier(table, { paneGone = false, mutate } = {}) {
  let t = 0;
  const clock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      if (mutate) mutate(t);
    },
  };
  const verifier = createKickVerifier({
    getPanePid: () => (paneGone ? 0 : PANE_PID),
    listChildPids: (pid) =>
      Object.entries(table)
        .filter(([, p]) => p.ppid === pid)
        .map(([childPid]) => parseInt(childPid, 10)),
    readArgv: (pid) => table[pid]?.argv ?? null,
    sleep: clock.sleep,
    now: clock.now,
  });
  return { verifier, clock, table };
}

describe('kick-verify', () => {
  it('confirms a surviving descendant whose argv carries the exact kick item', async () => {
    const { verifier } = makeVerifier({
      [PANE_PID]: { ppid: 1, argv: ['-bash'] },
      101: { ppid: PANE_PID, argv: ['node', '/x/tmux-launcher.js', '/tmp/spec.json'] },
      102: { ppid: 101, argv: ['codex', '--dangerously-bypass-approvals-and-sandbox', KICK] },
    });
    assert.equal(await verifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 5000 }), true);
  });

  it('fails when no kick-carrying process ever appears (missing CODEX_BIN)', async () => {
    const { verifier, clock } = makeVerifier({
      [PANE_PID]: { ppid: 1, argv: ['-bash'] },
    });
    assert.equal(await verifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 5000 }), false);
    assert.ok(clock.now() >= 5000, 'should poll until the deadline');
  });

  it('fails when the pane/session is gone (launcher died, session collapsed)', async () => {
    const { verifier } = makeVerifier({}, { paneGone: true });
    assert.equal(await verifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 2000 }), false);
  });

  it('rejects a child that spawns and exits before the confirmation re-check (broken CODEX_BIN)', async () => {
    const table = {
      [PANE_PID]: { ppid: 1, argv: ['-bash'] },
      102: { ppid: PANE_PID, argv: ['codex', KICK] },
    };
    const { verifier } = makeVerifier(table, {
      mutate: () => { delete table[102]; }, // gone by the first sleep
    });
    assert.equal(await verifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 3000 }), false);
  });

  it('requires the kick as one exact argv item, not a substring or a split pair', async () => {
    const { verifier } = makeVerifier({
      [PANE_PID]: { ppid: 1, argv: ['-bash'] },
      // Substring-similar: kick embedded in a larger single argument.
      103: { ppid: PANE_PID, argv: ['codex', `${KICK} --trailing-noise`] },
      // Split across two argv items.
      104: { ppid: PANE_PID, argv: ['codex', KICK.slice(0, 40), KICK.slice(40)] },
    });
    assert.equal(await verifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 1500 }), false);
  });

  it('ignores kick-carrying processes outside the target pane tree', async () => {
    const { verifier } = makeVerifier({
      [PANE_PID]: { ppid: 1, argv: ['-bash'] },
      // A stale codex from a previous launch, parented elsewhere.
      200: { ppid: 1, argv: ['codex', KICK] },
    });
    assert.equal(await verifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 1500 }), false);
  });

  it('accepts a joined-cmdline fallback entry only via containment', async () => {
    const { verifier } = makeVerifier({
      [PANE_PID]: { ppid: 1, argv: ['-bash'] },
    });
    // Simulate a non-/proc platform: readArgv returns { joined }.
    const { verifier: fallbackVerifier } = (() => {
      const table = {
        [PANE_PID]: { ppid: 1, argv: ['-bash'] },
        105: { ppid: PANE_PID, argv: null },
      };
      let t = 0;
      const v = createKickVerifier({
        getPanePid: () => PANE_PID,
        listChildPids: (pid) => (pid === PANE_PID ? [105] : []),
        readArgv: (pid) => (pid === 105 ? { joined: `codex ${KICK}` } : table[pid]?.argv ?? null),
        sleep: async (ms) => { t += ms; },
        now: () => t,
      });
      return { verifier: v };
    })();
    assert.equal(await verifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 1000 }), false);
    assert.equal(
      await fallbackVerifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 1000 }),
      true,
    );
  });

  it('recovers when a first child dies but a successor appears within the deadline', async () => {
    const table = {
      [PANE_PID]: { ppid: 1, argv: ['-bash'] },
      102: { ppid: PANE_PID, argv: ['codex', KICK] },
    };
    const { verifier } = makeVerifier(table, {
      mutate: (t) => {
        if (t >= 750 && table[102]) {
          delete table[102]; // first child dies at the confirm check
        }
        if (t >= 1000 && !table[106]) {
          table[106] = { ppid: PANE_PID, argv: ['codex', KICK] }; // stable successor
        }
      },
    });
    assert.equal(await verifier({ session: SESSION, kickPrompt: KICK, timeoutMs: 10_000 }), true);
  });
});
