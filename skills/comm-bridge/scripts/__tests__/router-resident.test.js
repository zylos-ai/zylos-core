import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSinglePreparation, createLegacyMigration, runningMaintenance } from '../router/resident.js';

test('single preparation waits at most 300 seconds, then cleanup and instruction generation in order', async () => {
  let now = 0; const calls = [];
  const prepare = createSinglePreparation({ now: () => now, sleep: async ms => { now += ms; }, checkMaintenance: async () => 'upgrade',
    clearStaleState: async runtime => calls.push(['clear',runtime]), resetToolLifecycle: async runtime => calls.push(['reset',runtime]),
    buildInstructionFile: async runtime => calls.push(['instructions',runtime]) });
  await prepare('codex'); assert.equal(now, 300000);
  assert.deepEqual(calls, [['clear','codex'],['reset','codex'],['instructions','codex']]);
});

test('maintenance scan is async argv-only and distinguishes no match from observation failure', async () => {
  const patterns = [];
  assert.equal(await runningMaintenance({ execute: async (_,args) => { patterns.push(args); if (patterns.length < 2) throw Object.assign(Error(),{code:1}); } }), '[u]pgrade-claude');
  assert.deepEqual(patterns, [['-f','[r]estart-claude'],['-f','[u]pgrade-claude']]);
  await assert.rejects(runningMaintenance({ execute: async () => { throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'}); } }), /timeout/);
});

test('legacy waits idle, sends exit once, confirms disappearance; busy target forced at 300s by observed runtime', async () => {
  let now = 0; const live = new Map([['claude-main',{ present:true,tmuxName:'claude-main',runtime:'claude',runId:null }],
    ['codex-main',{ present:true,tmuxName:'codex-main',runtime:'codex',runId:'old' }]]);
  const calls = [];
  const migration = createLegacyMigration({ now: () => now, readLegacy: async name => live.get(name) ?? {present:false},
    readLegacyStatus: async name => ({state:name==='claude-main'?'idle':'busy', idle_seconds:4}),
    sendExit: async target => calls.push(['exit',target.tmuxName]), getSessionAdapter: runtime => ({stop: async input => { calls.push(['stop',runtime,input]); live.delete(input.tmuxName); }}),
    diagnostic: (event, fields) => calls.push([event,fields]) });
  const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries); await migration.advanceLegacy(entries);
  assert.deepEqual(calls.filter(x => x[0]==='exit'), [['exit','claude-main']]);
  live.delete('claude-main'); await migration.advanceLegacy(entries);
  now = 300000; await migration.advanceLegacy(entries);
  assert.deepEqual(calls.find(x => x[0]==='stop'), ['stop','codex',{tmuxName:'codex-main',expectedRunId:'old'}]);
  assert.deepEqual(calls.filter(x => x[0]==='legacy_tmux_stopped').map(x => x[1].reason), ['exited','forced']);
});

test('unknown legacy runtime never guesses adapter; failed stop remains pending', async () => {
  let now = 0, runtime = 'unknown', stopCount = 0;
  const migration = createLegacyMigration({ now:()=>now, readLegacy:async name => ({present:name==='claude-main',runtime,tmuxName:name,runId:null}),
    readLegacyStatus:async()=>({state:'busy'}),sendExit:async()=>assert.fail('busy'),getSessionAdapter:()=>({stop:async()=>{stopCount++;throw Error('unconfirmed');}}) });
  const entries=await migration.findLegacySessions(); now=300001; await migration.advanceLegacy(entries); assert.equal(stopCount,0);
  runtime='claude';await migration.advanceLegacy(entries); assert.equal(stopCount,1);assert.equal(entries[0].stopped,false);
});
