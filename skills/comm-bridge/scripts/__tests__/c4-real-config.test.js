import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const scripts = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-real-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.zylos'));
  if (config !== undefined) fs.writeFileSync(path.join(root, '.zylos/config.json'), config);
  const env = { PATH: process.env.PATH, HOME: root, ZYLOS_DIR: root, TMUX_TMPDIR: root, LANG: 'en_US.UTF-8' };
  function run(code, expected = 0) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    return result;
  }
  const module = JSON.stringify(pathToFileURL(path.join(scripts, 'c4-db.js')).href);
  function db(code) { return JSON.parse(run(`const db = await import(${module}); try { ${code} } finally { db.close(); }`).stdout); }
  return { root, env, run, db, module };
}
for (const [config, runtime] of [[undefined, 'claude'], ['{"runtime":"codex","session_mode":"multi"}', 'codex']]) {
  test(`real F1 baseline resolves ${runtime} without a default-reader stub`, t => {
    const f = fixture(t, config);
    const result = f.db("console.log(JSON.stringify(db.resolveSessionLaunchConfig({sessionGroup:'origin',sessionMode:'single'})))");
    assert.deepEqual(result, { runtime, mode: 'default' });
  });
}
test('runtime model validator rejects unavailable executable without persisting an override', t => {
  const f = fixture(t);
  f.env.CODEX_BIN = path.join(f.root, 'no-runtime');
  const result=f.db("try { db.setSessionModelConfig({sessionGroup:'origin',runtime:'codex',model:'m',effort:'high'}); } catch(e) { console.log(JSON.stringify({code:e.code,rows:db.getDb().prepare('SELECT * FROM group_model_overrides').all()})); }");
  assert.equal(result.code,'MODEL_CONFIG_INVALID'); assert.deepEqual(result.rows,[]);
});
test('runtime config re-reads strict F1 on each resolution', t => {
  const f=fixture(t,'{"runtime":"claude"}');
  const result=f.db(`const fs=await import('node:fs'); const before=db.resolveSessionLaunchConfig({sessionGroup:'origin',sessionMode:'single'}); fs.writeFileSync(${JSON.stringify(path.join(f.root,'.zylos/config.json'))},'{"runtime":"codex"}'); const after=db.resolveSessionLaunchConfig({sessionGroup:'origin',sessionMode:'single'}); console.log(JSON.stringify({before,after}));`);
  assert.equal(result.before.runtime,'claude'); assert.equal(result.after.runtime,'codex');
});
test('copied skill resolves F1 from explicit Core package root', t => {
  const f=fixture(t,'{"runtime":"codex"}');
  const skill=path.join(f.root,'.claude/skills/comm-bridge');
  const copied=path.join(skill,'scripts');
  fs.mkdirSync(skill,{recursive:true});
  fs.cpSync(scripts,copied,{recursive:true,filter:source=>!['__tests__','diagnostics'].includes(path.basename(source))});
  fs.writeFileSync(path.join(skill,'package.json'),'{"type":"module"}');
  fs.symlinkSync(path.resolve(scripts,'../node_modules'),path.join(skill,'node_modules'),'dir');
  const coreRoot=path.resolve(scripts,'../../..');
  const code=`const db=await import(${JSON.stringify(pathToFileURL(path.join(copied,'c4-db.js')).href)}); try { console.log(JSON.stringify(db.resolveSessionLaunchConfig({sessionGroup:'origin',sessionMode:'single'}))); } finally {db.close();}`;
  f.env.ZYLOS_PACKAGE_ROOT=coreRoot;
  assert.equal(JSON.parse(f.run(code).stdout).runtime,'codex');
});
for (const runtime of ['claude','codex']) test(`real ${runtime} help validates model syntax without launching a session`, t => {
  const available=spawnSync('which',[runtime],{encoding:'utf8'});
  if (available.status !== 0) { t.skip(`${runtime} executable unavailable`); return; }
  const f=fixture(t);
  f.env[`${runtime.toUpperCase()}_BIN`]=available.stdout.trim();
  const args={sessionGroup:'origin',runtime,model:'integration-test-model',effort:'high'};
  const result=f.db(`const saved=db.setSessionModelConfig(${JSON.stringify(args)}); let rejected; try { db.setSessionModelConfig(${JSON.stringify({...args,effort:'not-an-effort'})}); } catch(e) { rejected=e.code; } console.log(JSON.stringify({saved,rejected,current:db.getSessionModelConfig(${JSON.stringify({sessionGroup:'origin',runtime})})}));`);
  assert.equal(result.saved.changed,true); assert.equal(result.rejected,'MODEL_CONFIG_INVALID');
  assert.equal(result.current.effort,'high');
});
