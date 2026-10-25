from pathlib import Path
import re,json,subprocess,os,collections,time
E=Path(__file__).resolve().parent
R=E/'measurement/baseline'
def failures(text):
 text=text.split('✖ failing tests:')[-1]
 return [{'file':m[1].split(':')[0],'location':m[1],'name':re.sub(r' \([0-9.]+ms\)$','',m[2])} for m in re.finditer(r'test at ([^\n]+)\n✖ ([^\n]+)',text)]
a=failures((E/'c-full-node.log').read_text());assert a
files=sorted(set(x['file'] for x in a));(E/'c-failing-files.json').write_text(json.dumps(files,indent=2))
start=time.time()
C=E.parent/'p05-c-2635'
with (E/'c-final-failing-files.log').open('w') as log:
 current=subprocess.run(['node','scripts/run-node-tests.js',*files],cwd=C,env={**os.environ,'ZYLOS_PACKAGE_ROOT':str(C)},stdout=log,stderr=subprocess.STDOUT)
initial=a
a=failures((E/'c-final-failing-files.log').read_text())
with (E/'c-baseline-failing-files.log').open('w') as log:
 r=subprocess.run(['node','scripts/run-node-tests.js',*files],cwd=R,env={**os.environ,'ZYLOS_PACKAGE_ROOT':str(R)},stdout=log,stderr=subprocess.STDOUT)
b=failures((E/'c-baseline-failing-files.log').read_text())
f=lambda rows:collections.Counter((x['file'],x['name']) for x in rows)
x,y=f(a),f(b)
result={'baseline':'da126d7c22afffda0cc397f1ca2c47e43bbebcab','baselineExit':r.returncode,'currentSubsetExit':current.returncode,'initialFullFailures':initial,'seconds':time.time()-start,'finalFailureEntries':a,'baselineFailureEntries':b,'sameNamedFailureMultiset':x==y,'new':list((x-y).elements()),'baselineOnly':list((y-x).elements())}
(E/'c-failure-comparison.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if not k.endswith('Entries') and k!='initialFullFailures'}),flush=True)
