#!/usr/bin/env python3
"""Isolated Linux stop mechanism evidence. Does not implement product stop."""
# HISTORICAL ONLY: retired cleanup policy; not current stop behavior/acceptance.

import os, sys, signal, time, json, pathlib, subprocess, tempfile, shlex, platform
if sys.platform != "linux":
    raise SystemExit("This controlled process probe requires Linux /proc")

def ident(pid):
    try:
        s=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
        return {'pid':pid,'state':s[0],'ppid':int(s[1]),'start':s[19]}
    except (FileNotFoundError,ProcessLookupError): return None

def alive(i):
    now=ident(i['pid'])
    return bool(now and now['start']==i['start'] and now['state'] not in ('Z','X'))

def bounded_wait(pred,seconds=1):
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        if pred(): return True
        time.sleep(.02)
    return pred()

def runtime(directory,mode):
    d=pathlib.Path(directory)
    deadline=time.monotonic()+30
    signal.signal(signal.SIGHUP,signal.SIG_IGN)
    if mode=='kill': signal.signal(signal.SIGTERM,signal.SIG_IGN)
    child=os.fork()
    if not child:
        os.setsid() # descendant survives pane close / process-group-only signals
        (d/'child').write_text(str(os.getpid()))
        while time.monotonic()<deadline: time.sleep(.05)
        os._exit(0)
    (d/'parent').write_text(str(os.getpid()))
    while time.monotonic()<deadline: time.sleep(.05)
    os._exit(0)

if len(sys.argv)>1 and sys.argv[1]=='runtime':
    runtime(sys.argv[2],sys.argv[3]); sys.exit()

out={'kind':'controlled-process-mechanism-not-product-acceptance','platform':platform.platform(),'tmux':subprocess.check_output(['tmux','-V'],text=True).strip(),'cases':[]}
for mode in ('term','kill','signals-denied'):
    d=pathlib.Path(tempfile.mkdtemp(prefix='session-stop-probe-'))
    sock=str(d/'sock')
    env={'HOME':str(d),'PATH':'/usr/local/bin:/usr/bin:/bin','TERM':'xterm'}
    def tm(*args): return subprocess.run(['tmux','-S',sock,'-f','/dev/null',*args],env=env,capture_output=True,text=True,timeout=2)
    tracked=[]; row={'mode':mode,'directory':str(d),'runId':None}
    try:
        cmd=shlex.join([sys.executable,str(pathlib.Path(__file__).resolve()),'runtime',str(d),'kill' if mode!='term' else 'term'])
        r=tm('new-session','-d','-s','legacy-probe','exec '+cmd); assert r.returncode==0,r.stderr
        assert bounded_wait(lambda:(d/'parent').exists() and (d/'child').exists()),'runtime readiness'
        parent=int((d/'parent').read_text()); child=int((d/'child').read_text())
        tracked=[ident(parent),ident(child)]
        pane=int(tm('list-panes','-t','=legacy-probe','-F','#{pane_pid}').stdout.strip())
        assert all(tracked), 'controlled process exited before observation'
        assert pane==parent and tracked[1]['ppid']==parent
        assert b'ZYLOS_RUN_ID=' not in pathlib.Path(f'/proc/{parent}/environ').read_bytes()
        row['before']={'pane_pid':pane,'processes':tracked,'tmuxPresent':tm('has-session','-t','=legacy-probe').returncode==0}
        assert row['before']['tmuxPresent']
        # Identity mismatch is rejected, never signalled (simulated reused PID identity).
        wrong=dict(tracked[0],start='impossible'); assert not alive(wrong)
        row['wrongStartIdentityRejected']=True
        assert tm('kill-session','-t','=legacy-probe').returncode==0
        assert bounded_wait(lambda:tm('has-session','-t','=legacy-probe').returncode!=0)
        time.sleep(.1)
        row['afterPaneClose']={'tmuxPresent':False,'runtimeAlive':alive(tracked[0]),'descendantAlive':alive(tracked[1])}
        assert all(alive(x) for x in tracked),'HUP ignored survivor counterexample'
        signals=[]
        start=time.monotonic()
        for sig in (signal.SIGTERM,signal.SIGKILL):
            for i in tracked:
                if alive(i):
                    signals.append({'pid':i['pid'],'signal':sig.name,'sent':mode!='signals-denied'})
                    if mode!='signals-denied':
                        # Snapshot identity check; check-to-kill PID reuse race remains.
                        if alive(i): os.kill(i['pid'],sig)
            if bounded_wait(lambda:not any(alive(x) for x in tracked),.25): break
        row['signals']=signals
        row['boundedConfirmMs']=round((time.monotonic()-start)*1000)
        row['result']='STOP_UNCONFIRMED' if any(alive(x) for x in tracked) else 'confirmed-known-processes-ended'
        assert (row['result']=='STOP_UNCONFIRMED') == (mode=='signals-denied')
        row['remaining']=[ident(i['pid']) for i in tracked]
    finally:
        # Recover only this case's controlled processes if setup failed early.
        for role in ('parent','child'):
            file=d/role
            if file.exists():
                pid=int(file.read_text())
                try:
                    cmdline=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes()
                    if str(d).encode() in cmdline and str(pathlib.Path(__file__).resolve()).encode() in cmdline:
                        current=ident(pid)
                        if current and not any(i and i['pid']==pid for i in tracked): tracked.append(current)
                except FileNotFoundError: pass
        for i in tracked:
            if i and alive(i):
                if alive(i): os.kill(i['pid'],signal.SIGKILL)
        tm('kill-server')
        assert bounded_wait(lambda:not any(alive(i) for i in tracked if i)), 'cleanup failed'
        row['cleanupConfirmed']=True
    out['cases'].append(row)
print(json.dumps(out,indent=2))
