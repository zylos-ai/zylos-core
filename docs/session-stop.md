# Stop one verified tmux target

`SessionAdapter.stop({tmuxName, expectedRunId})` manages only the target tmux
session. An explicitly absent target, including no server, succeeds. A present
target must match its run ID and retain the same connection, server generation,
session and pane binding before an exact session-ID kill. Historical targets
without a run ID may be stopped with `expectedRunId: null`.

Success means that the original tmux object is confirmed absent. A successful
kill acknowledgement for that exact ID is removal evidence even if killing the
last session closes the control client. Otherwise a session-ID snapshot on the
original held connection must omit it. Failed commands, unobservable state,
replacement identities, a remaining target or an unconfirmed disconnect remain
errors. Stop never reconnects to act on a same-name replacement.

Process environments are not lifecycle ownership. A service started by an agent
may inherit its run ID and outlive its tmux session. Stop does not enumerate
such environments, pin processes, send TERM/KILL, delay for descendant cleanup,
or require every runtime/descendant to exit. It requires no native process-signal
helper, compiler or architecture-specific distribution artifact. The process
image observer used by launch/isRunning is retained for those separate checks.

Callers must pass the explicit target and await the operation before releasing
their occupancy/recovery state. A rejected stop keeps that state pending. Success
does not authorize a caller to add inherited-environment cleanup or require
unrelated services to exit. This interface does not revive the retired fixed-name
adapter factory or supply a guessed target for old argument-free call sites.

## Verification

In a combined checkout, use the normal Node runner:

```sh
node scripts/run-node-tests.js \
  cli/lib/runtime/__tests__/session-stop-boundary.test.js \
  cli/lib/runtime/__tests__/session-stop-live.test.js \
  cli/lib/runtime/__tests__/session-stop-target-races.test.js \
  cli/lib/runtime/__tests__/legacy-stop-matrix.test.js
```

In a split adapter checkout, set `P02_REAL_A_ROOT` to the actual A provider and
`P02_REQUIRE_REAL_P01=1`. No parser fixture is registered. The real tmux suites
use private sockets and controlled processes. They check present/absent/no-server
targets, historical null IDs, mismatches, same-name and server replacements,
command failure, an unconfirmed disconnect and final-session removal. Independent
same-run services have their PID/start identity and continuing heartbeat checked
after stop; the outside Origin target is preserved. The server-replacement case
deliberately rebuilds only its private fixture server and checks the new server's
targets remain untouched by the stale adapter connection.

The optional `test/integration/runtime/stop-tmux-native.mjs` smoke requires an
explicit real Claude/Codex CLI path, a fresh private PID/network namespace,
temporary HOME/config roots, sanitized credential-free environment and UTF-8
locale. It observes the real CLI executable/argv during interactive startup,
calls the actual runtime adapter stop, and checks the target and independent
service. It is not an authenticated model workload or stabilized-session test.
Offline CLI setup can exit early; report that separately rather than counting
a missing process as a successful live stop. No existing account configuration
or credential is supplied, and the private namespace is removed at exit.

The old stop process-cleanup experiments are historical only. Their former
ownership, pidfd, escalation and distribution assertions are not current
acceptance. See the historical notes in `test/diagnostics/session-lifecycle`.

Launch retains its separate guarantee against creating processes after its
success/failure return. Stop does not change that launch contract.
