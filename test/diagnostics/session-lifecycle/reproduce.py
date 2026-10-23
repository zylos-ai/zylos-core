#!/usr/bin/env python3
import subprocess as sp, os, signal, time, pathlib, json, shlex, tempfile, sys, argparse
if sys.platform != 'linux': raise SystemExit('Linux /proc is required by this diagnostic')
parser=argparse.ArgumentParser();parser.add_argument('--output',type=pathlib.Path);args=parser.parse_args()
RUN=pathlib.Path(tempfile.mkdtemp(prefix='p02-protocol-',dir='/tmp'))
SOCKET=str(RUN/'tmux.sock'); (RUN/'home').mkdir()
ENV={'HOME':str(RUN/'home'),'PATH':os.environ.get('PATH','/usr/bin:/bin'),'TERM':'xterm','LANG':'C'}
OUTPUT=args.output or RUN/'results.json'
LOG=[]; clients=[]; server=None; launcher_pid=None

def event(name,**kw):
    obj={'event':name,'monotonic':time.monotonic(),**kw}; LOG.append(obj); print(json.dumps(obj),flush=True)
def tmux(*args,check=True):
    p=sp.run(['tmux','-S',SOCKET,'-f','/dev/null',*args],env=ENV,text=True,capture_output=True,timeout=3)
    if check and p.returncode: raise RuntimeError(p.stderr)
    return p

def waitfor(fn,seconds=3):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if fn(): return
        time.sleep(.01)
    raise RuntimeError('condition timeout')
def control(label):
    f=open(RUN/(label+'.control.log'),'w')
    p=sp.Popen(['tmux','-S',SOCKET,'-C','attach','-f','ignore-size,no-output','-t','=keeper'],stdin=sp.PIPE,stdout=f,stderr=f,text=True,env=ENV)
    clients.append((p,f)); waitfor(lambda:'%end ' in (RUN/(label+'.control.log')).read_text())
    return p

def send(p,args):
    p.stdin.write(' '.join(shlex.quote(a) for a in args)+'\n');p.stdin.flush()
    event('control_stdin_written',argv=args,client=p.pid)
def killclient(p):
    p.kill();rc=p.wait(timeout=2);event('client_exit_confirmed',pid=p.pid,returncode=rc)
def exists(name): return tmux('has-session','-t','='+name,check=False).returncode==0
try:
    event('environment',tmux_version=sp.check_output(['tmux','-V'],text=True).strip(),python=sys.version,run_dir=str(RUN))
    tmux('new-session','-d','-s','keeper','sleep 300')
    server=int(tmux('display-message','-p','#{pid}').stdout.strip())
    event('private_server',pid=server,socket=SOCKET)
    # new-session completion is not launcher exec completion.
    launcher=RUN/'launcher.py'
    launcher.write_text("import pathlib,time,os\np=pathlib.Path("+repr(str(RUN))+ ")\n(p/'launcher-started').write_text(str(os.getpid()))\nend=time.monotonic()+5\nwhile not (p/'release-exec').exists() and time.monotonic()<end: time.sleep(.01)\nif not (p/'release-exec').exists(): raise SystemExit(2)\nos.execv('/bin/sleep',['sleep','300'])\n")
    tmux('new-session','-d','-s','normal',shlex.join([sys.executable,str(launcher)]))
    waitfor(lambda:(RUN/'launcher-started').exists());pid=int((RUN/'launcher-started').read_text());launcher_pid=pid
    before=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0',b' ').decode()
    event('new_session_returned_before_exec',session_present=exists('normal'),launcher_pid=pid,cmdline=before)
    assert str(launcher) in before
    (RUN/'release-exec').touch();waitfor(lambda:pathlib.Path(f'/proc/{pid}/comm').read_text().strip()=='sleep')
    event('exec_observed_separately',pid=pid,comm=pathlib.Path(f'/proc/{pid}/comm').read_text().strip())
    # Pre-submit budget expiry can safely refrain from submitting.
    deadline=time.monotonic()-.01
    submitted=False
    if time.monotonic()<deadline:
        tmux('new-session','-d','-s','pretimeout','sleep 300');submitted=True
    event('pre_submit_timeout_branch_only',submitted=submitted,session_present=exists('pretimeout'));assert not exists('pretimeout')
    # client exit alone does not retract server-bound work.
    p=control('late');os.kill(server,signal.SIGSTOP);event('server_stopped',case='raw')
    send(p,['new-session','-d','-s','late','sleep 300']);time.sleep(.2)
    killclient(p);event('simulated_failure_return',case='raw')
    os.kill(server,signal.SIGCONT);time.sleep(.5)
    event('session_after_resume',case='raw',session_present=exists('late'),note='stdin flush alone does not prove socket delivery; absence not proof of cancellation')
    # Compare a lock-backed gate with retained/disconnected clients.
    for label, background, disconnect in [('gate_retained',False,False),('gate_killed',False,True),('background_killed',True,True)]:
        case=RUN/label;case.mkdir();gate=case/'gate.py'
        gate.write_text("import pathlib,time,fcntl,sys\np=pathlib.Path("+repr(str(case))+")\nwith (p/'gate.lock').open('a') as f:\n fcntl.flock(f,fcntl.LOCK_EX)\n allowed=not (p/'revoked').exists()\n (p/'gate-decided').write_text(str(allowed))\n end=time.monotonic()+5\n while not (p/'release-gate').exists() and time.monotonic()<end: time.sleep(.01)\n if not (p/'release-gate').exists(): sys.exit(2)\n (p/'gate-exiting').touch()\nsys.exit(0 if allowed else 1)\n")
        p=control(label)
        send(p,['if-shell',*(['-b'] if background else []),shlex.join([sys.executable,str(gate)]),"new-session -d -s "+label+" 'sleep 300'"])
        waitfor(lambda:(case/'gate-decided').exists());assert (case/'gate-decided').read_text()=='True'
        os.kill(server,signal.SIGSTOP);event('server_stopped',case=label)
        (case/'release-gate').touch();waitfor(lambda:(case/'gate-exiting').exists())
        import fcntl
        with (case/'gate.lock').open('a') as f:
            def lock_available():
                try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);return True
                except BlockingIOError:return False
            waitfor(lock_available)
            (case/'revoked').touch();fcntl.flock(f,fcntl.LOCK_UN)
        event('revoked_under_same_lock',case=label)
        if disconnect:killclient(p)
        event('simulated_failure_return',case=label,client_disconnected=disconnect)
        os.kill(server,signal.SIGCONT);time.sleep(.5)
        present=exists(label)
        event('session_after_resume',case=label,session_present=present)
        if not disconnect:assert present, 'retained gate should expose stale successful decision'
    event('assertions_passed',count=6,meaning='Mechanism observations only; observed absence is not cancellation proof')
finally:
    if server:
        try: os.kill(server,signal.SIGCONT)
        except ProcessLookupError: pass
    for p,f in clients:
        if p.poll() is None:p.kill();p.wait(timeout=2)
        f.close()
    if server:
        cleanup=tmux('kill-server',check=False);event('private_server_cleanup',returncode=cleanup.returncode)
    def live(pid):
        try: return pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()[0] not in ('Z','X')
        except FileNotFoundError:return False
    for label,owned_pid in [('server',server),('launcher',launcher_pid)]:
        if owned_pid:
            waitfor(lambda:not live(owned_pid))
            event('owned_process_not_live',role=label,pid=owned_pid)
    event('output',path=str(OUTPUT))
    OUTPUT.write_text(json.dumps(LOG,indent=2)+'\n')
