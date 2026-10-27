import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stringify } from 'smol-toml';
import { installCoreCodexHook, codexHooksPath, codexTrustMarkerPath, ensureHooksFeature } from '../../codex-hooks.js';

const exec = promisify(execFile);
const runtimeDir = fileURLToPath(new URL('../', import.meta.url));
const promptHook = fileURLToPath(new URL('../../../../skills/activity-monitor/scripts/session-start-prompt.js', import.meta.url));
const kick = 'System startup trigger, not a user message. Continue with startup context.';
const tmuxBinary = process.env.TEST_TMUX_BIN || 'tmux';

async function launchFixture(t, runtime, withHook) {
  const {dir,socketPath}=isolatedTmux(t,{prefix:'p02-sp-',tmuxArgs:['-u'],timeout:2000});
  const root = await fs.realpath(dir);
  const log = path.join(root, 'c4.jsonl');
  const report = path.join(root, 'runtime.json');
  const recorder = path.join(root, 'record.mjs');
  const command = path.join(root, 'runtime.mjs');
  const harness = path.join(root, 'launch.mjs');
  const env = {PATH:process.env.PATH, HOME:root, ZYLOS_DIR:root,
    PM2_HOME:path.join(root,'pm2'), CODEX_HOME:path.join(root,'codex'),
    C4_CALL_LOG:log, C4_PRODUCER:'adapter'};
  for (const dir of ['.claude/skills/comm-bridge/scripts','memory','pm2','codex']) {
    await fs.mkdir(path.join(root,dir),{recursive:true});
  }
  await fs.writeFile(log,'');
  await fs.writeFile(path.join(root,'memory/state.md'),'- Status: completed\n');
  // Real C4 CLI execution is replaced at its isolated installation path. The
  // recorder below observes every C4 subprocess API call, not just enqueue.
  for (const name of ['control','receive','send']) {
    await fs.writeFile(path.join(root,`.claude/skills/comm-bridge/scripts/c4-${name}.js`),'process.stdout.write("fixture C4 child\\n");\n');
  }
  await fs.writeFile(recorder,`
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const root=${JSON.stringify(root)},log=${JSON.stringify(log)};
for(const api of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork']) {
  const original=childProcess[api];
  childProcess[api]=function(...args) {
    const words=[String(args[0]),...(Array.isArray(args[1])?args[1].map(String):[])];
    if(words.some(word=>/c4-[a-z-]+\\.[cm]?js/.test(word))) {
      fs.appendFileSync(log,JSON.stringify({api,words,producer:process.env.C4_PRODUCER,pid:process.pid})+'\\n');
      if(!words.some(word=>word.includes(root+'/.claude/skills/comm-bridge/scripts/c4-'))) {
        throw new Error('C4 call escaped isolated installation');
      }
    }
    return Reflect.apply(original,this,args);
  };
}
syncBuiltinESMExports();
`);
  env.NODE_OPTIONS = `--import=${recorder}`;
  await fs.writeFile(path.join(root,'.env'),
    `ZYLOS_TMUX_INHERIT=NODE_OPTIONS,C4_CALL_LOG,C4_PRODUCER,PM2_HOME,CODEX_HOME\n`);
  if (withHook) {
    await fs.writeFile(path.join(root,'.claude/settings.json'),JSON.stringify({hooks:{SessionStart:[{
      hooks:[{type:'command',command:`node ${promptHook}`}],
    }]}}));
  }
  // This startup-prompt fixture is already trusted. Trust repair has its own
  // app-server regression fixture; an unexpected app-server call here must fail.
  if (runtime === 'codex') {
    installCoreCodexHook({ zylosDir: root });
    ensureHooksFeature({ projectDir: root, homeDir: root, codexHome: env.CODEX_HOME });
    const hooksHash = createHash('sha256').update(await fs.readFile(codexHooksPath(root))).digest('hex');
    const trustSnapshot = { [`${codexHooksPath(root)}:session_start:0:0`]: { enabled: true, trusted_hash: hooksHash } };
    await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), stringify({ features: { hooks: true }, hooks: { state: trustSnapshot } }));
    await fs.writeFile(codexTrustMarkerPath(root), JSON.stringify({ hooksHash, codexVersion: 'codex-fixture', trustSnapshot }));
  }
  await fs.writeFile(command,`#!${process.execPath}
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
if(process.argv.includes('--version')) { console.log('codex-fixture'); }
else if(process.argv.includes('app-server')) { process.exit(2); }
else if(process.argv.includes('--help')) { console.log(' --no-daemon --model MODEL --effort EFFORT '); }
else {
  let settings={};try{settings=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root,'.claude/settings.json'))},'utf8'));}catch{}
  const hooks=settings.hooks?.SessionStart?.flatMap(entry=>entry.hooks)||[];
  for(const hook of hooks) {
    if(hook.command===${JSON.stringify(`node ${promptHook}`)}) {
      execFileSync(process.execPath,[${JSON.stringify(promptHook)}],{
        env:{...process.env,C4_PRODUCER:'formal-hook'},input:JSON.stringify({source:'startup'}),timeout:5000});
    }
  }
  fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({argv:process.argv.slice(2),pid:process.pid,hooks:hooks.length}));
  setInterval(()=>{},1000);
}
`,{mode:0o700});
  await fs.writeFile(harness,`
import fs from 'node:fs/promises';
import {${runtime==='claude'?'ClaudeAdapter':'CodexAdapter'} as Adapter} from ${JSON.stringify(new URL(`../${runtime}.js`,import.meta.url).href)};
const adapter=new Adapter({root:${JSON.stringify(root)},env:{...process.env,${runtime.toUpperCase()}_BIN:${JSON.stringify(command)}},tmux:{binary:${JSON.stringify(tmuxBinary)},socketPath:${JSON.stringify(socketPath)},configFile:'/dev/null'}});
const launched=adapter.launch({sessionGroup:null,runId:'startup-producer-test',sessionMode:'single',launchConfig:{runtime:${JSON.stringify(runtime)},mode:'default'}});
// Exact optional legacy guardian ordering: invoke after starting launch, before
// awaiting its Promise. Restoring the old method must produce a recorded call.
try { adapter.enqueueStartupPrompt?.(); } catch {}
await launched;
for(let i=0;i<200;i++){try{await fs.access(${JSON.stringify(report)});break;}catch{}await new Promise(r=>setTimeout(r,10));}
console.log(await fs.readFile(${JSON.stringify(report)},'utf8'));
`);
  const {stdout} = await exec(process.execPath,[harness],{env,timeout:10000});
  const observed = JSON.parse(stdout.trim());
  const calls = (await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  t.diagnostic(JSON.stringify({runtime,withHook,calls}));
  return {observed,calls};
}

// Top-level tests are serial; simultaneous tmux creation is outside this scope.
for (const withHook of [false,true]) {
  test(`Claude launch ${withHook?'with':'without'} SessionStart prompt hook has no adapter C4 fallback`,async t=>{
    const {observed,calls}=await launchFixture(t,'claude',withHook);
    assert.equal(observed.hooks,withHook?1:0);
    assert.deepEqual(calls.filter(call=>call.producer==='adapter'),[],
      'adapter / legacy guardian seam must not enqueue a fallback prompt');
    assert.equal(calls.length,withHook?1:0,'record every C4 child call; only the formal hook may produce one');
    if(withHook) {
      const [call]=calls;
      assert.equal(call.producer,'formal-hook');
      assert.match(call.words.join(' '),/c4-control\.js enqueue/);
      const content=call.words[call.words.indexOf('--content')+1];
      assert.match(content,/reply to your human partner/);
      assert.equal(call.words[call.words.indexOf('--priority')+1],'2');
      assert.ok(call.words.includes('--no-ack-suffix'));
    }
  });
}

test('Codex launch retains its startup kick without producing C4 control',async t=>{
  const {observed,calls}=await launchFixture(t,'codex',false);
  assert.equal(observed.argv.at(-1),kick);
  assert.equal(observed.argv.filter(arg=>arg===kick).length,1);
  assert.deepEqual(calls,[]);
});

test('runtime sources contain no dedicated adapter startup fallback implementation or calls',async()=>{
  const matches=[];
  async function scan(dir) {
    for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
      if(entry.name==='__tests__')continue;
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())await scan(file);
      else if(/\.[cm]?js$/.test(entry.name)) {
        const source=await fs.readFile(file,'utf8');
        if(/enqueueStartupPrompt|_hasStartupHook/.test(source))matches.push(path.relative(runtimeDir,file));
      }
    }
  }
  await scan(runtimeDir);
  assert.deepEqual(matches,[],'dedicated adapter implementation and calls must stay deleted');
});
