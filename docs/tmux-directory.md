# Private tmux directories

When `TMUX_TMPDIR` is nonempty, every Zylos tmux client selects its socket with
`-S`. The root is resolved through `realpath`; the default path is
`<resolved-root>/tmux-<uid>/default`; named sockets
use the same private socket directory. Explicit socket paths remain explicit.

The configured root must be an absolute path resolving to an existing directory.
Root symlinks, group-writable roots and system-owned roots such as `/tmp` are
accepted. Unlike tmux, relative roots are rejected because services with different
working directories would otherwise select different sockets. Zylos prepares the `tmux-<uid>` child with
mode `0700`. An existing child must be a directory owned by the current user
and have no other permission bits (`mode & 0007` must be zero); group permissions
are allowed. A child symlink is not a directory for this check.

Validation runs before each client invocation. Missing directories report
`TMUX_DIR_MISSING`, invalid ownership/type/permissions report `TMUX_DIR_UNSAFE`,
and other filesystem failures report `TMUX_DIR_UNAVAILABLE`. These errors mean
the session cannot be observed; they never prove that a session is absent.
There is no retry on the default socket.

The dispatcher and activity monitor latch directory failure and record one
`tmux_directory_unavailable` diagnostic per process. The dispatcher stays
resident even when the directory is missing at startup, so a process manager
does not turn that failure into a restart loop. Restore the configured
root and a valid socket child directory, then deliberately restart
the affected services to resume scheduling. Restoring the directory alone does
not clear the latch. An empty or unset `TMUX_TMPDIR` retains the previous socket
selection and performs no private-directory validation.

Real tmux validation must use a separate Unix user from every live Zylos
instance. Isolate `HOME`, `ZYLOS_DIR`, `PM2_HOME`, short `TMPDIR`, socket paths,
and any test database. Missing-directory rejection before client execution is
covered by `cli/lib/runtime/__tests__/tmux-directory.test.js`. Real service
deletion/event-count acceptance and the baseline negative control remain separate checks,
alongside the matrix in `docs/tmux-matrix.md`.
