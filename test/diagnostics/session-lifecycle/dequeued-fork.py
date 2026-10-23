#!/usr/bin/env python3
"""Optional Linux/gdb probe of client disconnect after server dequeues creation."""
import pathlib,tempfile,subprocess as sp,os,time,signal,json,sys,shlex
if sys.platform!='linux':raise SystemExit('Linux required')
r=pathlib.Path(tempfile.mkdtemp(prefix='tmux-fork-probe-'));(r/'home').mkdir()
env={'HOME':str(r/'home'),'PATH':os.environ.get('PATH','/usr/bin:/bin'),'TERM':'xterm','LANG':'C'}
tmux=os.environ.get('TMUX_BINARY','tmux')
socket=str(r/'socket'); server=None;control=None;debugger=None;events=[]
def log(event,**kw):
    row={'event':event,'monotonic':time.monotonic(),**kw};events.append(row);print(json.dumps(row),flush=True)
def cmd(*a,check=True):
    p=sp.run([tmux,'-S',socket,'-f','/dev/null',*a],capture_output=True,text=True,timeout=3,env=env)
    if check and p.returncode:raise RuntimeError(p.stderr)
    return p
def wait(fn,seconds=5):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if fn():return
        if debugger is not None and debugger.poll() is not None and not (r/'before-fork').exists():raise RuntimeError('gdb exited before breakpoint; see log')
        time.sleep(.01)
    raise RuntimeError('bounded wait expired')
try:
    log('environment',tmux=sp.check_output([tmux,'-V'],text=True,env=env).strip(),python=sys.version)
    barrier=r/'barrier.py'
    barrier.write_text("import pathlib,time,sys\np=pathlib.Path("+repr(str(r))+ ")\nend=time.monotonic()+5\nwhile not (p/'release-server').exists() and time.monotonic()<end: time.sleep(.01)\nif not (p/'release-server').exists(): (p/'barrier-expired').touch()\n")
    commands=r/'gdb.commands';commands.write_text('set pagination off\nset confirm off\nset breakpoint pending on\nset follow-fork-mode parent\nset detach-on-fork on\nbreak forkpty\nignore 1 1\nrun\nbt\nshell touch '+str(r/'before-fork')+'\nshell '+shlex.join([sys.executable,str(barrier)])+'\ndetach\nquit\n')
    g=open(r/'gdb.log','w');debugger=sp.Popen(['gdb','-q','-nx','-batch','-x',str(commands),'--args',tmux,'-S',socket,'-f','/dev/null','-D'],stdout=g,stderr=g,env=env)
    wait(lambda:pathlib.Path(socket).exists())
    cmd('new-session','-d','-s','keeper','sleep 60');server=int(cmd('display-message','-p','#{pid}').stdout)
    f=open(r/'control.log','w');control=sp.Popen([tmux,'-S',socket,'-C','attach','-t','=keeper'],stdin=sp.PIPE,stdout=f,stderr=f,text=True,env=env)
    wait(lambda:'%end ' in (r/'control.log').read_text())
    startup=r/'child-started'
    shell_command='echo $$ > '+shlex.quote(str(startup))+'; exec sleep 60'
    control.stdin.write('new-session -d -s late '+shlex.quote(shell_command)+'\n');control.stdin.flush()
    wait(lambda:(r/'before-fork').exists())
    log('server_at_forkpty_before_child_creation',server=server,run_dir=str(r),child_startup_marker=startup.exists())
    assert not startup.exists()
    control.kill();control.wait(timeout=2);log('client_killed_and_reaped',returncode=control.returncode)
    assert not (r/'barrier-expired').exists(), 'barrier expired before failure marker'
    assert not startup.exists(), 'child started before failure marker'
    log('simulated_failure_return_before_server_resumes')
    (r/'release-server').touch()
    debugger.wait(timeout=5);log('gdb_detached_server_resumed',returncode=debugger.returncode)
    present=cmd('has-session','-t','=late',check=False).returncode==0
    log('session_after_resume',present=present)
    wait(lambda:startup.exists())
    log('child_startup_after_resume',pid=int(startup.read_text()),marker_present=True)
    assert present,'expected already executing new-session to continue after client death'
finally:
    if debugger is not None and debugger.poll() is None:debugger.terminate();debugger.wait(timeout=3)
    if control is not None and control.poll() is None:control.kill();control.wait(timeout=2)
    if server:
        try:os.kill(server,signal.SIGCONT)
        except ProcessLookupError:pass
        log('private_server_cleanup',returncode=cmd('kill-server',check=False).returncode)
    if server:
        def not_live():
            try:return pathlib.Path(f'/proc/{server}/stat').read_text().split(') ',1)[1].split()[0] in ('Z','X')
            except FileNotFoundError:return True
        wait(not_live);log('private_server_confirmed_not_live',pid=server)
    if (r/'child-started').exists():
        child_pid=int((r/'child-started').read_text())
        def child_not_live():
            try:return pathlib.Path(f'/proc/{child_pid}/stat').read_text().split(') ',1)[1].split()[0] in ('Z','X')
            except FileNotFoundError:return True
        wait(child_not_live);log('private_child_confirmed_not_live',pid=child_pid)
    (r/'results.json').write_text(json.dumps(events,indent=2)+'\n');log('retained_evidence',directory=str(r))
