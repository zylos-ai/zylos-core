# tmux compatibility matrix

Run from a checkout with its test dependencies already provisioned. Node.js 20+
and five executable tmux binaries are required. The script never installs or
downloads tmux. Each binary must report its exact requested version with `-V`.

```sh
node scripts/run-tmux-matrix.js --output /absolute/path/to/new-evidence-directory \
  3.2a=/path/to/tmux-3.2a/tmux \
  3.3a=/path/to/tmux-3.3a/tmux \
  3.4=/path/to/tmux-3.4/tmux \
  3.7c=/path/to/tmux-3.7c/tmux \
  3.8=/path/to/tmux-3.8/tmux
```

The output directory must not exist. Existing evidence is never overwritten.
For each version the script puts a symlink named `tmux` first on `PATH`, sets
`TEST_TMUX_BIN`, and invokes the official `scripts/run-node-tests.js` runner
with every runtime test file and these real tmux caller suites:

- `skills/comm-bridge/scripts/__tests__/router-delivery-tmux.test.js`
- `cli/lib/__tests__/session-group-paths.test.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-tmux-stress.test.js`

That runner isolates `HOME` and `ZYLOS_DIR`.
Choose `TMPDIR` before invocation if the host needs a specific temporary mount.

The matrix sets `ZYLOS_TMUX_CHURN_STRESS=1` for both the normal adapter churn
fixture and its known-bad control. Without that explicit opt-in, both tests in
`session-adapter-churn.test.js` skip during ordinary full-suite runs. It also
sets the existing `P05_TMUX_STRESS=1` opt-in, fixes `P05_LAUNCH_ROUNDS=300` and
`P05_DELIVERY_ROUNDS=150`, and records `P05_STRESS_RESULT` separately for each
version. The supervisor fixture performs two launches per launch round and
four delivery lanes, exercising the shared session reader as well as the adapter.

The stress fixture uses real `SessionAdapter.launch`, `sendText`, and `sendKeys`
calls on one private socket. It performs 300 launch/kill rounds, 150 deliveries,
and concurrent session create/kill churn. A receiver records exact raw bytes;
a second recorder detects delivery to the wrong pane. Server generation must
remain unchanged. Startup is attempted once, so crashes cannot be hidden by
retrying server creation.

Each version also runs the same stale-generation fixture with the production
guard condition replaced by constant true in a temporary module copy. It must
fail with both the expected generation rejection and the incorrectly delivered
`stale-message` visible in its assertion output. The normal fixture first
revalidates, then replaces the server before the guarded send, preserving the
real check/send race. A replacement recorder is explicitly checked with a
control write when the correct guard rejects the stale send.

`summary.json` records source and binary SHA-256 hashes, checkout HEAD, Node
version, full test selection, subprocess statuses, stress metrics, and control
results, including supervisor stress metrics. Both complete TAP logs and the
supervisor metrics JSON are retained per version. Exit status is zero
only when all five runtime runs and all five control detections satisfy the
matrix, including both enabled stress fixtures. A zero stress metric is reported
only after its corresponding exact delivery, canary, churn, and server-generation
assertions pass.
