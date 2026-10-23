# Sleep isolation follow-up

No SQLite, Node, or third-party library is linked into `sleep.c`. It calls nanosleep 59 times using the observed default SQLite busy sequence (1,2,5,10,15,20,25,25,25,50,50, then 100ms through call58, final72ms). Requested total is5000ms. Each row records CLOCK_MONOTONIC elapsed around nanosleep only and its return value; printf is outside that measured interval, but can affect later scheduling. No system setting or process priority was changed.

Build with `cc -O2 sleep.c -o sleep`. Run `./sleep > direct.jsonl`. The Node-child variant executes the same binary using Node spawnSync and redirects its captured stdout. The PTY variant runs the same shell command with an allocated PTY and stdout redirected to the log. All were launched through Codex exec_command with zsh; PTY is not an independent Terminal.app/login-session test. These are sequential samples, not randomized/controlled proof of a launch-mode effect.

Observed on macOS26.6.2 build25G83, Darwin25.6.0 arm64:

| Launch | Calls | Requested ms | Actual summed ms | Nonzero returns |
|---|---:|---:|---:|---:|
| shell direct |59|5000|11350.507001|0|
| Node v24.14.0 spawnSync child |59|5000|11012.645002|0|
| shell with PTY |59|5000|11290.881999|0|

Oversleep occurs outside SQLite in all three observed launches. This does not identify timer policy, QoS, App Nap, scheduling load, or the cause shared by these processes. It does not prove the phenomenon is universal across this host.

The ordinary no-trace native probe was rerun with explicit Node v25.9.0 ABI141, better-sqlite3 12.6.2, SQLite3.51.2. No-lock prepare0.290ms; ordinary WAL prepare0.084ms returns committed1 while writer holds uncommitted2; 8s EXCLUSIVE preopened/postlock prepare8174.820/8158.935ms, after lock release, then returns1. Actual holds8007.007/8002.890ms. Native5000ms cap remains unqualified.

An initial attempt used PATH Node v24.14.0 ABI137 against the existing ABI141 native module and failed ERR_DLOPEN_FAILED before opening a database. It is excluded from timing evidence; no dependency rebuild/install was performed. Explicitly select an ABI-compatible executable for the native probe. The C probe has no Node ABI dependency.

Next discriminating experiment: run this same C binary and native probe from an independent interactive terminal/login context, record launch ancestry and read-only scheduling/QoS observations, and compare repeated interleaved runs without changing host policy. A positive difference would narrow launch inheritance; equal oversleep would still not establish a host-wide or OS-policy cause. No full public API matrix rerun, no timeout threshold change, no claim that Mac qualification passed.
