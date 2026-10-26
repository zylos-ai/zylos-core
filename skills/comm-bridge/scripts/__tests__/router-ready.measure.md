# READY measurement runner

Run from the checkout with its existing dependencies, using the official Node
runner. This is opt-in; normal test discovery skips the authenticated run.
Neither `zylos init` nor PM2 is invoked. The production timeout default remains
unset; the timeout below is a diagnostic input, not a recommendation.

```sh
READY_MEASURE=1 \
READY_MEASURE_EVIDENCE_DIR=/absolute/private/evidence \
node scripts/run-node-tests.js skills/comm-bridge/scripts/__tests__/router-ready.measure.test.js
```

Supply credentials in the calling environment through your secret-loading
mechanism before running. Do not put a key in command arguments, shell history,
or a checked-in file. The runner does not source host `.env` or discover native
credentials. All selected runtimes must pass preflight before any sample starts.
A failed preflight produces a failed `summary.json`, empty `samples.jsonl` and
nonzero test-runner exit. Each run gets a fresh `run-*` evidence directory.

| Environment variable | Default / meaning |
| --- | --- |
| `READY_MEASURE` | Must be `1` to enable |
| `READY_MEASURE_MACHINE` | Optional human machine label (for example `DGX Spark`); default platform/architecture, with CPU model/count and total memory recorded automatically |
| `READY_MEASURE_RUNTIMES` | `claude,codex`; comma-separated selected runtimes |
| `READY_MEASURE_CLAUDE_BIN` | `claude`, resolved on PATH; optional explicit executable |
| `READY_MEASURE_CODEX_BIN` | `codex`, resolved on PATH; optional explicit executable |
| `READY_MEASURE_CLAUDE_CREDENTIALS` | Required for Claude: explicit JSON credential file; `claudeAiOauth.accessToken` and numeric `expiresAt`, at least two hours remaining |
| `READY_MEASURE_CODEX_API_KEY` | Required for Codex: explicit API key; passed to `login --with-api-key` on stdin only |
| `READY_MEASURE_EVIDENCE_DIR` | `ready-measure-evidence` relative to checkout; created if absent |
| `READY_MEASURE_COLD_COUNT` | `10`, nonnegative integer per runtime |
| `READY_MEASURE_REPEAT_COUNT` | `10`, nonnegative integer per runtime |
| `READY_MEASURE_CASES` | `normal,slow-hook,missing-session-id,late-launch,boundary-ready`; faults run once each per runtime |
| `READY_MEASURE_TIMEOUT_MS` | `60000`, positive integer diagnostic M1 ready timeout |
| `READY_MEASURE_OBSERVATION_MS` | `90000`, must exceed timeout + max(1000, 2×poll); per measured launch/warm-up |
| `READY_MEASURE_POLL_MS` | `200`, positive integer |
| `READY_MEASURE_SLOW_HOOK_MS` | `2000`, positive real hook pause; less than observation limit |
| `TEST_TMUX_BIN` | Optional tmux binary override used by the shared isolated-tmux helper |
| `PATH` | Binary lookup; inherited without host auth selectors |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `no_proxy` | Only these proxy variables are forwarded; evidence records presence booleans, never values |

## Isolation and preflight

Each preflight/sample runs in its own process and temporary HOME, Zylos root,
file-backed P01 database, and shared-helper private tmux socket. Product modules
load after the isolated environment is set. Activity-monitor skill files are
copied so the Node direct-entry guards execute; remaining skills are linked.
Paths are canonicalized, including macOS `/tmp` aliases. No live dispatcher or
external channel is used. The product adapter's `stop` contract is unchanged:
it proves the expected tmux session is gone, not that every descendant process
has exited. Detached services intentionally can outlive that product operation.

For measurement only, a small JavaScript launcher starts the exact runtime
binary/arguments in a newly owned POSIX process group with inherited TTY stdio.
It handles the pane's HUP/TERM, sends TERM only to that group, waits up to 1.5s,
then KILL if needed and waits another 1.5s. The launcher retains ownership until
the group is absent and writes a structured receipt; the worker waits up to 5s
for it after each stop, including the repeat warm-up. Signal-probe EPERM means
not yet confirmed absent and is never interpreted as successful termination.
The added launcher startup is included in new measurements; it introduces additional
instrumentation overhead (not quantified). Help/version discovery passes through unchanged.

Only after group exit confirmation does the shared fixture cleanup remove HOME.
`cleanup` records immediate absence and a second check after 500ms;
`homeRemoved=true` requires both plus owned-group exit confirmation. If group
exit cannot be confirmed, explicit credential copies are scrubbed, the fixture
is retained, and the sample fails. A worker crash without cleanup proof also
marks summary cleanup false. This covers the group the test created, not arbitrary
children that deliberately detach into another session/group; the bounded
recheck cannot prove no arbitrary future recreation. No global process scan or
host process matching/killing is performed.

This change does not retroactively certify cleanup of older DGX runs. Its local
regression uses an intentionally delayed writer with a negative control that
recreates HOME after the old instantaneous check, and an owned-group positive
control. No real authenticated Claude/Codex rerun is implied by that test.

Claude credentials are copied with mode 0600. Onboarding and project trust use
the same minimal writes as product `preAcceptClaudeTerms` and `approveApiKey`:
`hasCompletedOnboarding`, `skipDangerousModePermissionPrompt`, and the project's
`hasTrustDialogAccepted` / `hasCompletedProjectOnboarding`. Native hooks come
from the product hook generator. `auth status --json` must confirm logged in.

Codex uses stdin API-key login, explicit project trust, the product native hook
installer/trust flow, and product auth-status parser. A separate fresh
app-server `hooks/list` must list every expected hook with `currentHash` matching
its persisted enabled/trusted state. Missing trust or auth aborts preflight.
Each sample repeats authentication/trust setup in its own HOME; setup itself
is outside launch timing. No auth stdout/stderr or pane capture is saved.

## Conditions and fault interpretation

Cold means a fresh HOME and runtime session. It does not mean flushed OS page
cache; authentication/version preflights can warm the executable cache. Repeat
means one successful unmeasured warm-up launch in that sample's HOME, then
stopping it and measuring the next launch with the same HOME. The HOME is still
removed after that individual sample.

Normal samples use wall and monotonic real clocks. Four fault cases use a
controlled M1 logical clock and are excluded from latency aggregates:

- Slow hook: the native start-prompt shard pauses before calling the real M3
  implementation. Once the wrapper has entered, the M1 clock moves beyond the
  deadline; assert one stop, one retry, no business delivery. A pause too short
  to reproduce that ordering fails the assertion rather than becoming a pass.
- Missing session ID: the same native shard receives a payload with `session_id`
  removed. After entry, move the logical clock beyond the deadline; assert the
  same timeout/retry convergence and no business delivery.
- Late launch: call the real adapter and hold its promise after it returns,
  waiting for actual M3 READY. Advance the logical clock past the deadline and
  tick while launch is held: `launch_pending` must occur without stopping.
  Release the return and assert one successful business delivery, no stop.
- Boundary READY: hold adapter return until actual M3 READY; pause periodic
  ticks and drain prior scene reads. Set logical time exactly at the M1 deadline.
  Hide READY for the first activation read and expose the same real identity on
  its boundary re-read. Assert exactly two gated reads, success, and no stop.
  No F3 file or publication timestamp is fabricated.

The delivery boundary is a sequence recorder, not terminal paste: it acknowledges
real M3 startup-control rows and marks the business row delivered through P01.
It asserts nonempty matching F3 startup IDs all appear before business, with no
duplicate delivery. Each fault ends at the first convergence (retry_count=1
means requeued for retry; it does not claim a second runtime attempt was run).

## Evidence

`summary.json` contains status, machine/Node details, non-secret configuration,
proxy presence, machine metadata, version/auth preflights, sample outcomes, cleanup status and
per-runtime/per-condition statistics. `samples.jsonl` contains one raw structured
record per measured sample, including failures. Files are mode 0600 in a 0700
run directory. Failed samples and all injected samples are excluded from normal
latency statistics. `counts` and `countsByRuntimeCondition` report collected,
READY-valid, cleanup-failed, aggregate-included, and aggregate-excluded counts,
with explicit exclusion reasons. A successful READY with failed cleanup still
increments READY-valid but is excluded from aggregates. A sample may have more
than one exclusion reason; reason counts are not additive sample totals. Old
raw evidence is not rewritten. Statistics use min, ordinary median, nearest-rank p95, max.

Timing fields include `launchStartedAt`, `launchReturnedAt`,
`f3PublishedAtProxy`, `observedAt`, `launchDurationMs`,
`publicationFromLaunchMs`, `publicationFromReturnMs`,
`observedFromLaunchMs`, `observedFromReturnMs`, and
`publicationToObservationMs`. Absolute timestamps are Unix milliseconds.
Observation durations use the monotonic clock. `F3.ts` is the timestamp just
before the hook writes/renames READY, a publication proxy rather than exact
rename time. Polling plus filesystem/tmux read and scheduler latency affects
observation times; it is not bounded solely by the nominal polling interval.
READY can precede adapter return, so signed return deltas may be negative.

Each sample also records M1 diagnostics (event/reason codes only), launch/stop
counts, ledger status/retry count, startup control IDs, ordered deliveries,
post-sample target stop, and HOME removal. Credentials, host paths, raw auth
outputs, raw environments, and panes do not enter evidence.

## Instrument checks (not runtime performance evidence)

```sh
node scripts/run-node-tests.js \
  skills/comm-bridge/scripts/__tests__/router-ready.measure-unit.test.js \
  skills/comm-bridge/scripts/__tests__/router-ready.measure.test.js
node scripts/run-node-tests.js \
  skills/comm-bridge/scripts/__tests__/router-activation.test.js \
  skills/comm-bridge/scripts/__tests__/router-startup.test.js
```

The first command verifies preflight rejection, explicit auth/expiry, whitelist
and redaction boundaries, order/duplicate negative controls, signed timing,
cleanup reporting and delayed-writer recreation regression, API-key auth status regression, help/version passthrough, machine/exclusion accounting, and worker cold/repeat/four-fault execution using an explicitly
test-only CLI stand-in that invokes real M3 hooks. That calibration is not a
real authenticated Claude/Codex startup sample. The second command retains the
existing 36 controlled-clock router regressions as a separate result.
