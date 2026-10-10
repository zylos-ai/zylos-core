# Superseded macOS recovery primitive helper

This directory records the earlier native-helper implementation. It is excluded
from the npm package and is not used by the current upgrade or recovery paths.
The build script and native protocol tests are historical development evidence.
Current macOS behavior uses Node synchronization and same-attempt compensation;
interrupted ownership requires manual recovery. See
[the current recovery guide](../../docs/self-upgrade-recovery.md).

The following describes the superseded implementation.

`macos-recovery-helper` is a checked-in universal Mach-O executable (arm64 and
x86_64), independent of the Node ABI. End users do not compile it. It is not
setuid and does not choose recovery policy, open database paths, or run a shell.
The JavaScript caller fixes and validates the executable, its SHA-256 and the
controller script before use; recovery copies include this binary and checksum.

Protocol 1:

- `probe`: exit 0, JSON `{ "protocol": 1, "platform": "darwin", "status": "supported" }`.
- `identity PID`: exit 0, JSON `status: present`, `pid`, `boot` (boot UUID),
  `start` (decimal seconds + colon + six-digit microseconds); or `status: absent`
  and `pid` only when KERN_PROC_PID returns zero bytes. Kernel query failure,
  unexpected structure size/identity, or boot query failure returns exit 1,
  JSON `status: error` and numeric errno, plus a stderr diagnostic. Errors do
  **not** establish absence and must never authorize takeover. Invalid CLI
  input exits 64.
- `lock-exec WAIT_MS ABS_NODE ABS_SCRIPT [ARGS...]`: acquire exclusive flock on
  inherited fd 3 (owned private regular file), wait 0–5000 ms, then exec the
  absolute Node binary with the absolute controller script and arguments. The
  caller validates those fixed files. fd 3 survives exec. Exit 75 means timeout;
  other syscall errors exit 1. The inode is never removed. The parent's fd is
  another reference to the same open-file description: helper or exec-child
  exit does not release the lock while that parent reference remains open.
  The caller must close its descriptor in all outcomes. Conversely parent
  death does not release a lock held by its still-running exec child.
- `fullsync FD`: inherited fd >=3; fsync followed by F_FULLFSYNC, exit 0 only
  if both succeed. File and directory descriptors are supported on the tested
  APFS host. Failure is never downgraded to ordinary fsync. Callers must retain
  file-before-rename and directory-after-rename publication ordering. Successful
  calls are not evidence of physical power-loss recovery.

## Build provenance and reproducibility

Maintainers run `sh scripts/build-macos-recovery-helper.sh` on macOS with the
Apple command-line tools already installed. The script compiles the checked-in
C source for both architectures, sets executable mode and writes the bare hex
SHA-256 to `macos-recovery-helper.sha256`. There is no install-time build hook,
third-party library, Node header, or network download. Repeat builds with this
same toolchain produced byte-identical output. Builds with other toolchains
are not claimed byte-identical. Standard linker UUID commands are retained:
removing them caused dyld to reject the binary on the validation host.

Recorded build: Apple clang 21.0.0 (clang-2100.1.1.101), Apple LD 1267.0,
SDK 26.5, `-mmacosx-version-min=11.0`, arm64 + x86_64, on macOS 26.6.2 (25G83).
The deployment target describes the binary, not a tested support floor.

Validation command: `node --test cli/lib/__tests__/macos-recovery-native.test.js`.
Native arm64/macOS 26.6.2: 8 passed, 0 failed, 0 skipped. Tests use synthetic
private temporary files and only terminate captured test-child processes.
They cover identity continuity/absence, competing locks and bounded waits,
failed exec, inherited fd behavior, parent death while exec child retains the
lock, child death takeover, timeout, file/directory strong sync and invalid fd.
Intel execution and macOS 11 execution have **not** been tested. Neither have
permission-denied sysctl injection, physical power loss, logout/reboot,
real service stopping, live installation, or real database restore.
