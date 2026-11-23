# Testing tmux read-only observer compatibility

Core uses `send-keys -c zylos-no-client` on tmux ≥ 3.4; older tmux keeps the
legacy arguments. `zylos doctor` reports the version and selected path. Unknown
versions retain legacy arguments and emit a one-time diagnostic per process.

Run the version-gate regression test:

```bash
node scripts/run-node-tests.js cli/lib/__tests__/tmux-send-keys.test.js
```

The test uses a stubbed tmux command to check that Enter and Escape add the
read-only-client protection on supported versions and use legacy arguments on
older ones. It does not launch tmux or attach to a server.

Development versions such as `next-3.9` use their numeric major/minor for the gate.
OpenBSD OS-style versions such as `openbsd-7.6` are not mapped to an upstream tmux
version and remain explicitly unknown, using legacy arguments.
