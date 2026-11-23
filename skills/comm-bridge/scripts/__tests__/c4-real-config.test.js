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
test('runtime config re-reads strict F1 on each resolution', t => {
  const f=fixture(t,'{"runtime":"claude"}');
  const result=f.db(`const fs=await import('node:fs'); const before=db.resolveSessionLaunchConfig({sessionGroup:'origin',sessionMode:'single'}); fs.writeFileSync(${JSON.stringify(path.join(f.root,'.zylos/config.json'))},'{"runtime":"codex"}'); const after=db.resolveSessionLaunchConfig({sessionGroup:'origin',sessionMode:'single'}); console.log(JSON.stringify({before,after}));`);
  assert.equal(result.before.runtime,'claude'); assert.equal(result.after.runtime,'codex');
});
