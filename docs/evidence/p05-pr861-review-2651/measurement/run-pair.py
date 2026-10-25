import pathlib,subprocess,os,json
E=pathlib.Path(__file__).resolve().parent
binary=pathlib.Path(os.environ.get('TEST_TMUX_BIN','tmux'))
for name in ['baseline','final']:
 env={**os.environ,'TEST_TMUX_BIN':str(binary),'P05_PROBE_OUTPUT':str(E/(name+'-results'))}
 with (E/(name+'.log')).open('w') as log:r=subprocess.run(['node','scripts/run-node-tests.js','skills/activity-monitor/scripts/__tests__/entry-round-probe.test.js'],cwd=E/name,env=env,stdout=log,stderr=subprocess.STDOUT)
 print(name,r.returncode,flush=True)
 if r.returncode:raise SystemExit(r.returncode)
for n in [1,4]:
 for name in ['baseline','final']:
  x=json.loads((E/(name+'-results')/f'groups-{n}.json').read_text());print(name,n,x['medianMs'],[s['tmuxCalls'] for s in x['samples']],x['samples'][0]['counts'])
