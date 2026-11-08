# Observer control endpoint

Dashboard publishes its pre-uninstall control socket in
`<os.tmpdir()>/zobs-<uid>/zobs-ctl-<data-directory-hash>.sock`. The hash uses the
canonical data directory. The directory must belong to the current Unix user,
have no group/other permissions, and have no symlink ancestors after resolving
the temporary root. Newly created directories are 0700; the socket is 0600.
Unsafe existing directories are rejected, never repaired or followed.

Socket paths must be less than 104 bytes (including multibyte characters, leaving
room for the terminating NUL on macOS as well as Linux). If the temporary path
is too long, Dashboard uses `<dataDir>/observer/runtime/control/control.sock`.
If that is also too long it reports `control_socket_path_too_long`: configure a
shorter TMPDIR for Dashboard and the uninstall client, then restart Dashboard.
It never silently falls back to a shared, hardcoded `/tmp` location.

## Upgrade and ownership

Earlier releases publish `/tmp/zobs-ctl-<hash>.sock`. The new client does not
probe that shared path, and old clients cannot discover the new socket. Restart
Dashboard after upgrading before invoking online uninstall. New processes must
use the same temporary root (or both select the data-directory fallback).

An unreachable endpoint is not evidence that its producer is absent. Both
releases use the same permanent `coordinator-lock.sqlite` inode and exclusive
transaction in the data control directory. A new producer cannot start while an
old one owns it. An uninstall client that cannot discover the producer attempts
offline ownership, waits up to 15 seconds, then reports `coordinator_active`
without teardown. This applies in both upgrade directions and to mismatched
TMPDIR values. Once the owner exits, a successor may acquire the same mutex.
Older directory-based `coordinator.lock` state still requires explicit recovery.

The control server removes its published socket on close. It does not remove
pre-upgrade sockets or other processes' resources. An empty per-user temporary
directory may remain for reuse.
