# Observer

Observer is an optional, authenticated display of the agent's tmux terminal.
Dashboard works without it. Open **Settings → Observer** to install its pinned
Zellij dependency and enable viewing. Installation downloads and verifies a
private copy; it does not replace a system Zellij installation.

## Platform availability

| Host | Dashboard Observer installation |
| --- | --- |
| macOS Apple Silicon (`darwin-arm64`) | Enabled |
| macOS Intel (`darwin-x64`) | Not enabled; native validation required |
| Linux x64 (`linux-x64`) | Enabled |
| Linux arm64 (`linux-arm64`) | Enabled |
| Windows x64 | Not enabled; lifecycle adapter required |

Dashboard automatically selects the pinned Zellij artifact for the server's
operating system and CPU architecture. No manual platform selection is needed.
In Fleet, selection happens on the target agent's server, not on the Fleet server
or the computer running your browser. Installation and enabling remain explicit
actions in Settings.

Observer requires an available tmux with support for `-N` (do not start a missing
server), the pinned private Zellij installation, and Dashboard's existing
SQLite dependency. Its coordinator and runtime data must be on a local filesystem
with working SQLite file locking. The private-tmux lifecycle does not require
custom native guardian helpers, their glibc/pidfd prerequisites, or Python.
The pinned Zellij download is an official precompiled binary. Dashboard's existing
SQLite dependency may still require Python and a C/C++ toolchain during dependency
installation if a compatible prebuilt addon is unavailable; that is not an
Observer runtime requirement.

The architecture entries describe managed-host support, not every Linux
distribution, container, filesystem or tmux build. The upstream artifact catalog
also includes targets that the product does not enable. A successful build or
isolated native probe does not establish product lifecycle support.

## Viewing and access

Use an authenticated administrator session. Observer is unavailable when
Dashboard authentication is disabled; read-only accounts and Fleet credentials
without administrator scope cannot acquire a viewing lease or change its state.
For a Fleet target, actions apply to the selected remote Dashboard and require
that target's administrator credentials and Observer support.

Once enabled, open the Observer tab. The first viewer starts a private Observer
generation attached read-only to the active runtime's tmux session. Keyboard,
paste and terminal input are not forwarded. Observer follows the agent terminal
width and height, including its tmux status lines, with a shared two-second
read-only poll while viewers are connected. Following a size change resizes only
Observer's private terminal; the agent window changes only through Set size
(below).
Startup measures the agent window before attaching and checks it again after
attachment. If its dimensions changed, Observer disconnects without restoring
the agent window and retries viewing automatically. This check also catches a
concurrent resize by another client.
The guard applies only during startup: if an ordinary client enlarges the Agent
window and disconnects before the next two-second poll, tmux may return the
window to Observer's previous size.
On smaller screens, scroll horizontally or vertically inside the terminal to
see the full display. Common terminal symbols use an embedded symbol font.
In History, session choices include their start time in your browser’s local
time zone, making sessions with identical titles easier to distinguish.
Observer still displays terminal contents, so viewers must be trusted to see
anything shown by the agent.

### Setting the agent terminal size

A detached agent tmux session usually stays at 80×24. In the Live view, enter a
width and height and select **Set size** to resize the agent's tmux window.
Height excludes the tmux status line; Observer shows the window plus that line.
Limits are 20–500 columns and 5 rows up to a total of 200 rows including status
lines. The Dashboard resizes the window, reads the size back, and only then
remembers the value in its `config.json` (`observer.agentSize`, default
120×50), so each Dashboard remembers the size for its own agent. Connected
viewers follow within the two-second poll.

Set size is an administrator write: cookie sessions must pass the same-origin
check, and Fleet targets require administrator credentials for that Dashboard.
It is refused while an Observer viewer is attaching; retry after it connects.
tmux fixes a resized window at that size (`window-size manual`), so it no longer
follows ordinary clients that attach later. A runtime restart creates a new
session at the tmux default size; Observer does not reapply the remembered size,
so select Set size again. Observer never resizes the agent on its own.

Viewing uses short-lived leases tied to the authenticated session and target.
Closing the last viewer stops the private generation after the idle grace period
(five seconds by default). Expired authentication or leases close the stream.
Normal Dashboard shutdown closes streams and cleans the private generation.
An unexpected Dashboard crash may leave Observer processes running locally. The
Dashboard viewing connection ends; the private service remains loopback-only and
still requires its credential. Dashboard restart cleans the previous generation
before allowing fresh viewing, without reusing the old session. An enabled
setting alone does not start a viewer.

Lease creation (`POST /api/observer/leases`) and renewal
(`POST /api/observer/leases/<id>/renew`) responses include a one-time `ticket`
alongside the lease `id`, `expiresAt`, `generation` and `resource`. The browser
opens `/observer/stream` offering the `Sec-WebSocket-Protocol` tokens
`zylos-observer-v1`, `lease.<id>` and, when it has one, `ticket.<ticket>`, in any
order; the server always selects `zylos-observer-v1`. A ticket is needed only
when a cookie-authenticated handshake fails the origin check, for example when
Chromium (which sends no Fetch Metadata on WebSocket handshakes) connects
through a proxy that rewrites `Host`. Tickets are bound to the lease and
principal, expire after 30 seconds and work once; renewal mints a fresh one,
and only the newest few per lease stay valid. Bearer-token handshakes ignore
tickets. A Fleet target's relay replaces the ticket with its own for the
browser-facing hop. See
[Observer request origins](modules/deployment.md#observer-request-origins).

## Automatic viewing recovery

Restarting the agent process inside the same tmux pane can leave viewing intact.
Recreating the target tmux session or server breaks the old read-only attachment.
Observer then closes the old streams, invalidates their leases and cleans its
private generation. Fresh viewing is admitted only after that cleanup succeeds.

While the Observer tab remains open, the browser shows a waiting notice and
retries with delays of 1, 2, 4, 8 and then 15 seconds between attempts, without
a fixed attempt limit. Each attempt checks current status and requests a fresh
lease and stream. A verified missing target remains retryable; Observer never
creates the agent's tmux session or starts its server. Once the target returns,
successful startup and attachment allow viewing to resume. Multiple viewers can
join the same new private generation. The same flow applies to Fleet targets,
including temporary upstream connection failures.

Closing the viewer, leaving Observer, changing targets or disabling Observer
cancels that browser's retries. Authentication, permission, unsafe state and
unresolved cleanup errors stop automatic attempts and require attention. Unknown
startup or command failures are not assumed to mean a missing target. Recovery
has no fixed completion deadline: it depends on target availability, safe cleanup
and successful startup. It reconnects the display; it does not resume or restart
the agent process itself.

## Disable, uninstall and recovery

- **Disable** ends viewing and stops Observer processes, retaining the downloaded
  artifact for later use.
- **Enable** permits viewing again using a verified installed artifact.
- **Uninstall** ends viewing, proves cleanup and removes the private artifact.
  It does not remove the agent's tmux session or system tools.

Cleanup uncertainty fences Observer against new viewing. A runtime failure can
leave the enabled preference set while admission is blocked; disabling or
uninstalling explicitly clears that preference.
Settings reports the failure and offers **Retry cleanup** to retain the artifact,
or **Uninstall** to remove it after cleanup succeeds. If an uninstall is already
pending or failed, Settings offers **Retry uninstall** to finish that removal.
If another live
Dashboard owns the Observer coordinator, resolve the duplicate producer before
retrying. A control startup failure leaves the ordinary Dashboard available but
blocks Observer admission.

Do not delete ownership markers or persisted runtime records to bypass a cleanup
failure. Preserve the error and runtime evidence for diagnosis. Interrupted
removal can be retried even if the owned socket directory or artifact leaf has
already been removed; existing parent paths and remaining ownership records must
still validate. Component uninstallation also performs Observer cleanup, both while Dashboard
is running and after it has crashed, and fails until that cleanup can be proved.

A startup worker continues independently if Dashboard crashes. For new
generations, a worker that exits without acknowledging startup, or stalls until
the startup deadline, is automatically cancelled. Recovery stops that exact
worker and its private resources, verifies their absence, and retires the old
records before a later viewing request starts a fresh generation. Dashboard
restart uses the same recovery path; it does not resume the interrupted session.

Persistent operating-system or filesystem failures, unsafe ownership records,
or resources that cannot be proved absent still require investigation. Restart
does not discard unresolved records merely because time has passed or a PID is
missing. Older generations without the startup-recovery contract retain their
previous cleanup requirements; native-helper generations require their original
version or explicit operator recovery. The current tree does not include the old
native adapters or helper binaries; their sources and assets remain available in
[the frozen pre-cleanup tree](https://github.com/zylos-ai/zylos-dashboard/tree/a5be86088efa8da63f98a73a182bd0ee57a4f004).
Unknown legacy state is rejected and preserved, never automatically discarded.

## Cleanup scope and limits

Observer uses its own private tmux server, Zellij session, foreground web process
and private sockets. For acknowledged startup, it first closes the exact private
Zellij session, then the private tmux server. Interrupted-start recovery instead
cancels creation and stops the exact worker and private producers before draining
their scoped descendants. Both paths check private processes and endpoints before
removing their records. They never close the Agent's tmux server or signal an
unrelated service occupying a port. Cleanup uncertainty remains a failure.

This is cooperative process management on supported managed hosts, not a security
boundary against hostile processes running as the same user. Its evidence covers
known roles and the unique private namespace, not arbitrary descendant discovery.
Platform runs establish only their recorded source, binaries and host conditions;
historical probes do not validate a later implementation.

## Conversation history

Switch to **History** to read saved conversations and full tool output without
scrolling the live terminal. See [history, redaction and API details](observer-history.md).
