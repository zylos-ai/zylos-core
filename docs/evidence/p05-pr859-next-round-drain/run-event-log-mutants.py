from pathlib import Path
import subprocess, shutil, json, hashlib, sys
source=Path(sys.argv[1]).resolve()
evidence=Path(sys.argv[2]).resolve();evidence.mkdir(parents=True,exist_ok=True)
original=(source/'cli/lib/event-log.js').read_text()
tests=(source/'cli/lib/__tests__/event-log.test.js').read_bytes()
old=subprocess.check_output(['git','show','5dd32b23ad5451736cf087da41b92c034b21c22b:cli/lib/event-log.js'],cwd=source).decode()
needle=" fs.appendFileSync(file,JSON.stringify(event)+'\\n',{flag:'a',mode:0o600});"
replacement=" const fd=fs.openSync(file,'a',0o600),line=Buffer.from(JSON.stringify(event)+'\\n'),mid=Math.floor(line.length/2);\n try{fs.writeSync(fd,line.subarray(0,mid));fs.writeSync(fd,line.subarray(mid));}finally{fs.closeSync(fd);}"
assert needle in original
summary=[]
for name,code,repeats in [('same-round-drain',old,1),('split-write',original.replace(needle,replacement),10)]:
 root=evidence/('mutant-'+name)
 for rel in ['scripts/run-node-tests.js','scripts/test-environment.js','package.json','cli/lib/__tests__/event-log.test.js']:
  dst=root/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/rel,dst)
 (root/'cli/lib/event-log.js').write_text(code)
 for i in range(repeats):
  log=evidence/f'event-log-mutant-{name}-{i+1:02}.log'
  result=subprocess.run(['node','scripts/run-node-tests.js','cli/lib/__tests__/event-log.test.js'],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  log.write_text(result.stdout)
  failed=[line for line in result.stdout.splitlines() if line.startswith('✖ ') and not line.startswith('✖ failing')]
  summary.append({'variant':name,'iteration':i+1,'exit':result.returncode,'failures':failed})
assert (source/'cli/lib/event-log.js').read_text()==original
assert (source/'cli/lib/__tests__/event-log.test.js').read_bytes()==tests
(evidence/'event-log-mutants.json').write_text(json.dumps({'sourceSha256':hashlib.sha256(original.encode()).hexdigest(),'testSha256':hashlib.sha256(tests).hexdigest(),'runs':summary},indent=2)+'\n')
print(json.dumps(summary,indent=2))
