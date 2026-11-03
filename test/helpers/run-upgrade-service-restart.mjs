import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {step11_startCoreServices} from '../../cli/lib/self-upgrade.js';

const input = JSON.parse(process.argv[2]);
const root = fs.realpathSync(input.root);
const zylosDir = path.join(root, 'h/zylos');
for (const [key, expected] of Object.entries({HOME:path.join(root, 'h'), ZYLOS_DIR:zylosDir,
  PM2_HOME:path.join(root, 'pm2'), TMPDIR:path.join(root, 't')})) assert.equal(process.env[key], expected);
const skillsDir = path.join(zylosDir, '.claude/skills');
const require = createRequire(import.meta.url);
const m = require('../../cli/lib/upgrade-maintenance.cjs');
const pm2 = (...args) => execFileSync(input.pm2, args, {encoding:'utf8', timeout:30000});
const records = () => {
  const text = pm2('jlist');
  const list = JSON.parse(text.slice(text.search(/(?:^|\n)\s*\[(?:\s*\{|\s*\])/)).trim());
  for (const record of list) {
    assert.ok(record.pm2_env.pm_exec_path.startsWith(skillsDir + path.sep));
    assert.equal(record.pm2_env.HOME, process.env.HOME);
    assert.equal(record.pm2_env.PM2_HOME, process.env.PM2_HOME);
  }
  return list;
};
const script = path.join(skillsDir, 'custom/service.cjs');
fs.mkdirSync(path.dirname(script), {recursive:true});
fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
const ecosystem = path.join(zylosDir, 'pm2/ecosystem.config.cjs');
fs.mkdirSync(path.dirname(ecosystem), {recursive:true});
fs.writeFileSync(ecosystem, 'module.exports={apps:[]};\n', {mode:0o600});
const saved = {name:'fixture-custom-service', script};
const context = originalServices => ({servicesWereRunning:[saved.name],
  journal:{originalServices, skillsDir}});
const stepDeps = {zylosDir, ecosystemPath:ecosystem, skillsDir};
{
  pm2('start', script, '--name', saved.name, '--cwd', root);
  assert.equal(records().find(p => p.name === saved.name)?.pm2_env.status, 'online');
  const j = {zylosDir, skillsDir, phase:'restored_verifying', originalServices:[saved],
    initialIdentity:{ecosystemHash:m.hash(ecosystem)}};
  for (const mode of ['step11', 'maintenance']) {
    pm2('stop', saved.name);
    assert.equal(records().find(p => p.name === saved.name)?.pm2_env.status, 'stopped');
    const changed = {...saved, script:path.join(skillsDir, 'custom/changed.cjs')};
    if (mode === 'maintenance') assert.throws(() => m.start({...j, originalServices:[changed]}), /original PM2 service record missing or changed/);
    else {
      const rejected = step11_startCoreServices(context([changed]), stepDeps);
      assert.equal(rejected.status, 'failed');
      assert.match(rejected.error, /original PM2 service record missing or changed/);
    }
    assert.equal(records().find(p => p.name === saved.name)?.pm2_env.status, 'stopped');
    if (mode === 'maintenance') m.start(j);
    else {
      const result = step11_startCoreServices(context([saved]), stepDeps);
      assert.equal(result.status, 'done', JSON.stringify(result));
    }
    m.verifyServices(j);
    const online = records().find(p => p.name === saved.name);
    assert.equal(online.pm2_env.status, 'online');
    assert.equal(online.pm2_env.pm_exec_path, saved.script);
    assert.ok(online.pid > 0);
  }
  process.stdout.write(JSON.stringify({success:true, modes:['step11','maintenance'], identityRejects:['step11','maintenance'], name:saved.name, script}) + '\n');
}
