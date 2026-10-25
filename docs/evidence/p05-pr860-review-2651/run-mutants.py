import pathlib, subprocess, tempfile, shutil, json, sys
root=pathlib.Path(sys.argv[1]).resolve(); out=pathlib.Path(sys.argv[2]).resolve(); out.mkdir(parents=True,exist_ok=True)
base='skills/activity-monitor/scripts/'
variants={
'post-fence-run-guard': (base+'supervisor-lifecycle.js', "          if (target.present && target.runId === request.expectedRunId) {", "          if (target.present) {", base+'__tests__/supervisor-lifecycle.test.js'),
'mismatch-is-error': (base+'supervisor-lifecycle.js', "catch (cause) { if (cause.code !== 'RUNID_MISMATCH') throw cause; }", "catch (cause) { throw cause; }", base+'__tests__/supervisor-lifecycle.test.js'),
'old-exit-confirmation': (base+'supervisor-exits.js', "          await this.scenes.stop(fresh);", "          await this.scenes.stop(fresh);\n          await this.scenes.observeFixedTarget({ expectedRunId: fresh.runId, tmuxTarget: fresh.tmuxTarget });", base+'__tests__/supervisor-exits.integration.test.js'),
}
results={}
for name,(source,before,after,test) in variants.items():
 dest=pathlib.Path(tempfile.mkdtemp(prefix=name+'-',dir=out))
 archive=subprocess.Popen(['git','archive','HEAD'],cwd=root,stdout=subprocess.PIPE)
 subprocess.run(['tar','-x','-C',str(dest)],stdin=archive.stdout,check=True);archive.stdout.close();assert archive.wait()==0
 for rel in subprocess.check_output(['git','diff','--name-only','HEAD'],cwd=root,text=True).splitlines():
  if (root/rel).is_file():shutil.copy2(root/rel,dest/rel)
 for rel in ['node_modules','skills/comm-bridge/node_modules','skills/scheduler/node_modules','skills/web-console/node_modules']:
  if (root/rel).exists():(dest/rel).symlink_to((root/rel).resolve(),target_is_directory=True)
 p=dest/source;s=p.read_text();assert s.count(before)==1,(name,s.count(before));p.write_text(s.replace(before,after))
 with (out/(name+'.log')).open('w') as log:result=subprocess.run(['node','scripts/run-node-tests.js',test],cwd=dest,stdout=log,stderr=subprocess.STDOUT)
 text=(out/(name+'.log')).read_text();assert result.returncode!=0,(name,'survived')
 results[name]={'returncode':result.returncode,'failed_tests':[line.strip() for line in text.splitlines() if line.startswith('✖ ')]}
 print(name,'detected',flush=True)
(out/'mutants.json').write_text(json.dumps(results,indent=2))
