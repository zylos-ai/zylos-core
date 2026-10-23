"""Isolated Linux kernel control, NOT a production signalling backend.

unshare --user --map-root-user --pid --fork --mount-proc python3 pidfd-reuse-control.py
Uses libc syscall only on the two explicitly supported Linux architectures.
"""
import ctypes
import errno
import json
import os
import platform
import signal
import subprocess

assert os.getpid() == 1, 'requires a fresh private PID namespace'
assert platform.machine() in ('x86_64', 'aarch64'), 'check syscall numbers on this architecture'
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

def launch():
    with open('/proc/sys/kernel/ns_last_pid', 'w') as f:
        f.write('4000')
    process = subprocess.Popen(['/bin/sleep', '60'], env={'PATH':'/usr/bin:/bin'})
    assert process.pid == 4001
    return process

original = replacement = None
fd = -1
try:
    original = launch()
    fd = libc.syscall(434, original.pid, 0)  # pidfd_open
    assert fd >= 0, ('pidfd_open', ctypes.get_errno())
    original.kill()
    original.wait()
    replacement = launch()
    ctypes.set_errno(0)
    result = libc.syscall(424, fd, signal.SIGTERM, 0, 0)  # pidfd_send_signal
    error = ctypes.get_errno()
    assert result == -1 and error == errno.ESRCH, (result, error)
    assert replacement.poll() is None
    print(json.dumps({'result':'control-confirmed', 'pid':4001,
        'originalReaped':True, 'replacementSamePID':True,
        'oldPidfdSignalErrno':error, 'replacementAlive':True}))
finally:
    for process in (replacement, original):
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
    if fd >= 0:
        os.close(fd)
