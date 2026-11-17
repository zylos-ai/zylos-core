# Private tmux directories

When `TMUX_TMPDIR` is set, every Zylos tmux client selects its socket with
`-S`. The default path is `$TMUX_TMPDIR/tmux-<uid>/default`; named sockets
use the same private socket directory. Explicit socket paths remain explicit.

The configured directory must exist, be an absolute path owned by the current
user, grant its owner read/write/search access, and deny group/other writes.
Symlinks are rejected. Zylos prepares the `tmux-<uid>` child with mode `0700`
and requires an existing child to have those private permissions.

Validation runs before each client invocation. Missing directories report
`TMUX_DIR_MISSING`, invalid ownership/type/permissions report `TMUX_DIR_UNSAFE`,
and other filesystem failures report `TMUX_DIR_UNAVAILABLE`. These errors mean
the session cannot be observed; they never prove that a session is absent.
There is no retry on the default socket.

The dispatcher and activity monitor latch directory failure and record one
`tmux_directory_unavailable` diagnostic per process. The dispatcher stays
resident even when the directory is missing at startup, so a process manager
does not turn that failure into a restart loop. Restore the configured
directory with the correct owner and permissions, then deliberately restart
the affected services to resume scheduling. Restoring the directory alone does
not clear the latch. Installations without `TMUX_TMPDIR` retain their previous
socket selection.

Docker startup and shutdown use the same shared client policy. The entrypoint
checks before each stale-session stop, runtime launch and shutdown stop.

Real tmux validation must use a separate Unix user from every live Zylos
instance. Isolate `HOME`, `ZYLOS_DIR`, `PM2_HOME`, short `TMPDIR`, socket paths,
and any test database. The gated `test/tmux-directory.integration.test.js`
requires `ZYLOS_TMUX_DIRECTORY_INTEGRATION=1` and an independently verified
`ZYLOS_TEST_LIVE_UID` different from the test UID. It checks 15 product entry
calls against a dedicated-user default-server sentinel after private-directory
removal. It does not start the production dispatcher or activity monitor;
their live deletion/event-count acceptance and the baseline negative control
remain separate checks, alongside the matrix in `docs/tmux-matrix.md`.
