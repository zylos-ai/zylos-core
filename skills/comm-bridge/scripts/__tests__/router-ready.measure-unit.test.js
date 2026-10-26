import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { configFromEnv, measurementEnv, resolveBinary, proxyPresence, statistics, timing, assertOrder, runMeasurements, runWorker } from './router-ready.measure.js';
import { waitOwnedRuntime, verifyHomeAbsent } from './router-ready-process.js';
import { preflightInputs, readClaudeCredential, authRuntimeEnv } from './router-ready-auth.js';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-measure-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// P04 Q execution requirements 5/8: invalid/missing input never launches a sample.
test('READY measurement rejects invalid deadlines and missing explicit auth before sampling', async t => {
  assert.throws(() => configFromEnv({ READY_MEASURE_OBSERVATION_MS: '61000' }), { code: 'INVALID_MEASUREMENT_CONFIG' });
  const config = configFromEnv({ READY_MEASURE_EVIDENCE_DIR: directory(t) });
  let calls = 0;
  const result = await runMeasurements(config, {}, async () => { calls++; });
  assert.equal(result.ok, false);
  assert.equal(result.summary.error, 'claude_credentials_missing');
  assert.equal(result.summary.sampleCount, 0);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(path.join(result.runDir, 'samples.jsonl'), 'utf8'), '');
  assert.equal(fs.statSync(path.join(result.runDir, 'summary.json')).mode & 0o777, 0o600);
});

// P04 Q requirements 6/7/10: no implicit host auth or proxy values in evidence.
test('READY measurement only propagates named inputs and six proxy variants', () => {
  const source = { PATH: '/test', HOME: '/host', CODEX_HOME: '/host/auth', OPENAI_API_KEY: 'hidden',
    READY_MEASURE_CODEX_API_KEY: 'explicit', HTTPS_PROXY: 'proxy-secret', https_proxy: 'lower-secret' };
  const env = measurementEnv(source);
  assert.equal(env.HOME, undefined); assert.equal(env.CODEX_HOME, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.READY_MEASURE_CODEX_API_KEY, 'explicit');
  const runtime = authRuntimeEnv(env, '/isolated');
  assert.equal(runtime.READY_MEASURE_CODEX_API_KEY, undefined);
  assert.equal(runtime.HOME, '/isolated');
  assert.equal(runtime.HTTPS_PROXY, 'proxy-secret');
  const evidence = JSON.stringify(proxyPresence(env));
  assert.ok(!evidence.includes('proxy-secret')); assert.ok(!evidence.includes('lower-secret'));
  assert.equal(Object.keys(proxyPresence(env)).length, 6);
});

// P04 Q requirement 8: expired inputs fail even when structurally authenticated.
test('Claude explicit credential validity requires at least two remaining hours', t => {
  const file = path.join(directory(t), 'input.json');
  const write = expiresAt => fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'test-only', expiresAt } }));
  const now = 1000000;
  write(now + 7200000 - 1);
  assert.throws(() => readClaudeCredential(file, now), { code: 'claude_credentials_expiring' });
  write(now + 7200000);
  assert.equal(preflightInputs(['claude'], { READY_MEASURE_CLAUDE_CREDENTIALS: file }, now).explicitCredentials, true);
  assert.throws(() => preflightInputs(['codex'], {}), { code: 'codex_credentials_missing' });
});

// P04 Q startup-control ordering: positive + wrong-order/duplicate negative controls.
test('sequence recorder requires real startup IDs before one business delivery', () => {
  const good = [{kind:'control',id:7},{kind:'control',id:8},{kind:'business',id:9}];
  assert.doesNotThrow(() => assertOrder(good, [7,8], 9));
  assert.throws(() => assertOrder(good, [], 9), { code: 'STARTUP_PROMPT_MISSING_OR_DUPLICATED' });
  assert.throws(() => assertOrder([good[2],...good.slice(0,2)], [7,8], 9), { code: 'BUSINESS_BEFORE_STARTUP' });
  assert.throws(() => assertOrder([...good, good[2]], [7,8], 9), { code: 'DUPLICATE_DELIVERY' });
});

// P04 Q timing: READY before adapter return is valid, never clamped to zero.
test('timing preserves signed publication/observation deltas and nearest-rank p95', () => {
  const value = timing({wall:1000,mono:10}, {wall:1100,mono:110}, {ts:1050}, {wall:1070,mono:80});
  assert.equal(value.publicationFromReturnMs, -50);
  assert.equal(value.observedFromReturnMs, -30);
  assert.equal(value.publicationToObservationMs, 20);
  assert.deepEqual(statistics([9,1,3,2]), {n:4,min:1,median:2.5,p95:9,max:9});
  assert.equal(statistics([]).n, 0);
});

// P04 Q requirement 8: all runtimes must pass before any raw samples exist.
test('failed runtime hook preflight stops the whole run with zero samples', async t => {
  const config = configFromEnv({ READY_MEASURE_RUNTIMES: 'codex', READY_MEASURE_EVIDENCE_DIR: directory(t) });
  const requests = [];
  const result = await runMeasurements(config, { READY_MEASURE_CODEX_API_KEY: 'test-only' }, async request => {
    requests.push(request.type); return { ok:false,error:'codex_hooks_verification_failed',homeRemoved:true };
  });
  assert.deepEqual(requests, ['preflight']); assert.equal(result.summary.sampleCount, 0);
  assert.equal(result.summary.error, 'codex_hooks_verification_failed');
});

// P04 Q requirement 10: an interrupted worker cannot attest cleanup.
test('abnormal worker failure marks cleanup unconfirmed', async t => {
  const config = configFromEnv({ READY_MEASURE_RUNTIMES: 'codex', READY_MEASURE_EVIDENCE_DIR: directory(t) });
  const result = await runMeasurements(config, { READY_MEASURE_CODEX_API_KEY: 'test-only' }, async () => {
    throw Object.assign(new Error('WORKER_FAILED'), {code:'WORKER_FAILED',cleanupUnknown:true});
  });
  assert.equal(result.summary.allTemporaryHomesRemoved, false);
});

// Real worker preflight, no authentication and no runtime launch. Its finally
// must remove the private fixture before reporting across IPC.
test('worker missing-credentials preflight returns failure after HOME removal', async () => {
  const config = configFromEnv({ READY_MEASURE_RUNTIMES: 'claude' });
  const result = await runWorker({type:'preflight',runtime:'claude',config}, measurementEnv({PATH:process.env.PATH}), 15000);
  assert.equal(result.ok,false); assert.equal(result.error,'claude_credentials_missing');
  assert.equal(result.homeRemoved,true); assert.equal(result.launchCount,undefined);
});

// P04 Q measurement-instrument calibration. This is explicitly a CLI stand-in,
// NOT evidence of authenticated Claude/Codex startup performance. It drives
// real native-hook commands, M3, P01, P02 and M1 to exercise the worker itself.
test('measurement worker calibration covers cold/repeat and four injection paths', {timeout:180000}, async t => {
  const dir = directory(t);
  const binary = path.join(dir, 'claude-fixture.mjs');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport {spawn} from 'node:child_process';\nif(process.argv.includes('--version')){console.log('2.0.0');process.exit(0);}\nif(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}\nif(!process.stdin.isTTY || !process.stdout.isTTY)process.exit(88);\nconst config=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'.claude/settings.json'),'utf8'));\nconst payload=JSON.stringify({source:'startup',session_id:'fixture-'+process.pid});\nfor(const group of config.hooks.SessionStart){for(const hook of group.hooks){const child=spawn('/bin/sh',['-c',hook.command],{stdio:['pipe','ignore','ignore']});child.stdin.end(payload);}}\nsetInterval(()=>{},1000);\n`, {mode:0o700});
  assert.equal(resolveBinary('claude-fixture.mjs', {PATH:dir}), fs.realpathSync(binary));
  const credential = path.join(dir, 'credential.json');
  fs.writeFileSync(credential, JSON.stringify({claudeAiOauth:{accessToken:'test-only-not-real',expiresAt:Date.now()+10800000}}), {mode:0o600});
  const config = configFromEnv({ READY_MEASURE_RUNTIMES:'claude', READY_MEASURE_CLAUDE_BIN:'claude-fixture.mjs',
    READY_MEASURE_TIMEOUT_MS:'10000', READY_MEASURE_OBSERVATION_MS:'20000', READY_MEASURE_POLL_MS:'50', READY_MEASURE_SLOW_HOOK_MS:'5000' });
  const env = measurementEnv({PATH:dir+path.delimiter+process.env.PATH, READY_MEASURE_CLAUDE_CREDENTIALS:credential});
  for (const [condition,kind] of [['cold','normal'],['repeat','normal'],['fault','slow-hook'],['fault','missing-session-id'],['fault','late-launch'],['fault','boundary-ready']]) {
    await t.test(`${condition}/${kind}`, async () => {
      const result = await runWorker({type:'sample',runtime:'claude',condition,case:kind,index:0,config},env,50000);
      assert.equal(result.ok,true, JSON.stringify(result));
      assert.equal(result.homeRemoved,true);
      assert.equal(result.duplicateDeliveries,0);
      assert.equal(result.launchCount,1);
    });
  }
});


// Observed DGX regression: a writer outlives target stop and recreates HOME.
// The negative control proves an immediate absence check accepts that race;
// the positive path terminates only the newly owned group, then checks grace.
test('owned runtime cleanup prevents delayed HOME recreation and detects the old race', {timeout:15000}, async t => {
  const dir = directory(t), home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const writerCode = `const fs=require('node:fs');const path=require('node:path');process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{fs.mkdirSync(process.env.HOME,{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'late-write'),'fixture');},40);`;
  const env = { ...measurementEnv({PATH:process.env.PATH}), HOME:home, ZYLOS_RUN_ID:'cleanup-fixture' };
  const stray = spawn(process.execPath, ['-e',writerCode], {env,stdio:['ignore','pipe','ignore']});
  const strayExit = once(stray,'exit');
  t.after(async()=>{if(stray.exitCode===null&&stray.signalCode===null)stray.kill('SIGKILL');await strayExit;});
  await once(stray.stdout,'data');
  fs.rmSync(home,{recursive:true});
  assert.equal(fs.existsSync(home),false,'old immediate check would pass');
  const raced = await verifyHomeAbsent(home,200);
  assert.equal(raced.homeRemoved,false); assert.equal(raced.absentAfterGrace,false);
  stray.kill('SIGKILL'); await strayExit;

  const receipt = path.join(dir,'receipt.json');
  const script = path.join(dir,'supervisor.mjs');
  fs.writeFileSync(script, `import {superviseRuntime} from ${JSON.stringify(new URL('./router-ready-process.js',import.meta.url).href)};await superviseRuntime(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(writerCode)}],${JSON.stringify(receipt)});`);
  const supervisor = spawn(process.execPath,[script],{env,stdio:['ignore','pipe','ignore']});
  const supervisorExit = once(supervisor,'exit');
  t.after(async()=>{if(supervisor.exitCode===null&&supervisor.signalCode===null)supervisor.kill('SIGTERM');await supervisorExit;});
  await once(supervisor.stdout,'data');
  supervisor.kill('SIGHUP');
  const stopped = await waitOwnedRuntime(receipt,'cleanup-fixture');
  assert.equal(stopped.groupGone,true,JSON.stringify(stopped));
  await supervisorExit;
  fs.rmSync(home,{recursive:true});
  const removed = await verifyHomeAbsent(home);
  assert.equal(removed.homeRemoved,true);
});

// Codex 0.164 API-key status does not use the OAuth "Logged in" text.
test('product API-key auth check accepts explicit isolated auth.json despite uncertain status text', t => {
  const dir=directory(t); fs.mkdirSync(path.join(dir,'.codex'));
  fs.writeFileSync(path.join(dir,'.codex/auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'test-only-not-real'}),{mode:0o600});
  const source=`import {isCodexAuthenticated} from ${JSON.stringify(new URL('../../../../cli/lib/runtime-setup.js',import.meta.url).href)};import {classifyCodexLoginStatus} from ${JSON.stringify(new URL('../../../../cli/lib/auth-parsers.js',import.meta.url).href)};console.log(JSON.stringify({authenticated:isCodexAuthenticated(),text:classifyCodexLoginStatus('API key configured - test-only')}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{...measurementEnv({PATH:process.env.PATH}),HOME:dir,ZYLOS_DIR:path.join(dir,'zylos')},encoding:'utf8'});
  assert.equal(result.status,0);
  assert.deepEqual(JSON.parse(result.stdout),{authenticated:true,text:'uncertain'});
});

// Help/version used by adapter preflight must not create an unowned runtime.
test('owned launcher transparently probes help/version without lifecycle receipt', async t => {
  const dir=directory(t), receipt=path.join(dir,'undefined.json');
  const script=path.join(dir,'probe.mjs');
  fs.writeFileSync(script, `import {superviseRuntime} from ${JSON.stringify(new URL('./router-ready-process.js',import.meta.url).href)};await superviseRuntime(${JSON.stringify(process.execPath)},process.argv.slice(2),${JSON.stringify(receipt)});`);
  for(const flag of ['--help','--version']) {
    const result=spawnSync(process.execPath,[script,flag],{env:measurementEnv({PATH:process.env.PATH}),encoding:'utf8'});
    assert.equal(result.status,0); assert.ok(result.stdout.length>0); assert.equal(fs.existsSync(receipt),false);
  }
});

// Report READY success separately from cleanup/sample eligibility; exclusions
// have reason counts, so n=9 does not silently hide a tenth valid READY result.
test('summary records machine metadata and separate cleanup exclusions', async t => {
  const config=configFromEnv({READY_MEASURE_RUNTIMES:'codex',READY_MEASURE_CASES:'normal',READY_MEASURE_COLD_COUNT:'2',READY_MEASURE_REPEAT_COUNT:'0',READY_MEASURE_MACHINE:'fixture-machine',READY_MEASURE_EVIDENCE_DIR:directory(t)});
  const result=await runMeasurements(config,{READY_MEASURE_CODEX_API_KEY:'test-only'},async request=>{
    if(request.type==='preflight')return {ok:true,homeRemoved:true};
    const ok=request.index===0;
    return {ok,homeRemoved:ok,outcome:'success',...(ok?{}:{cleanupError:'CLEANUP_FAILED'}),timing:{publicationFromLaunchMs:100,publicationFromReturnMs:50,observedFromLaunchMs:110,observedFromReturnMs:60}};
  });
  assert.equal(result.summary.machine.label,'fixture-machine'); assert.ok(result.summary.machine.logicalCpus>0);
  assert.deepEqual(result.summary.counts,{collected:2,readyValid:2,cleanupFailed:1,includedInAggregates:1,excludedFromAggregates:1,exclusionReasons:{cleanup_failed:1}});
  assert.deepEqual(result.summary.countsByRuntimeCondition['codex/cold'],result.summary.counts);
  assert.equal(result.summary.aggregates['codex/cold'].publicationFromLaunchMs.n,1);
});
