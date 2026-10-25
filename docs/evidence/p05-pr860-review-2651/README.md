# B review corrections

- P2-1 / B3: exits trusts successful adapter.stop confirmation, removing the obsolete fixed-target read and synthetic expired-server input already removed in C. The real isolated fixture keeps a shell alive after its runtime child is killed, so the managed tmux session remains and cleanup must call stop. The old caller confirmation mutation fails this regression.
- P3-2 / T01: transition advances before serial lifecycle work. Manual/config work precedes exits/publication; reclamation follows publication. Both serial sections share the same round context and scene sample; mutations retain their authority and identity rechecks. A transition present at round start suppresses producers for the entire round even if it completes. The transition owner has its own serialization; exits/health likewise run outside held serial sections. Quiet reads remain once per authority/scene.
- P3-3 / B4: replacement after fence acquisition is preserved without calling stop; replacement after fresh observation makes the adapter return RUNID_MISMATCH and the old request completes with its fence cleared. Each new assertion detects its corresponding external mutation.

Focused official isolated Node runner: 4 files, 61 passed, no failures/skips. Run `node scripts/run-node-tests.js skills/activity-monitor/scripts/__tests__/supervisor-loop.test.js skills/activity-monitor/scripts/__tests__/supervisor-lifecycle.test.js skills/activity-monitor/scripts/__tests__/supervisor-exits.test.js skills/activity-monitor/scripts/__tests__/supervisor-exits.integration.test.js`.

External controls: `python3 run-mutants.py /path/to/checkout /path/to/disposable-output`. Mutations live only in disposable archived copies; three variants all fail the relevant positive tests. Independent selection and five-version matrix are recorded separately after parent integration.

After A integration: the 80-file independent selection passed (counts in selected.log). The B-only sessionId execution fixture no longer writes the removed F9 expectedSessionId field. Five-version matrix follows on this unchanged source.

Round-start transition restriction also survives mutation-time authority refresh inside advanceReclaim; the completion regression deliberately clears context.transition there. Final independent result: 805 passed, 1 opt-in skip, 0 failed. The first matrix attempt was stopped after 3.2a suite/stress completed to strengthen this guard; final matrix runs against the resulting frozen source.

## Final five-version validation

At implementation head `64210df`, tmux 3.2a / 3.3a / 3.4 / 3.7c / 3.8 pass all 246 runtime/applicable Supervisor tests and the real adapter stress. Each version completes 300 launch / 150 delivery rounds (604 launches, 600 sends, 1200 reads) with zero errors, server loss, foreign/missing lines or duplicates. External constant-true guard controls fail on every version as required. Source manifests match before/after; no product/test source changed during the final matrix.

The initial 3.4 suite had one existing `session-guard-contract` first-resolution-absent test fail with a tmux command timeout during concurrent matrix work. Its isolated official-entry rerun passes all 246 tests without code, timeout or assertion changes. Initial and retry logs and summary are retained in `matrix/`. The 3.2a stress summary's outer elapsed time includes an intentional orchestrator pause while another agent benchmarked; actual stress test duration is in its test log, and matrix durations are not performance claims.

Full repository Node/Jest and native macOS were not rerun on B in this revision. C's composed/full results and afterRound benchmark are separate evidence; fixtures do not establish downstream business-chain acceptance.
