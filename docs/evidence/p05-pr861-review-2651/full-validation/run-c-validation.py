from pathlib import Path
import subprocess,os,json,time
E=Path(__file__).resolve().parent;R=E.parent/'p05-c-2635'
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip()
rows=[]
for name,cmd in [('c-jest',['node','--experimental-vm-modules','node_modules/.bin/jest','--runInBand']),('c-full-node',['node','scripts/run-node-tests.js'])]:
 start=time.time()
 with (E/(name+'.log')).open('w') as f:r=subprocess.run(cmd,cwd=R,env={**os.environ,'ZYLOS_PACKAGE_ROOT':str(R)},stdout=f,stderr=subprocess.STDOUT)
 row={'name':name,'command':cmd,'head':head,'exitCode':r.returncode,'seconds':round(time.time()-start,3)};rows.append(row)
 (E/'c-validation-receipts.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
