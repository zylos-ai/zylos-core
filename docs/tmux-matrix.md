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
with every runtime test file. That runner isolates `HOME` and `ZYLOS_DIR`.
Choose `TMPDIR` before invocation if the host needs a specific temporary mount.

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
results. Both complete TAP logs are retained per version. Exit status is zero
only when all five runtime runs and all five control detections satisfy the
matrix. A zero stress metric is reported only after its corresponding exact
delivery, canary, churn, and server-generation assertions pass.
