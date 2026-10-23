# Process identity and signal boundary probes

These are diagnostic programs, not a production process backend. They use only
new controlled processes. They need no model, account, production tmux socket,
or credential. Run from this directory in a source checkout.

## Real PID reuse after the last ownership observation

On Linux with unprivileged user/PID/mount namespaces enabled:

```sh
unshare --user --map-root-user --pid --fork --mount-proc node stop-pid-reuse.mjs
unshare --user --map-root-user --pid --fork --mount-proc python3 pidfd-reuse-control.py
```

The Node probe invokes the actual `SessionAdapter.stop`, production ownership
reader/scanner, and default `process.kill`. Enumeration is restricted to the
independently known fixture PID. The tmux dependency reports absent; this probe
isolates the subsequent process cleanup, not tmux integration.

A scheduler barrier in the injected ownership reader runs **after** obtaining
the real ownership tuple and before returning it to the caller. It reaps the
original process, adjusts only the private namespace's PID allocator, and starts
an unrelated process at that same numeric PID with a distinct start tick and no
run ID. No ownership tuple, proc file, or kernel signal is fabricated. The
asserted counterexample is that the replacement receives TERM and the adapter
returns success. This establishes a possible interleaving, not its unassisted
frequency. The program exits nonzero if it cannot establish its prerequisites;
it does not skip or claim a pass.

The Python control opens a real pidfd **before** original exit, reaps it, then
starts a same-PID replacement. Signalling the old pidfd must return ESRCH while
the replacement remains alive. It demonstrates the relevant Linux primitive;
it does not integrate that primitive into Node, cover every ownership/exec race,
or implement the production stop loop. Syscall numbers are restricted to Linux
x86_64 and aarch64; Python/libc is a diagnostic dependency only.

Both programs require PID 1 inside a fresh private namespace. Do not remove that
guard or write the host's `ns_last_pid`. Namespace exit also removes remaining
namespace processes.

## Native Darwin capability probe

On macOS with an already installed C toolchain:

```sh
cc -Wall -Wextra -Werror darwin-observation-probe.c -lproc -o /tmp/p02-darwin-probe
/tmp/p02-darwin-probe
```

No toolchain installation is performed. The binary starts one copy of itself
with synthetic environment, an empty argument, an argument with spaces and a
private cwd. It checks native `proc_pidinfo(PROC_PIDTBSDINFO)` before/after,
`proc_pidpath`, `PROC_PIDVNODEPATHINFO`, and `sysctl(KERN_PROCARGS2)`. It emits
booleans and identity numbers rather than arbitrary environment contents, and
reaps the child before returning. Failure to obtain a complete matching image
is a failure, not evidence of process exit. Non-Darwin builds explicitly return
78 with `not-run`; this fallback does not validate the Darwin branch.

This is a capability probe for an available Mac, not a complete backend. A real
backend still needs missing/exited/permission distinctions, exact ownership
enumeration, malformed/truncated buffer handling, executable/script identity,
and replacement/exec races. Separate native reads bracketed by a start time do
not form an atomic snapshot of a same-PID exec. Do not remove a platform guard
on the strength of this source or a Linux compile.

Native API declarations and implementation reference:
[Apple XNU proc_info.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h),
[libproc.h](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h),
[KERN_PROCARGS2 implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c).
