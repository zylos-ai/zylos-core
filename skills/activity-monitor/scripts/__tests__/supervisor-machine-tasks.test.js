import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorMachineTasks } from '../supervisor-machine-tasks.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueMachineControl } from '../machine-control.js';

test('all machine notices select Origin in multi and NULL single without fallback',async()=>{
  for(const mode of ['single','multi']) {
    let args;const result=await enqueueMachineControl(['enqueue','--content','notice','--priority','3','--no-ack-suffix'],{readMode:()=>({mode}),run:input=>{args=input;return {ok:false,output:'TRANSITION_OPEN'};}});
    assert.equal(result.ok,false);assert.equal(args.includes('--group'),mode==='multi');
    if(mode==='multi')assert.equal(args.at(-1),'origin');
  }
  await assert.rejects(enqueueMachineControl([],{readMode:()=>{throw new Error('unreadable');},run:()=>{throw new Error('must not run');}}),/unreadable/);
});


test('dream uses the configured local calendar, catches up once, and waits through a mode transition', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-schedule-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env'), 'TZ=Asia/Singapore\n');
  const config = { upgrade_check_enabled: false, daily_upgrade_enabled: false, health_check_enabled: false,
    usage_monitor_enabled: false, usage_alert_enabled: false };
  let now;
  const calls = [];
  const tasks = new SupervisorMachineTasks({
    zylosDir: root, readConfig: () => config, now: () => now,
    execute: async (script, timeout, options) => {
      calls.push({ script: path.basename(script), date: options?.args?.[0] });
      if (options?.args?.[0] === '2026-11-12') throw new Error('example process failure');
    },
    resolveTargetRuntime: () => { throw new Error('dream must not probe Origin'); },
  });
  t.after(() => tasks.stop());
  const tick = async (date, transition = null) => {
    now = Date.parse(date);
    await tasks.tick({ configuration: { legacy: true }, transition });
    await Promise.all([...tasks.pending.values()]);
  };

  await tick('2026-11-09T17:59:00Z');
  assert.equal(calls.length, 0);
  await tick('2026-11-09T18:00:00Z');
  await tick('2026-11-10T02:00:00Z');
  assert.deepEqual(calls, [{ script: 'dream.js', date: '2026-11-10' }]);

  config.memory_dream_hour = '4';
  await tick('2026-11-10T18:00:00Z');
  assert.equal(calls.length, 1);
  await tick('2026-11-10T19:00:00Z');
  await tick('2026-11-10T20:00:00Z');
  assert.deepEqual(calls.slice(1), [{ script: 'daily-commit.js', date: undefined }, { script: 'dream.js', date: '2026-11-11' }]);

  await tick('2026-11-11T20:00:00Z', {});
  assert.equal(calls.length, 3);
  await tick('2026-11-11T21:00:00Z');
  await tick('2026-11-11T22:00:00Z');
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).date, '2026-11-12');
  assert.equal(tasks.state('daily-memory-dream-state').last_status, 'failed');
});
