import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture } from './helpers/router-fixture.js';
import { createLegacyMigration } from '../router/resident.js';

test('legacy waits idle, sends exit once, confirms disappearance; busy target forced at 300s by observed runtime', async () => {
  let now = 0; const live = new Map([['claude-main',{ present:true,tmuxName:'claude-main',runtime:'claude',runId:null }],
    ['codex-main',{ present:true,tmuxName:'codex-main',runtime:'codex',runId:'old' }]]);
  const calls = [];
  const migration = createLegacyMigration({ now: () => now, readLegacy: async name => live.get(name) ?? {present:false},
    readLegacyStatus: async name => ({state:name==='claude-main'?'idle':'busy', idle_seconds:4}),
    sendExit: async target => calls.push(['exit',target.tmuxName]), session: {stop: async input => { calls.push(['stop',input]); live.delete(input.tmuxName); }},
    diagnostic: (event, fields) => calls.push([event,fields]) });
  const entries = await migration.findLegacySessions(); await migration.advanceLegacy(entries); await migration.advanceLegacy(entries);
  assert.deepEqual(calls.filter(x => x[0]==='exit'), [['exit','claude-main']]);
  live.delete('claude-main'); await migration.advanceLegacy(entries);
  now = 299999; await migration.advanceLegacy(entries);
  assert.equal(calls.some(x => x[0] === 'stop'), false);
  now = 300000; await migration.advanceLegacy(entries);
  assert.deepEqual(calls.find(x => x[0]==='stop'), ['stop', {tmuxName:'codex-main',expectedRunId:'old'}]);
  assert.deepEqual(calls.filter(x => x[0]==='legacy_tmux_stopped').map(x => x[1].reason), ['exited','forced']);
});

// Upgrade records as the router reads them: the marker that identified the
// upgrade at discovery, and that transaction's journal.

test('failed Origin launches retain the five ten twenty forty sixty second backoff', async t => {
  const f = routerFixture(t);
  f.db.insertControl('Needed work', { sessionGroup: 'origin', appendAckSuffix: false });
  f.deps.session = {
    launch: async input => { f.calls.push(['launch', input]); throw new Error('launch failed'); },
    stop: async input => { f.calls.push(['stop', input]); },
  };
  const router = f.create(); await router.initialize(); await f.rounds(2);
  for (const [index, delay] of [5000, 10000, 20000, 40000, 60000].entries()) {
    f.advance(delay - 1); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, index);
    f.advance(1); await f.rounds(2);
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, index + 1);
    assert.equal(router.state.resident.failures, index + 1);
  }
});
