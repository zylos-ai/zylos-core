import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,count,responses,launches,registeredBeforeLaunch} from './fixtures/launch-admission-harness.js';
// All selected cases require private HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR,
// fixture-specific tmux -S socket and C4 database; fixtures stop children and remove resources.
test('transient registered run preserves attempt budget between supervisor scans',{timeout:30000},async t=>{
 const f=await fixture(t);await f.add();const live=await f.launched();registeredBeforeLaunch(f);assert.equal(count(await f.health()),1);
 for(let i=0;i<3;i++)await f.round();await f.killRun();const beforeExitScan=(await f.health()).scheduling;await f.m4.call('scan');assert.deepEqual((await f.health()).scheduling,beforeExitScan);await f.m1.call('fence',{group:'origin'});await f.round();await f.add();await f.time(f.clock+1000);await f.attempt();
 assert.equal(count(await f.health()),1);assert.equal(launches(f).length,1);assert.equal(responses(f).at(-1).response.code,'attempt_backoff');
});
test('absent supervisor socket prevents restricted ordinary launch',{timeout:30000},async t=>{const f=await fixture(t);await f.m4.call('stop');assert.equal(fs.existsSync(path.join(f.root,'activity-monitor/am.sock')),false);await f.add();await f.attempt();assert.equal(launches(f).length,0);assert.equal(f.trace('m1','request').length,1)});
// Covers healthy, demanded Origin and single admission bypass. Run when resident admission changes; skip for unrelated routing changes.
for(const mode of ['healthy','origin','single'])test(`${mode} bypasses start_attempt`,{timeout:30000},async t=>{
 const f=await fixture(t,{mode:mode==='single'?'single':'multi'});
 if(mode==='healthy'){await f.m4.call('seed',{runtime:'codex',health:'ok'});await f.add();await f.m1.call('runtime',{group:'chat',runtime:'codex'});await f.launched()}
 else if(mode==='origin'){await f.m1.call('unfence',{group:'origin'});await f.add('origin');await f.launched('origin')}
 else {await f.add('origin');await f.launched('origin');}
 assert.equal(f.trace('m1','request').length,0);assert.ok(launches(f).length>0);
});
