import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlobalMemoryHandoverCoordinator } from '../global-memory-handover.js';

const currentTemplate = fs.readFileSync(new URL('../../../../templates/memory/state.md', import.meta.url), 'utf8');
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-handover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  let conversion = null, fences = [], requests = [], scenes = [], legacy = false, mode = { keyPresent: true, mode: 'multi' }, transition = null;
  const controls = [], events = [];
  const db = {
    getModeTransition: () => transition, listDrainFences: () => fences,
    getLastCompletedModeTransition: options => { assert.deepEqual(options, { memoryConversion: true }); return conversion; },
    getGlobalCoverageEnd: () => 12, getMaxConversationId: () => 31,
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
    set conversion(row) { conversion = row; }, set fences(value) { fences = value; }, set requests(value) { requests = value; },
    set scenes(value) { scenes = value; }, set legacy(value) { legacy = value; }, set mode(value) { mode = value; }, set transition(value) { transition = value; },
  };
}

test('whitespace material and daily history do not trigger handover', async t => {
  const payload = '  \n\t';
  const f = fixture(t); f.file('inbox.md', payload); f.file('sessions/old.md', 'history');
  assert.equal(f.owner().pending(), false); await f.owner().advance();
  assert.equal(fs.existsSync(path.join(f.memory, 'mode-switch')), false);
});

test('rule 3 archives full material set, preserves groups and daily records, appends one real memory entry', async t => {
  const f = fixture(t); f.file('state.md', 'live global'); f.file('inbox.md', 'global inbox');
  f.file('inbox.20261118T123456789Z.md', 'segment'); f.file('handoff.md', 'old handoff');
  f.file('sessions/old.md', 'daily'); f.file('identity.md', 'shared');
  f.file('session-groups/origin/state.md', 'origin state'); f.file('session-groups/origin/handoff.md', 'origin handoff');
  f.file('session-groups/origin/inbox.md', 'existing entry\n'); f.file('session-groups/group-a/state.md', 'group-a');
  const owner = f.owner(); assert.equal(owner.pending(), true);
  const plan = await owner.advance();
  assert.equal(plan.rule, 'other'); assert.equal(plan.interval, undefined); assert.equal(owner.pending(), false);
  assert.match(f.inbox(), /^existing entry\n### \d{4}-\d{2}-\d{2}\n- \d{2}:\d{2} commitment: Global memory handover /);
  assert.match(f.inbox(), /Read all archived materials completely/); assert.match(f.inbox(), /memory\/sessions/);
  assert.equal(fs.readFileSync(path.join(f.memory, 'session-groups/origin/state.md'), 'utf8'), 'origin state');
  assert.equal(fs.readFileSync(path.join(f.memory, 'session-groups/origin/handoff.md'), 'utf8'), 'origin handoff');
  assert.equal(fs.readFileSync(path.join(f.memory, 'session-groups/group-a/state.md'), 'utf8'), 'group-a');
  assert.equal(fs.readFileSync(path.join(f.memory, 'sessions/old.md'), 'utf8'), 'daily');
  assert.equal(fs.readFileSync(path.join(f.memory, 'identity.md'), 'utf8'), 'shared');
  const archive = path.join(f.memory, 'mode-switch', plan.id, 'previous/_global');
  assert.deepEqual(fs.readdirSync(archive).sort(), ['.done', 'handoff.md', 'inbox.20261118T123456789Z.md', 'inbox.md', 'state.md']);
  assert.equal(f.controls.length, 1); await owner.advance(); assert.equal(f.controls.length, 1);
  assert.equal(f.events.at(-1).event, 'global_memory_handover');
});

test('installation template changed by one character is handed to Origin', async t => {
  const f = fixture(t); f.file('state.md', currentTemplate + 'x');
  f.file('session-groups/origin/state.md', 'existing');
  const plan = await f.owner().advance(); assert.equal(plan.rule, 'other'); assert.equal(plan.deliver, true);
  assert.match(f.inbox(), /commitment:/); assert.equal(f.controls.length, 1);
});

for (const guard of ['transition', 'missing-key', 'legacy-tmux', 'unknown-legacy', 'manual-restart', 'delete', 'unknown-observation']) {
  test(`guard preserves global material without archive or follow-up: ${guard}`, async t => {
    const f = fixture(t); f.file('state.md', 'global');
    if (guard === 'transition') f.transition = { phase: 'gating' };
    if (guard === 'missing-key') f.mode = { keyPresent: false, mode: null };
    if (guard === 'legacy-tmux') f.legacy = true;
    if (guard === 'unknown-legacy') f.legacy = undefined;
    if (guard === 'manual-restart') f.requests = [{ reason: 'manual_restart' }];
    if (guard === 'delete') f.fences = [{ reason: 'delete' }];
    if (guard === 'unknown-observation') f.scenes = [{ observationError: new Error('read failed') }];
    if (guard === 'unknown-origin-scope') f.scenes = [{ present: true, sessionGroup: 'origin', runId: 'unknown' }];
    await f.owner().advance(); assert.equal(fs.readFileSync(path.join(f.memory, 'state.md'), 'utf8'), 'global');
    assert.equal(fs.existsSync(path.join(f.memory, 'mode-switch')), false); assert.equal(f.controls.length, 0);
  });
}

test('incomplete directory without plan is reused, or removed when global material is empty', async t => {
  const f = fixture(t); const id = 'gm-20261118T000000.000Z';
  fs.mkdirSync(path.join(f.memory, 'mode-switch', id), { recursive: true });
  assert.equal(f.owner().pending(), true); await f.owner().advance(); assert.equal(f.owner().pending(), false);
  fs.mkdirSync(path.join(f.memory, 'mode-switch', id)); f.file('state.md', 'work');
  const plan = await f.owner().advance(); assert.equal(plan.id, id); assert.equal(f.directories().length, 1);
});

test('rule 2 decision persists after state moved and exclusive template install races Origin creation', async t => {
  const f = fixture(t); f.file('state.md', currentTemplate);
  let fail = true; const io = Object.create(fs);
  io.linkSync = (source, destination) => {
    if (fail) { fail = false; f.file('session-groups/origin/state.md', 'concurrently written'); throw Object.assign(new Error('crash'), { code: 'EIO' }); }
    return fs.linkSync(source, destination);
  };
  f.deps.fsImpl = io; assert.equal((await f.owner().advance()).failed, true);
  const plan = await f.owner().advance(); assert.equal(plan.rule, 'template'); assert.equal(f.controls.length, 0);
  assert.equal(fs.readFileSync(path.join(f.memory, 'session-groups/origin/state.md'), 'utf8'), 'concurrently written');
});

test('advance participates in provided lifecycle serial and ordinary Origin does not block handover', async t => {
  const f = fixture(t); f.file('state.md', 'global');
  f.scenes = [{ present: true, sessionGroup: 'origin', sourceScope: 'origin', runId: 'current' }];
  let acquired = false; f.deps.serialize = async action => { assert.equal(acquired, false); acquired = true; try { return await action(); } finally { acquired = false; } };
  f.deps.readMode = () => { assert.equal(acquired, true); return { keyPresent: true, mode: 'multi' }; };
  assert.equal((await f.owner().advance()).rule, 'other'); assert.equal(acquired, false);
});

test('old published onboarding template hashes recognize whitespace variations', async t => {
  const f = fixture(t);
  f.file('state.md', '# Active State\n\nLast updated: (not yet)\n\n## Current Focus\nFresh installation. Onboarding pending.\n\n## Onboarding\n- Status: pending\n\n## Pending Tasks\n- [ ] Complete onboarding — deliver security notice and guide owner through first project (see CLAUDE.md > Onboarding)\n\n## Recent Completions\nNone yet.\n  \t');
  assert.equal((await f.owner().advance()).rule, 'template');
});

test('read failure before plan records failure without changing global files', async t => {
  const f = fixture(t); f.file('state.md', 'global');
  f.deps.readMode = () => { throw Object.assign(new Error('unreadable'), { code: 'SQLITE_BUSY' }); };
  assert.equal((await f.owner().advance()).code, 'SQLITE_BUSY');
  assert.equal(f.events.at(-1).event, 'global_memory_handover_failed');
  assert.equal(fs.existsSync(path.join(f.memory, 'mode-switch')), false);
  assert.equal(fs.readFileSync(path.join(f.memory, 'state.md'), 'utf8'), 'global');
});

test('orphan pre-rename plan temporary cannot keep empty gm directory pending forever', async t => {
  const f = fixture(t), id = 'gm-20261118T000000.000Z';
  f.file(`mode-switch/${id}/plan.json.0123456789abcdef.tmp`, '{"uncommitted":true}');
  assert.equal(f.owner().pending(), true); await f.owner().advance();
  assert.equal(f.owner().pending(), false); assert.deepEqual(f.directories(), []);
});

test('unplanned directory with unknown contents fails closed rather than removing evidence', async t => {
  const f = fixture(t), id = 'gm-20261118T000000.000Z';
  const file = f.file(`mode-switch/${id}/unexpected.md`, 'retain');
  assert.equal((await f.owner().advance()).failed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'retain'); assert.equal(f.owner().pending(), true);
});

test('empty global path returns before every authority read or runtime observation', async t => {
  const f = fixture(t);
  const unexpected = () => { throw new Error('empty path must not read authorities or observe runtimes'); };
  for (const key of Object.keys(f.db)) f.db[key] = unexpected;
  for (const key of ['readMode', 'readConfiguration', 'readRequests', 'legacyPresent', 'observe']) f.deps[key] = unexpected;
  assert.equal(await f.owner().advance(), undefined); assert.deepEqual(f.events, []);
});
