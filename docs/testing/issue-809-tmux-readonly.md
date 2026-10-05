# Testing tmux read-only observer compatibility

Core uses `send-keys -c zylos-no-client` on tmux ≥ 3.4; older tmux keeps the
legacy arguments. `zylos doctor` reports the version and selected path. Unknown
versions retain legacy arguments and emit a one-time diagnostic per process.

Run the isolated Linux integration test with a chosen tmux binary:

```bash
ZYLOS_TEST_TMUX=/usr/local/bin/tmux node --test cli/lib/__tests__/tmux-readonly.integration.test.js
```

It uses a unique `-L` server and `/dev/null` config, attaches a read-only client
through util-linux `script`, asserts old Enter/Escape commands fail, then checks
that protected sends deliver raw CR/Escape bytes. Missing tmux, tmux < 3.7, and
non-Linux PTY environments explicitly skip; setup failures on supported Linux
with tmux ≥ 3.7 fail the test. It never attaches to an existing agent server.

Development versions such as `next-3.9` use their numeric major/minor for the gate.
OpenBSD OS-style versions such as `openbsd-7.6` are not mapped to an upstream tmux
version and remain explicitly unknown, using legacy arguments.
