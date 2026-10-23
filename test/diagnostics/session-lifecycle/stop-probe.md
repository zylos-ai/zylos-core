# Controlled session-stop mechanism probe

Run `python3 stop-probe.py` on Linux with tmux installed. No model, login, credentials, default tmux socket, or production files are used. Each case starts a private tmux server using `-S` and `/dev/null` configuration, a temporary HOME, and a controlled Python parent/child pair with no run identifier. Temporary directories are retained and JSON evidence is printed to stdout; owned processes and private servers are stopped in cleanup. This is a mechanism experiment, not a test of the product adapter or a full process-containment solution.

The parent is the pane process. Its child creates a new POSIX session. Both ignore SIGHUP. The probe verifies their PID/start-time identities and the parent-child relationship before closing the pane, then demonstrates that both survive after the tmux session is absent.

Three bounded cases follow:

- TERM-responsive processes: signal both observed identities and confirm both cease running.
- TERM-ignoring processes: escalate to KILL after 250 ms, then confirm within a further 250 ms.
- Suppressed signal delivery: report `STOP_UNCONFIRMED` after the same bounded budget, then perform separate harness cleanup.

A deliberately incorrect start-time identity is rejected before signalling. Each tmux command has a two-second timeout, readiness and cleanup have one-second bounds. Controlled stand-ins also self-exit after 30 seconds if the harness is killed before cleanup. Zombie processes count as exited because they cannot execute; raw final states remain in the evidence. The JSON output records observed PIDs, start times, signal phases, elapsed confirmation time, and cleanup confirmation.

## Limits

The harness knows its two controlled processes. It does not prove that a general pane descendant snapshot is complete, that descendants cannot fork or reparent between observations, or that arbitrary platform process trees are inspectable. A pre-stop snapshot alone can miss later-created descendants. Process-group signalling is insufficient for the demonstrated child that calls setsid.

The Linux `/proc` identity check rejects an already mismatched PID/start time, but `os.kill` still has a check-to-signal PID reuse race. A production implementation needs an atomic process handle where available, such as a correctly acquired and verified pidfd, and must return an unconfirmed result when ownership or liveness cannot be established. This probe does not validate macOS behavior or actual Claude/Codex processes.

## Product change suggested by the evidence

For a session present at stop entry with an unreadable run identifier, capture the bound pane identity and a trustworthy process set before mutation; revalidate the tmux object, signal only verified owned identities, use bounded escalation, and verify both the bound tmux object and captured runtime identities have exited. Preserve unconfirmed failure for incomplete ownership, identity change, inspection failure, or survivors. Do not grant the absent-at-entry process-unknown exception to a session that was present at entry. A general descendant-tracking mechanism remains an implementation prerequisite; this probe is not sufficient justification to replace the existing safe guard.
