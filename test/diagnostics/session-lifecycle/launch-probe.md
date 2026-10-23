# Isolated tmux launch protocol investigation

Run on Linux with Python 3 and tmux:

```sh
python3 reproduce.py > run.log 2>&1
```

The script creates a fresh temporary directory and explicit private tmux socket, uses `/dev/null` as tmux config, and launches only Python fixtures and `sleep`. It never invokes a model or reads credentials. Every tmux command includes the private socket. Finally it resumes and kills only that server and terminates its own control clients. Temporary files and control logs remain for inspection; `results.json` is written in the retained temporary run directory (or pass `--output /path/to/results.json`). A minimal child environment uses a fresh HOME and PATH/TERM/LANG only. Linux is required. Cleanup confirms the server and known launcher PID are no longer live. All command, fixture, lock-acquisition and observation waits are bounded. The test uses Linux `/proc` to distinguish a Python launcher from the same PID after `exec`.

## Observed on tmux 3.7c

| Scenario | Observation |
| --- | --- |
| Normal `new-session -d` returns | Session exists while launcher remains Python; after explicit release the same PID becomes `sleep`. Creation completion alone is not exec confirmation. |
| Budget expired before submit (branch-level check only) | No command submitted and no session exists. |
| Server paused; control stdin written/flushed; client killed and reaped; server resumed | No late session observed in this run. Stdin flush is not proof the server received or queued the command. Absence is not proof of a cancellation guarantee. |
| `if-shell` gate checks under file lock; server paused after decision; gate exits success; cancellation written under same lock; client retained; server resumed | A session appears after the simulated failure-return marker. Lock-backed cancellation does not invalidate an already successful gate decision. |
| Same foreground gate, client killed and reaped before resume | No late session observed in this run. |
| Same background (`-b`) gate, client killed and reaped before resume | No late session observed in this run. |

The script records observations rather than asserting that disconnected-client cases must create a late session. Different tmux versions or event orderings may differ. A prior attempt that assumed late creation would necessarily occur failed; that assumption was removed. These results do not establish a universal inability to implement cancellation, nor certify this protocol for any supported tmux version. They also do not turn a launcher pre-exec marker into proof that exec succeeded.

## Concrete unresolved windows

1. **Submission without settlement:** after work may have reached the server but before a completion or cancellation acknowledgement is observed, a stopped/unresponsive shared server cannot answer. Client death and a cancellation file are not server acknowledgement. A finite observation window with no late action does not settle all future server behavior.
2. **Gate decision before creation:** an external condition can decide success and release its lock before the tmux callback executes. The retained-client case demonstrates this window. Holding a lock until server completion instead prevents bounded cancellation from acquiring that lock if the server stops. This is a limitation of this candidate, not a proof against all possible protocols.
3. **Creation before exec:** the detached creation command may complete before the launcher execs. Successful launch must obtain separate exec evidence. Failure must account for the already-created launcher and any future exec, not merely close the tmux client.

A product implementation should retain its pre-mutation guard until a supported-version completion/cancellation mechanism is demonstrated. If no such mechanism is found within the shared-server topology, the smallest design discussion is how to represent an unresolved submitted attempt while reserving its identity and prohibiting retries until settlement, with a deadline for reporting uncertainty rather than a falsely settled failure. That changes the caller contract and requires design approval; this diagnostic introduces no error code or product state. Killing a dedicated server is another topology-dependent option, not an authorized solution for a shared server.

## Primary implementation reference

The tmux `if-shell` callback chooses a branch from job exit status and then queues the selected commands; it does not execute `new-session` inside the external gate's file lock:

- https://github.com/tmux/tmux/blob/3.4/cmd-if-shell.c
- https://github.com/tmux/tmux/blob/3.7c/cmd-if-shell.c
- https://github.com/tmux/tmux/blob/3.4/spawn.c (parent fork path and child exec path are separate)

No `wait-for` frame behavior is used to infer `new-session` completion. No product runtime, authentication, production socket or cross-platform acceptance was tested.

## Command already executing: optional GDB probe

Run `python3 dequeued-fork.py` on Linux with GDB and a tmux binary exposing the required symbols. It starts its own foreground tmux server under GDB; it does not attach to an existing server or alter ptrace settings. The first keeper fork is skipped, and the next fork is stopped before child creation. A bounded file barrier holds that stop until the control client is killed and reaped and the simulated failure-return event is recorded.

On tmux 3.7c the backtrace showed `fork → forkpty → spawn_pane → spawn_window → cmd_new_session_exec`. The child startup marker was absent at the breakpoint and at the failure-return boundary. After releasing the debugger, the child startup marker appeared and the session was observable. Thus disconnect does not cancel creation already executing inside the server. The session object may already have been allocated before this breakpoint; the demonstrated late action is the pane/launcher process fork, not a claim that the session object was first allocated afterward. The startup marker proves the controlled launcher ran, not model exec or READY.

This is a concrete counterexample to client-exit cancellation in the executing-command window, even though the earlier pre-dequeue experiments observed no late session. It does not prove all possible server-side cancellation protocols impossible. The script records version, events, GDB backtrace, and cleanup in a retained private directory. Symbol availability and fork ordering are explicit probe assumptions; a failure to reach the breakpoint is not a product result.
