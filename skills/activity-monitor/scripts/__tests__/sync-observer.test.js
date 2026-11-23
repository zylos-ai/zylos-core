import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncObserver } from '../sync-observer.js';
import { appendEvent } from '../../../../cli/lib/event-log.js';
import { supervisorDiagnosticPath } from '../../../../cli/lib/session-group-paths.js';
import { renderStateSkeleton } from '../../../zylos-memory/scripts/state-format.js';

// Module tests use only a private temporary log/state tree and in-memory
// database observations. No runtime, network, tmux or live database is opened.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root }, file = supervisorDiagnosticPath(env);
  let clock = 1800000000000;
  const f = { root, file, env, checkpoints: new Map(), ranges: new Map(), controls: new Map(), scopes: [] };
  f.db = { getLatestContentCheckpoint: scope => f.checkpoints.get(scope),
    getControlById: id => f.controls.get(id),
    getUnsummarizedRange: scope => f.ranges.get(scope) ?? { count: 0, firstAt: null },
    getGlobalUnsummarizedRange: () => f.ranges.get('*') ?? { count: 0, firstAt: null } };
  f.event = row => appendEvent(file, { v: 1, ts: clock, ...row });
  f.trigger = (extra = {}) => f.event({ event: 'sync_triggered', kind: 'group', scope: 'origin', checkpointId: null, ...extra });
  f.create = () => { const observer = new SyncObserver({ env, now: () => clock }); t.after(() => observer.close()); return observer; };
  f.advance = ms => { clock += ms; };
  f.now = () => clock;
  f.inspect = observer => observer.inspect(f.db, { mode: 'multi', activeScopes: ['origin'] });
  return f;
}

test('three requests without a checkpoint alert and a new checkpoint resets the episode across restart', async t => {
  const f = fixture(t); f.trigger(); f.trigger();
  let observer = f.create(); assert.equal((await f.inspect(observer)).length, 0);
  f.trigger(); assert.equal((await f.inspect(observer))[0].type, 'no_checkpoint');
  observer.close(); observer = f.create();
  assert.equal((await f.inspect(observer))[0].attempts, 3);
  f.checkpoints.set('origin', { id: 1, end_conversation_id: 0 });
  const dir = path.join(f.root, 'memory/session-groups/origin'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.md'), renderStateSkeleton({ scope: 'origin', syncedAt: '2026-11-17T00:00:00Z' }).replace('coverage= |', 'coverage=0 |'));
  assert.equal((await f.inspect(observer)).length, 0);
  f.trigger({ checkpointId: 1 });
  assert.equal((await f.inspect(observer)).length, 0);
});

