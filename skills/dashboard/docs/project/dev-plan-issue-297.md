# Development plan: optional read-only terminal Observer

Status: the revised private-tmux lifecycle design is independently approved for implementation. Code review and real product restart/uninstall acceptance remain pending. Historical probe results apply only to their recorded revisions.
Baseline: v0.5.5. Feature authority: [Issue #297](https://github.com/zylos-ai/zylos-dashboard/issues/297), with Howard's subsequent installation decision below.

## Goal and accepted scope

An administrator can watch the selected Agent's terminal from Agent detail without controlling it. Both local and Fleet detail are in scope. Dashboard keeps working if Observer installation or operation fails.

Howard approved shipping the small Observer integration with Dashboard while downloading Zellij only after an explicit administrator action. He then authorized starting this next phase after v0.5.5 was released and deployed. This is not a general plugin system or a separately managed PM2 service. Production enablement, merge, and release remain separate from development and isolated acceptance.

Issue #297 owns the detailed lease, proxy, authorization, resource, and test requirements. Howard subsequently changed the lifetime contract: an unexpected Dashboard crash may leave Observer running temporarily; restart must clean it before fresh on-demand creation, without adopting the old session. Normal shutdown, disable and online/offline uninstall still require cleanup. This decision supersedes the earlier immediate-crash guardian requirement. The issue's POC measurements and compatibility statements are reported evidence, not yet independently reproduced by this implementation.

## Experience and component boundaries

Default installation shows a lightweight Settings entry for terminal observation. It downloads no Zellij, starts no Observer child, and opens no Observer listener. The Observer app tab appears only when the selected producer has a verified installation and is enabled.

An administrator opens the selected Agent's Settings, sees the installation target, and selects **Install and enable**. The producer downloads and validates the pinned binary, records successful installation, and enables the feature. Installation alone does not start a terminal: entering Observer acquires the first viewer lease. Leaving the app tab releases it; the last lease triggers bounded teardown after grace.

- **Dependency installer:** platform/artifact allowlist, fixed version and trusted checksums, progress, atomic installation, retry, removal, and filesystem ownership.
- **Observer manager:** one process generation per producer, leases, tmux wrapper, resource limits, and complete teardown.
- **Observer HTTP/WS adapter:** admin identity, browser-origin checks, lease binding, narrow routes, private upstream credentials, and bounded streams.
- **Fleet adapter:** selected-producer installation/status/lifecycle forwarding and Observer-only WebSocket forwarding with producer-side reauthorization.
- **UI:** installation controls and status in Settings; Observer tab activation/exit integrated with existing app history and local/remote selection.

Use focused modules following current ESM/vanilla-JS conventions. Add a narrowly scoped WebSocket dependency only if needed after assessing Node's available primitives; do not build a general plugin loader or arbitrary tunnel.

## Installation contract (supplements #297)

Installation state and runtime state are separate:

| Installation state | Available action | Runtime implication |
| --- | --- | --- |
| not installed | Install and enable | No process or listener |
| installing | View bounded progress | No terminal process |
| installed, disabled | Enable or uninstall | No process or listener |
| installed, enabled | Open Observer, disable, uninstall | Starts only on viewer demand; crash residue may remain until restart or uninstall |
| failed / unsupported / incompatible | Retry where supported | Dashboard stays available |

1. Status and installation-management endpoints are admin-only and remain reachable while disabled. This is an intentional refinement of #297's blanket disabled-route 404 rule: streaming and lease endpoints remain unavailable until installed and enabled. Status must distinguish unavailable permissions from not installed.
2. Persist desired `observer.enabled` in config.json separately from verified artifact truth. Replace the relevant independent whole-file read/modify/write paths with one shared config mutation helper used by Observer, Settings, Fleet, and configure. Each transaction rereads under a bounded cross-process lock, changes only its fields, writes a unique temporary file, and atomically renames; do not hold this lock over downloads or process teardown. Invalid existing JSON fails without replacing unrelated configuration. Prove stale-lock recovery and overlapping CLI/server writes. Installation completion must be proved by verified artifact/version, not solely by a boolean in config. Default install/upgrade hooks never download or enable Observer, including when an existing installation needs a newer supported artifact.
3. Pin Zellij 0.45.1 candidate artifacts from official zellij-org/zellij Releases. Before shipping, verify exact artifacts/checksums, licensing, and the Web client/read-only protocol for each supported platform. Do not resolve `latest` during installation. No arbitrary download URL, version, executable path, shell command, or platform string from the browser.
4. Download to bounded temporary files beneath the producer's managed Dashboard data subtree. The shipped manifest pins both archive SHA256 and extracted-binary SHA256: official `.sha256sum` files cover the binary, not its compressed archive. Check both before execution; bundle MIT license attribution because the upstream archive contains only the executable. Reject unsafe archive entries and symlink escapes; stage and atomically publish only the expected binary. Preserve an existing working binary if a replacement fails. Bound download size/time and coalesce concurrent installation attempts. Every lifecycle operation uses one producer-wide coordinator, an operation generation, and unique staging; late completion must check its generation before publishing an artifact or changing desired state. Status and every start revalidate the owned manifest, regular-file/no-symlink identity, version, and binary digest. Publish the verified artifact before setting enabled; if enabling fails it remains installed-but-disabled.
5. Use separate private config, cache, data, temporary-log, and session-socket roots (0700), sensitive metadata (0600), and executable (0755). Use direct argv invocation, never remote shell scripts or `shell:true`. Run without sudo or system package-manager changes. Installation failures must not change unrelated files/config.
6. **Disable** persists disabled, invalidates leases, and stops the owned generation while retaining downloaded artifacts. **Uninstall** first disables/stops, then removes only managed Observer artifacts. It must not delete a user/system Zellij or the Agent's tmux session. The producer coordinator covers install/update/enable/disable/UI uninstall/first-lease start. Disable/uninstall durably persist disabled first, fence starts/leases and obsolete operation generations, revoke access, prove all owned processes/listeners stopped, then remove only manifest-owned files for uninstall. A persistence failure stops removal and reports failure; it cannot claim durable disable. Failed removal remains durably visible after restart and the feature remains disabled. Component pre-uninstall must enter the same bounded teardown/revocation protocol while PM2 may still be running; a durable teardown fence prevents new leases until removal/reinstallation is resolved. When Dashboard is absent, the hook takes the same exclusive coordinator ownership and reconciles persisted generations before removing artifacts; removing hooks alone is insufficient. No changes to Core uninstall ordering.
7. Fleet installation runs on the selected producer. The consumer never reports its own binary as the remote Agent's installation. Old producers return a stable unsupported state. Reuse admin Fleet identity; read-scoped keys cannot install, enable, lease, or proxy Observer.
8. Do not expose internal binary paths, tokens, or download command lines in product controls. Display target Agent, supported version, progress/state, and actionable safe failure reasons.

## Runtime and security contract

Retain the full #297 contract, particularly:

- One shared generation; start coalescing and generation guards; defaults maxViewers=4, leaseTtlMs=30000, idleGraceMs=5000.
- A lease is not a credential: normal admin identity on every HTTP/WS hop; bind lease to principal, target, and generation. Use one canonical auth context for HTTP and upgrade: `{kind, principalId, scope}` derived from live validated credentials. Cookie principal is its server-side session hash; API/Fleet principal is stable `api_key_id`, not a rotating bearer hash and never just scope. Store no plaintext credential in a lease. Revalidate expiry/revocation on requests and the active-stream policy defined in A; API token refresh under the same key retains identity, a different key cannot use the lease. Consumer leases additionally bind the local browser principal and selected producer before forwarding under its Fleet key. When auth is disabled, all Observer management/lease/stream routes fail closed with `auth_required`, and the UI explains authentication is required; no anonymous admin principal. Browser-cookie mutations and WS require exact expected Origin; trusted bearer Fleet hops follow an explicit separate path.
- Only loopback internal listeners; dedicated observer Zellij config/cache/data/socket roots; no access to unrelated Zellij sessions. Never forward internal auth cookies/tokens to the browser.
- Double read-only enforcement: Zellij read-only watcher plus allowlisted `tmux -N ... attach-session -r`. Never create/replace the Agent's `claude-main` or `codex-main` session.
- Presets only (80x21 / 110x30 / 140x40); newest accepted preset shared and broadcast. Tampered clients cannot send input or alter Agent session dimensions outside the intended read-only policy.
- WebSocket ping/pong and server expiry are authoritative; background browser visibility alone is not an app-tab exit. Pagehide is best effort, never sole cleanup.
- Bounded exact private cleanup; late startup is fenced by an atomic pending permit and a terminal launch-settlement receipt. A private tmux server hosts the Zellij client and foreground web process. Cleanup first requests the exact private Zellij session to stop, then stops the private outer tmux server, and verifies the known roles and private endpoints are gone. CLI success alone is not exit proof. Dashboard death may leave these resources alive; restart must finish cleanup before fresh demand. No immediate-crash guardian or old-session adoption is required. No product generation may start on an unproved platform; Windows remains unsupported. No global PM2/Caddy change or sudo is allowed.
- Exact local/Fleet route allowlists; authenticate before allocation/upgrade; preserve root and `/dashboard` deployment prefixes. No generic proxy, raw terminal logging, recording, or scrollback persistence.
- Bounded bodies, handshakes, startup, shutdown, buffers, viewers, and retries. Child failure closes its leases and streams; explicit retry starts a new generation.

## Work sequence and checks

### A. Verify the external integration before building around it

This stage produces isolated probes and a concrete mechanism record, not product implementation. Luna accepts that evidence after independent review before B. An unresolved trust-domain, containment, or protocol gate means stop and revise the design, not continue behind an optimistic assumption.

**Browser trust domain.** The privileged code is a small Dashboard-owned, audited broker. Do not execute the upstream Zellij Web bundle or terminal parser in the Dashboard administrator origin. The candidate is a self-contained renderer in an opaque sandboxed iframe (`allow-scripts`, no `allow-same-origin`, forms, popups, or top navigation) with a restrictive CSP denying network connections. The broker alone performs authenticated same-origin Observer HTTP/WS requests and transfers bounded display data over a dedicated MessageChannel. Validate the frame/window and channel during setup; do not trust `Origin: null` as identity. The bridge has an explicit message schema and size/rate limits, supports only rendering/lifecycle and the three presets, and accepts no URL, request method, headers, script, arbitrary command, or credential request. All terminal decoding/rendering of untrusted content stays inside the frame; the broker never inserts terminal text as HTML.

This preserves #297's normal-admin-per-network-hop requirement: the browser broker authenticates to the local/consumer Dashboard, and the consumer uses its normal admin Fleet identity to the producer. The iframe has no independent network capability or upstream token. A MessageChannel and lease ID do not substitute for Dashboard auth. Same-origin CSP/HttpOnly/Origin checks alone do not isolate an upstream bundle. Stage A must prove compatibility with the pinned watcher protocol without granting the frame administrator authority. If this cannot work without a large client fork or a changed auth/deployment contract, return the concrete tradeoff for review before B; no silent dedicated-origin or capability-only fallback.

**Private lifecycle and restart recovery.** Prepare complete metadata, fixed configuration and a pending permit in an unpublished staging directory, then atomically publish the generation. Only a detached startup worker that wins the pending-to-starting claim may create resources; a reconciler can instead cancel pending startup. Workers reject staging/retired paths and never recreate a cancelled generation. The worker publishes a terminal receipt only after all issued creation commands have settled; readiness additionally requires the exact read-only target client and authenticated upstream. Ordinary target, token, web bind or authentication failures use the same cleanup once launch is settled.

Acquire the permanent SQLite coordinator lock before main or lazy startup reconciliation; publish the online cleanup socket after initialization. Offline uninstall uses the same lock. Never replace the lock database while contenders exist. Preserve private HOME/config/cache/data/socket/log roots and exact generation identity. Target-side tmux commands use `-N` so a missing Agent server cannot be bootstrapped. Never signal a foreign listener merely because it occupies the selected port.

After cleanup, verify the recorded outer server, Zellij client/daemon, foreground web and inner target client are gone, exact private endpoints are inactive, and no known role remains in the unique private namespace. This is bounded role evidence, not a generic descendant census. Keep unrelated fixtures alive. Remove socket scope while metadata remains intact; atomically rename the final generation into a retired namespace before recursively deleting its files, so another Dashboard interruption cannot strand partially deleted live state.

Dashboard-only death must recover automatically before/after publication, before claim, during worker startup, after settlement and during teardown. Worker, OS, or early Zellij failure before conclusive session-startup acknowledgement is a separate exceptional limitation: retain records and artifacts, fence Observer and failed uninstall, and require operator investigation if retry cannot finish. This does not include an ordinary held inner target exit after session settlement. Do not infer launch closure from elapsed time, absent PIDs, clock changes or reboot. Legacy native state requires its original version or explicit operator recovery; it is not automatically discarded. The current tree omits the obsolete native adapters and helper binaries. Their sources and assets remain in [the frozen pre-cleanup tree](https://github.com/zylos-ai/zylos-dashboard/tree/a5be86088efa8da63f98a73a182bd0ee57a4f004); this is a historical recovery reference, not a current runtime dependency.

Acceptance separates real unmodified Dashboard restart/disable/online+offline hook scenes from disclosed deterministic startup-phase tests. Release a deliberately delayed worker after pending cancellation; it must create nothing. For a claimed startup, prove reconciliation waits for terminal settlement, then cleans before any new demand. Use known-bad permit/early-receipt mutants to establish test sensitivity. Ordinary failed-start scenes preserve the unrelated occupied-port listener and prove target disappearance cannot start a replacement server. Previous normal-only teardown probes do not satisfy these product gates.

- [ ] Download only into an isolated test workspace; record official artifact URL, SHA256, license, OS/architecture, and version output.
- [ ] Reproduce watcher + tmux read-only rendering through the audited broker and opaque frame, including assets and WebSocket paths. Inject known-bad iframe code attempting a non-Observer admin mutation both directly and through forged bridge messages: both must fail without changing sentinel settings. A direct authenticated parent control must demonstrate the test mutation can otherwise succeed.
- [ ] Demonstrate private upstream token handling with a real browser, no token/cookie escape, and sentinel input rejection with a positive control proving the sentinel can change through an intentionally interactive test client.
- [ ] Verify private ownership, normal teardown, Dashboard-only crash/restart recovery, online/offline uninstall, and the supported-platform strategy. Mark untested platforms unsupported instead of claiming parity. Escalate any scope change rather than silently dropping local/Fleet or either runtime.

### B. Implement installation and local lifecycle

The accepted mechanism record must name executable/dependency ownership, validated platform support, stream reauthorization interval, exact route allowlist, and measured startup/cleanup bounds. Prototype success is not approval for production enablement. Lifecycle helper/hook calls must join the running producer coordinator through a private bounded control channel, or take exclusive offline ownership only after proving the producer absent; two coordinators may never publish concurrently.

- [ ] Installer/status/config validation, permissions, atomic staging, retry and disable/uninstall serialization; no automatic downloads in lifecycle hooks.
- [ ] Manager, allowlisted wrapper, lease/generation state machine, capacity and teardown.
- [ ] Canonical HTTP/upgrade auth context; session/key principal, same-key refresh and wrong-key rejection; auth-disabled fail closed; exact routes and broker/frame security boundary.
- [ ] Tests for successful install, checksum/archive failure, unsupported platform, concurrent first install, install-uninstall races, restart during partial installation, and preservation of existing artifacts. Include concurrent Settings/Fleet/configure writes, invalid config, manifest/digest tampering, symlink substitution, config-enable failure after artifact publish, durable failed-removal restart, and component pre-uninstall during active viewing; default install/upgrade hooks have explicit no-download/no-enable negative tests.
- [ ] After product wiring is implemented, apply the bounded known-role/private-endpoint oracle to real last-lease teardown, disable, online/offline component pre-uninstall, and Dashboard restart after abrupt death. Prove these entry points invoke the accepted private lifecycle; harness-only evidence does not satisfy B.
- [ ] All local lifecycle/race/fault/rejection cases from #297.

### C. Integrate Fleet and UI

The producer lease response is route-neutral: lease ID, expiry, presets, and a validated relative embed resource identifier, never a public origin or forwarded prefix. The local/consumer boundary constructs browser paths from its configured base and selected encoded Agent. Do not let forwarded-prefix headers construct producer resource paths. HTTP and upgrade share one canonical parser with decode-once and traversal/encoded-separator rejection; no independent normalization implementations.

| Browser deployment | Lease API | Embed/assets/WS namespace |
| --- | --- | --- |
| Root, local | `/api/observer/leases` | `/observer/<resource>` |
| `/dashboard`, local | `/dashboard/api/observer/leases` | `/dashboard/observer/<resource>` |
| Root, Fleet | `/fleet/<encoded-agent>/api/observer/leases` | `/fleet/<encoded-agent>/observer/<resource>` |
| `/dashboard`, Fleet | `/dashboard/fleet/<encoded-agent>/api/observer/leases` | `/dashboard/fleet/<encoded-agent>/observer/<resource>` |

`<resource>` is a closed, implementation-defined allowlist of embed/assets/WS paths, not arbitrary proxy suffixes. Freeze the exact entries in A's protocol record and test every entry in all four rows. The consumer forwards only normalized producer-relative paths; the producer never receives a consumer Fleet/base prefix as resource authority. Test remote 401 refresh, malicious forwarded prefixes, encoded Agent names and all HTTP/upgrade rejection cases through the real two-hop chain.

- [ ] Producer-owned remote status/install/enable/disable/uninstall and lease operations; admin-only narrow WS path.
- [ ] Settings target/state/progress/retry controls; bilingual strings; Observer tab and shared preset controls.
- [ ] App tabs, history/popstate, fleet wall, Agent switch, pagehide and reconnect all close the old viewer and cannot revive old leases.
- [ ] Mobile/desktop layout; CSS and JS cache-busting consistent with repo conventions.
- [ ] Real consumer→producer HTTP/WS round trips, admin/read keys, expired token refresh, disconnect/restart and old-producer behavior.

### D. Independent review and delivery

- [ ] `npm run check`, `npm test`, isolated startup and API smoke pass. Clear inherited CLAUDE_SESSION_ID/CODEX_SESSION_ID for tests requiring a clean service environment; report this explicitly.
- [ ] Run the complete #297 positive/reject/fault matrix against isolated services and sentinel tmux sessions on an isolated tmux socket. Never point mutation tests at an actual Agent main session or production DB.
- [ ] Re-run B's real last-lease/disable/component pre-uninstall/Dashboard restart survivor checks during final isolated acceptance; retain the reviewed known-role oracle and distinguish allowed crash residue from required completed cleanup.
- [ ] Capture desktop/mobile local/remote screens, installation/permission failures, before/active/after process trees/listeners, disk, RSS/PSS, teardown durations and rejected-input evidence.
- [ ] Add operator-facing installation/disable/uninstall documentation and Unreleased changelog. No feature-PR version bump.
- [ ] Jinglever implements under his own GitHub identity; Luna and an independent reviewer review final code/evidence. Plan review precedes implementation; Luna handles intermediate gates already delegated by Howard.
- [ ] Remove this temporary dev plan before final merge; retain the durable module/operator contract. Deliver PR and evidence to Howard for final acceptance. Do not merge/release/deploy/enable on production as part of development.

## Assumptions to prove

- Zellij Web 0.45.1 watcher protocol works with the Dashboard-owned broker and opaque renderer while all upstream credentials stay server-side. This is a hard stage-A feasibility gate, not a claim already verified.
- Dedicated config/cache/data/socket roots actually exclude other local sessions and token metadata; read-only tokens alone are not assumed to be per-session capabilities.
- On each claimed platform, the detached startup worker survives Dashboard-only death and supplies launch settlement; restart and offline uninstall then clean the exact old generation before any replacement starts.
- Existing Fleet token-refresh and path normalization can be reused without broadening proxy targets or leaking tokens.
- The OS/architecture has a tested upstream artifact. Fixed/active memory numbers in #297 are acceptance targets to measure, not guarantees already established.


## Evidence anchors for the revised plan

Baseline code facts were checked against v0.5.5: `src/lib/auth.js` currently exposes boolean cookie validation and scope-only API validation, `src/index.js` and `hooks/configure.js` independently rewrite config, and `hooks/pre-uninstall.js` currently only removes runtime hooks. The changes above are target contracts, not existing behavior.

Pinned upstream source references (source evidence does not substitute for the current product acceptance):

- [Unix client double-fork](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-client/src/lib.rs#L459) and [server daemonization](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-server/src/lib.rs#L863).
- [Token database location](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-utils/src/web_authentication_tokens.rs#L62) and [cache metadata](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-utils/src/consts.rs#L92), with [socket and temporary-log roots](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-utils/src/consts.rs#L333).
- [Release archive/checksum construction](https://github.com/zellij-org/zellij/blob/v0.45.1/.github/workflows/release.yml#L114) and [MIT license](https://github.com/zellij-org/zellij/blob/v0.45.1/LICENSE.md). Artifact acceptance verifies the downloaded files themselves.
