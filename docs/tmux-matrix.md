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

That runner isolates `HOME` and `ZYLOS_DIR`.
Choose `TMPDIR` before invocation if the host needs a specific temporary mount.

`summary.json` records source and binary SHA-256 hashes, checkout HEAD, Node
version, full test selection and subprocess statuses. The complete TAP log is
retained per version. Exit status is zero only when the runs for all five
versions pass every selected test.
