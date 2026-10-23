# Linux identity-bound process signals

`SessionAdapter.stop` uses a Core-owned, short-lived helper with a Linux pidfd.
The ESM wrapper owns its private stdin/stdout pipes. The helper opens a pidfd
before acknowledging READY, accepts only TERM/KILL commands, and closes on EOF.
It has no socket, service, inherited run environment, interpreter dependency,
or numeric-PID signal fallback.

For every matched PID/start tuple, stop acquires a handle before rechecking UID,
run environment and incarnation. On the present-session path this happens before
tmux mutation. The same handle is retained for TERM and KILL, with ownership
revalidated before each send. An exited pinned process cannot redirect the signal
to a reused numeric PID. Re-enumeration remains mandatory: an ESRCH response by
itself never proves that all matching processes have exited. A newly found
matching descendant gets its own handle; a previously seen PID changing
incarnation remains unconfirmed. All acquired handles close on every exit path,
including partial acquisition, revalidation, send, and re-enumeration failures.

Unavailable helpers, denied/unsupported syscalls, broken pipes, helper exit,
invalid protocol and response timeout produce `STOP_UNCONFIRMED`. This does not
extend the existing absent-session/lookup-unavailable unknown-success exception:
failure to send a required identity-bound signal is not lookup unavailability.
The private helper response/close bound is 3 seconds; it is not a new launch
settlement timeout. Target disappearance still uses the existing TERM/grace/KILL
and ownership re-enumeration rules.

## Explicit build and distribution boundary

Build in a development/build environment with a C compiler and Linux headers
that declare the pidfd syscalls:

```sh
node scripts/build-process-signal.js "cli/lib/runtime/native/pidfd-signal-$(node -p process.arch)"
```

The output is the wrapper's package-relative default executable. `CC` may name
a compiler executable path. No shell command is evaluated and no compiler,
header, library or prebuilt binary is downloaded. Building outside the package
is also supported by passing an explicit output path; tests use private temp
outputs and pass that path through the adapter's internal options.

The helper uses libc and kernel syscalls, without a third-party FFI package,
Python runtime or Node ABI addon. Runtime requires a compatible helper binary,
libc and permitted pidfd syscalls (`pidfd_open` was introduced in Linux 5.3).
An older kernel or a syscall-denying sandbox fails closed. Native x64 and arm64
artifacts need their own build/compatibility evidence; a local x64 build does
not establish arm64 or all-libc compatibility.

**Distribution is still pending.** This source increment does not add an
installer/upgrade compiler prerequisite, lifecycle hook, binary download,
release pipeline, or committed binary. A source checkout or archive containing
only these sources has no default helper until explicitly built. With active
matching processes it therefore refuses stop; it does not silently retain the
old unsafe signal path. Before release/integration, produce and verify the
required architecture/libc artifacts in the chosen existing build flow and
verify their package inclusion. This is an additional native artifact
requirement, not a claim that every current host already has the compiler.

## Focused verification

```sh
node --test cli/lib/runtime/__tests__/session-process-signal.test.js \
  cli/lib/runtime/__tests__/session-stop-handles.test.js
```

The native tests explicitly compile in temporary directories, need the build
toolchain, and assert helper children are reaped. In the split adapter checkout,
the live tmux tests additionally need the actual A provider:

```sh
P02_REQUIRE_REAL_P01=1 P02_REAL_A_ROOT=/absolute/actual-A-provider \
  node --test cli/lib/runtime/__tests__/session-stop-live.test.js
```

Real PID reuse acceptance, from a source checkout with a separately built helper:

```sh
unshare --user --map-root-user --pid --fork --mount-proc \
  node test/diagnostics/session-lifecycle/stop-pidfd-reuse.mjs /absolute/helper
```

This requires an authorized private PID/user/mount-proc namespace. If local
namespace creation is denied, report that environment failure; do not run its
PID-allocator write on the host. The fixture injects a scheduling barrier after
the real final ownership read, reaps the original, creates a distinct same-PID
process without the run ID, and asserts that it survives and the handle closes.
`--control-numeric` deliberately replaces the handle's send with numeric kill;
the same acceptance must then fail. `P02_ADAPTER_MODULE=file:///...` can select an
exact prior adapter source for an old-source negative control.

This closes the demonstrated numeric-PID replacement signal window when the
native backend is available. It does not make separate environment/exec reads
atomic, recover historical untagged descendants, implement Darwin, or cover
all concurrent fork/environment-mutation scenarios. Those remain separate
observation/ownership work.

API references: [Node process.kill](https://nodejs.org/docs/latest-v20.x/api/process.html#processkillpid-signal),
[pidfd_open](https://man7.org/linux/man-pages/man2/pidfd_open.2.html),
[pidfd_send_signal](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html).
