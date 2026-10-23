#!/usr/bin/env python3
"""Historical ownership loss before legacy stop; Linux mechanism evidence only."""
import ctypes, json, os, pathlib, platform, shlex, signal, subprocess, sys, tempfile, time


def identity(pid):
    try:
        fields = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'state': fields[0], 'ppid': int(fields[1]), 'pgrp': int(fields[2]), 'sid': int(fields[3]), 'start': fields[19]}
    except (FileNotFoundError, ProcessLookupError):
        return None


def wait(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.02)
    assert predicate(), 'bounded observation failed'


def standin(directory):
    directory = pathlib.Path(directory)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.alarm(20)  # independent cleanup if harness dies
    middle = os.fork()
    if middle == 0:
        os.setsid()
        child = os.fork()
        if child:
            os._exit(0)
        signal.alarm(20)
        (directory / 'orphan.json').write_text(json.dumps(identity(os.getpid())))
        while True:
            signal.pause()
    os.waitpid(middle, 0)
    (directory / 'root.json').write_text(json.dumps(identity(os.getpid())))
    while True:
        signal.pause()


if len(sys.argv) > 1 and sys.argv[1] == 'standin':
    standin(sys.argv[2])
    sys.exit()

assert sys.platform == 'linux' and platform.machine() == 'x86_64'
# This host's Python 3.8 lacks pidfd wrappers. These syscall numbers are Linux
# x86_64 only; fail closed elsewhere rather than fall back to numeric kill.
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

def syscall(number, *args):
    value = libc.syscall(number, *args)
    if value < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    return value

def pidfd_open(pid):
    return syscall(434, ctypes.c_int(pid), ctypes.c_uint(0))

def pidfd_signal(fd, sig):
    return syscall(424, ctypes.c_int(fd), ctypes.c_int(sig), ctypes.c_void_p(), ctypes.c_uint(0))
tmux = os.environ.get('TMUX_BIN', 'tmux')
directory = pathlib.Path(tempfile.mkdtemp(prefix='zylos-legacy-orphan-'))
env = {'HOME': str(directory), 'PATH': '/usr/bin:/bin', 'TERM': 'xterm'}
handles = []


def command(*args):
    return subprocess.run([tmux, '-S', str(directory / 'socket'), '-f', '/dev/null', *args], env=env, capture_output=True, text=True, timeout=3)


def acquire(row):
    fd = pidfd_open(row['pid'])
    current = identity(row['pid'])
    if not current or current['start'] != row['start']:
        os.close(fd)
        raise AssertionError('identity changed during handle acquisition')
    handles.append((row, fd))
    return fd


def alive(row):
    current = identity(row['pid'])
    return current and current['start'] == row['start'] and current['state'] not in ('Z', 'X')


try:
    script = shlex.join([sys.executable, str(pathlib.Path(__file__).resolve()), 'standin', str(directory)])
    result = command('new-session', '-d', '-s', 'legacy', 'exec ' + script)
    assert result.returncode == 0, result.stderr
    wait(lambda: (directory / 'root.json').exists() and (directory / 'orphan.json').exists())
    root = json.loads((directory / 'root.json').read_text())
    orphan = json.loads((directory / 'orphan.json').read_text())
    root_fd = acquire(root)
    acquire(orphan)
    wait(lambda: identity(orphan['pid'])['ppid'] != root['pid'])
    orphan = identity(orphan['pid'])
    # Stop-entry observations: snapshot contains all readable process ancestry.
    snapshot = {}
    for entry in pathlib.Path('/proc').iterdir():
        if entry.name.isdigit():
            row = identity(int(entry.name))
            if row:
                snapshot[row['pid']] = row
    descendants = {root['pid']}
    while True:
        expanded = descendants | {pid for pid, row in snapshot.items() if row['ppid'] in descendants}
        if expanded == descendants:
            break
        descendants = expanded
    assert orphan['pid'] not in descendants
    assert orphan['sid'] != root['sid'] and orphan['pgrp'] != root['pgrp']
    assert all(b'ZYLOS_RUN_ID=' not in pathlib.Path(f'/proc/{row["pid"]}/environ').read_bytes() for row in (root, orphan))
    assert command('has-session', '-t', '=legacy').returncode == 0
    result = {'kind': 'mechanism-counterexample-not-product-acceptance', 'tmux': subprocess.check_output([tmux, '-V'], text=True).strip(), 'directory': str(directory), 'stopEntry': {'root': root, 'orphan': orphan, 'discoverableDescendants': sorted(descendants), 'runId': None}}
    assert command('kill-session', '-t', '=legacy').returncode == 0
    pidfd_signal(root_fd, signal.SIGTERM)
    wait(lambda: not alive(root))
    assert alive(orphan)
    result['afterKnownTreeExit'] = {'tmuxAbsent': command('has-session', '-t', '=legacy').returncode != 0, 'rootExited': True, 'historicalDescendantAlive': True}
    assert result['afterKnownTreeExit']['tmuxAbsent']
finally:
    # Handles only refer to this probe's processes; never signal numeric PIDs.
    for row, fd in handles:
        try:
            pidfd_signal(fd, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(fd)
    command('kill-server')
    for row, _ in handles:
        wait(lambda row=row: not alive(row))
if 'result' in globals():
    result['cleanupConfirmed'] = True
    print(json.dumps(result, indent=2))
