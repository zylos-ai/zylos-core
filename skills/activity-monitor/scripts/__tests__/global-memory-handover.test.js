import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalMemoryHandoverCoordinator } from '../global-memory-handover.js';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-handover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  let fences = [], requests = [], scenes = [], legacy = false, mode = { keyPresent: true, mode: 'multi' }, transition = null;
  const controls = [], events = [];
  const db = {
    getModeTransition: () => transition, listDrainFences: () => fences,
    insertControl: (body, options) => { assert.deepEqual(options, { sessionGroup: 'origin', priority: 2, appendAckSuffix: false });
      const old = controls.findIndex(control => control.body === body); if (old >= 0) controls.splice(old, 1); controls.push({ body, options }); },
  };
  const deps = { db, zylosDir: root, readMode: () => mode, readConfiguration: () => mode,
    readRequests: () => requests, legacyPresent: () => legacy, observe: () => scenes,
    diagnostic: event => events.push(event), now: () => 1800000000000, ...overrides };
  const file = (name, body) => { const target = path.join(memory, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); return target; };
  return { root, memory, db, deps, events, controls, file,
    owner: () => new GlobalMemoryHandoverCoordinator(deps),
    inbox: () => fs.readFileSync(path.join(memory, 'session-groups/origin/inbox.md'), 'utf8'),
    directories: () => fs.readdirSync(path.join(memory, 'mode-switch')),
    set fences(value) { fences = value; }, set requests(value) { requests = value; },
    set scenes(value) { scenes = value; }, set legacy(value) { legacy = value; }, set mode(value) { mode = value; }, set transition(value) { transition = value; },
  };
}

test('handover archives the full material set and queues archived follow-up without writing working memory', async t => {
  const f = fixture(t); f.file('state.md', 'live global'); f.file('inbox.md', 'global inbox');
  f.file('inbox.20261118T123456789Z.md', 'segment'); f.file('handoff.md', 'old handoff');
  f.file('sessions/old.md', 'daily'); f.file('identity.md', 'shared');
  f.file('session-groups/origin/state.md', 'origin state'); f.file('session-groups/origin/handoff.md', 'origin handoff');
  f.file('session-groups/origin/inbox.md', 'existing entry\n'); f.file('session-groups/group-a/state.md', 'group-a');
  const owner = f.owner(); assert.equal(owner.pending(), true);
  const plan = await owner.advance();
  assert.equal(plan.rule, 'other'); assert.equal(plan.interval, undefined); assert.equal(owner.pending(), false);
  assert.equal(f.inbox(), 'existing entry\n');
  assert.match(f.controls[0].body, /memory\/mode-switch\/.*\/previous\/_global/);
  assert.equal(fs.readFileSync(path.join(f.memory, 'session-groups/origin/state.md'), 'utf8'), 'origin state');
  assert.equal(fs.readFileSync(path.join(f.memory, 'session-groups/origin/handoff.md'), 'utf8'), 'origin handoff');
  assert.equal(fs.readFileSync(path.join(f.memory, 'session-groups/group-a/state.md'), 'utf8'), 'group-a');
  assert.equal(fs.readFileSync(path.join(f.memory, 'sessions/old.md'), 'utf8'), 'daily');
  assert.equal(fs.readFileSync(path.join(f.memory, 'identity.md'), 'utf8'), 'shared');
  const archive = path.join(f.memory, 'mode-switch', plan.id, 'previous/_global');
  assert.deepEqual(fs.readdirSync(archive).sort(), ['.done', 'handoff.md', 'inbox.20261118T123456789Z.md', 'inbox.md']);
  assert.equal(fs.readFileSync(path.join(f.memory, 'state.md'), 'utf8'), 'live global');
  assert.equal(f.controls.length, 1); await owner.advance(); assert.equal(f.controls.length, 1);
  assert.equal(f.events.at(-1).event, 'global_memory_handover');
});

test('unplanned directory with unknown contents fails closed rather than removing evidence', async t => {
  const f = fixture(t), id = 'gm-20261118T000000.000Z';
  const file = f.file(`mode-switch/${id}/unexpected.md`, 'retain');
  assert.equal((await f.owner().advance()).failed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'retain'); assert.equal(f.owner().pending(), true);
});


test('an interrupted handover plan can resume after upgrade has archived its inbox', async t => {
  const f = fixture(t), id = 'gm-20261118T000000.000Z';
  f.file('archive/inbox/origin/inbox.archive-1.md', 'legacy inbox');
  f.file(`mode-switch/${id}/plan.json`, JSON.stringify({ version: 1, id, rule: 'other', deliver: true,
    files: [{ name: 'inbox.md' }, { name: 'state.md' }], dailyRecords: true }));
  f.file(`mode-switch/${id}/previous/_global/state.md`, 'open state');
  const owner = f.owner(), plan = await owner.advance();
  assert.equal(plan.id, id);
  assert.equal(owner.pending(), false);
  assert.match(f.controls[0].body, /memory\/archive\/inbox\/origin/);
  assert.equal(fs.existsSync(path.join(f.memory, 'session-groups/origin/inbox.md')), false);
});
