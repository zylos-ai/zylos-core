import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const m = createRequire(import.meta.url)('../../upgrade-maintenance.cjs');

export function serviceFixture(t, {ecosystem = false, names = ['scheduler']} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-services-')));
  const skillsDir = path.join(root, '.claude/skills');
  const script = path.join(skillsDir, 'scheduler/scripts/scheduler.js');
  fs.mkdirSync(path.dirname(script), {recursive:true});
  fs.writeFileSync(script, '// saved service');
  const file = path.join(root, 'pm2/ecosystem.config.cjs');
  const state = path.join(root, 'records.json'), log = path.join(root, 'commands.jsonl');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const writeRecords = records => fs.writeFileSync(state, JSON.stringify(records));
  writeRecords([{name:'scheduler', pid:0, pm2_env:{status:'stopped', pm_exec_path:script}}]);
  if (ecosystem) {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, `module.exports={apps:${JSON.stringify(names.map(name => ({name, script})))} };`, {mode:0o600});
  }
  fs.writeFileSync(path.join(bin, 'pm2'), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2), state=${JSON.stringify(state)}, log=${JSON.stringify(log)};
fs.appendFileSync(log,JSON.stringify(args)+'\\n');
let records=JSON.parse(fs.readFileSync(state,'utf8'));
if(args[0]==='jlist') {if(fs.existsSync(${JSON.stringify(path.join(root,'fail-jlist'))}))process.exit(10);console.log(JSON.stringify(records));}
else if(args[0]==='save') {}
else if(['restart','start','startOrRestart'].includes(args[0])) {
  let names;
  if(args[0]==='restart') names=[args[1]];
  else {const config=require(args[1]);names=config.apps.filter(app=>app.name===args[args.indexOf('--only')+1]).map(app=>app.name);}
  const failed=${JSON.stringify(path.join(root, 'fail-restart'))};
  if(fs.existsSync(failed)) {const target=fs.readFileSync(failed,'utf8');if(target==='yes'||names.includes(target))process.exit(8);}
  const stopped=${JSON.stringify(path.join(root, 'stay-stopped'))};
  if(fs.existsSync(stopped)&&names.includes(fs.readFileSync(stopped,'utf8')))process.exit(0);
  for(const record of records) if(names.includes(record.name)) {record.pid=123;record.pm2_env.status='online';}
  fs.writeFileSync(state,JSON.stringify(records));
} else process.exit(9);
`, {mode:0o700});
  const prior = process.env.PATH;
  process.env.PATH = bin + path.delimiter + prior;
  t.after(() => {process.env.PATH = prior; fs.rmSync(root, {recursive:true, force:true});});
  const j = {zylosDir:root, skillsDir, phase:'restored_verifying', originalServices:[{name:'scheduler',script}],
    initialIdentity:{ecosystemHash:ecosystem ? m.hash(file) : null}};
  return {root, file, j, records:writeRecords,
    readRecords:() => JSON.parse(fs.readFileSync(state, 'utf8')),
    commands:() => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []};
}
