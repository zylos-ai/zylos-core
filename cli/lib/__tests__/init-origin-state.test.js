import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const init = new URL('../../commands/init.js', import.meta.url).href;
const prompt = new URL('../../../skills/activity-monitor/scripts/session-start-prompt.js', import.meta.url).href;
const root = process.env.ZYLOS_DIR;
function child(source, group) {
  const env = {...process.env};
  delete env.ZYLOS_SESSION_GROUP;
  if (group) env.ZYLOS_SESSION_GROUP = group;
  const result = spawnSync(process.execPath, ['--input-type=module','-e',source], {env,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr || result.stdout);
  return result.stdout.trim().split('\n').at(-1);
}

// Calls real deployment and hook readers in the official runner's private HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR. No services or runtime launch. Run when
// onboarding paths/template deployment change; unrelated code can skip.
test('fresh init seeds Origin once and rerun never recreates global working state', () => {
  const origin = path.join(root,'memory/session-groups/origin/state.md');
  const global = path.join(root,'memory/state.md');
  console.info('template isolation',JSON.stringify({root,HOME:process.env.HOME,PM2_HOME:process.env.PM2_HOME,TMPDIR:process.env.TMPDIR,processes:'none'}));
  child(`import {deployTemplates} from ${JSON.stringify(init)}; deployTemplates({freshInstall:true});`);
  assert.equal(fs.existsSync(global),false);
  assert.match(fs.readFileSync(origin,'utf8'),/scope=origin/);
  assert.match(fs.readFileSync(origin,'utf8'),/Status: pending/);
  fs.writeFileSync(origin,'owner progress\n');
  child(`import {deployTemplates} from ${JSON.stringify(init)}; deployTemplates(); deployTemplates({freshInstall:true});`);
  assert.equal(fs.existsSync(global),false);
  assert.equal(fs.readFileSync(origin,'utf8'),'owner progress\n');
  fs.unlinkSync(origin);
  child(`import {deployTemplates} from ${JSON.stringify(init)}; deployTemplates();`);
  assert.equal(fs.existsSync(origin),false);
  assert.equal(fs.existsSync(global),false);
});

test('group-bound sessions use Origin onboarding while unbound sessions use global state', () => {
  const dir = path.join(root,'memory/session-groups/origin');
  fs.mkdirSync(dir,{recursive:true});
  const config = path.join(root,'.zylos/config.json');
  fs.mkdirSync(path.dirname(config),{recursive:true});
  for (const saved of [{}, {session_mode:'single'}, {session_mode:'multi'}]) {
    fs.writeFileSync(config,JSON.stringify(saved));
    for (const pending of [true,false]) {
      fs.writeFileSync(path.join(dir,'state.md'),`- Status: ${pending ? 'pending' : 'done'}\n`);
      fs.writeFileSync(path.join(root,'memory/state.md'),`- Status: ${pending ? 'done' : 'pending'}\n`);
      const source=`import {isOnboardingPending} from ${JSON.stringify(prompt)}; console.log(isOnboardingPending());`;
      assert.equal(child(source,'origin'),String(pending));
      assert.equal(child(source,null),String(!pending));
      assert.equal(child(source,'telegram:other'),String(pending));
      for (const group of pending ? ['origin','telegram:other'] : [null]) {
        const skipSource = `import assert from 'node:assert/strict';
          import {enqueueStartupPrompt} from ${JSON.stringify(prompt)};
          const result = await enqueueStartupPrompt('startup', {
            scopeReader: () => assert.fail('pending onboarding must skip before scope lookup'),
            execFile: () => assert.fail('pending onboarding must not enqueue a prompt'),
          });
          console.log(JSON.stringify(result));`;
        assert.deepEqual(JSON.parse(child(skipSource,group)), {
          skipped:true, reason:'onboarding_pending', startupControlIds:[],
        });
      }
    }
  }
  for (const runtime of ['claude','codex']) {
    const template = fileURLToPath(new URL(`../../../templates/${runtime}-system.md`,import.meta.url));
    assert.match(fs.readFileSync(template,'utf8'),/If `memory\/session-groups\/origin\/state.md` has onboarding/);
  }
});
