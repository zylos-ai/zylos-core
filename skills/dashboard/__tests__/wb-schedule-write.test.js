import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
// Imported under its own URL so the HTTP case below loads the server's copy with
// the child-process spy in place.
const { createSchedulerCli, createScheduleWrite } = await import('../src/lib/workbench/schedule-write.js?direct');
import { createScheduleRead } from '../src/lib/workbench/schedule-read.js';
import { createScheduleTz } from '../src/lib/workbench/schedule-tz.js';

import { scheduleEnv } from './fixtures/schedule-env.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});
const { initialForm, formPayload } = await import('../public/js/wb/schedule-form.js');

const TZ_URL = new URL('../../scheduler/scripts/tz.js', import.meta.url).href;

let importCase = 0;

function useZylosDir(context, dir) {
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  context.after(() => {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
  });
}

/** The Dashboard side of one isolated installation: real CLI child, real read model. */
function dashboard(context, options = {}) {
  const f = scheduleEnv(context, options);
  useZylosDir(context, f.zylosDir);
  const scheduleTz = createScheduleTz({ zylosDir: f.zylosDir, tzModule: `${TZ_URL}?case=${++importCase}` });
  const env = { ...f.env, ...options.processEnv };
  const writer = createScheduleWrite({ zylosDir: f.zylosDir, scheduleTz,
    schedulerCli: createSchedulerCli({ zylosDir: f.zylosDir, env }) });
  const snapshotRows = options.snapshotRows ?? [];
  const reader = createScheduleRead({ zylosDir: f.zylosDir, scheduleTz, getSnapshot: async () => ({ rows: snapshotRows }) });
  const write = (method, route, body) => writer.write(method, route, async () => body);
  const task = async id => (await reader.read()).items.find(item => item.id === id);
  return { ...f, writer, reader, write, task };
}

// Integration: the real scheduler CLI (JSON envelope) as a child process on a
// temporary scheduler.db. Run for schedule write, argv/env or CLI contract
// changes; skip rendering-only edits. Isolation from fixtures/schedule-env.js:
// temporary HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR and tmux directory, paths
// printed and asserted; each child has a 15 s timeout and the root is removed.

test('a Dashboard process inside a session group still creates an unrouted task', async context => {
  const d = dashboard(context, { processEnv: { ZYLOS_SESSION_GROUP: 'telegram:x' } });
  const created = await d.write('POST', '/api/schedules', { prompt: 'From dashboard', schedule: { kind: 'every', value: '1h' } });
  assert.equal(created.body.ok, true);
  const row = d.open().prepare('SELECT session_component, session_group_name FROM tasks WHERE id=?').get(created.body.data.task.id);
  assert.deepEqual({ ...row }, { session_component: null, session_group_name: null });
});

// Permission integration: real AuthGate with in-memory API sessions only. Run for
// schedule write routes or admin classification; skip UI-only changes. No
// network, DB or children; the gate's cleanup timer is removed in teardown.

// Integration: actual createServer, API gate, method routing and the real
// scheduler CLI child on a temporary scheduler.db. Run for schedule route
// wiring, auth or HTTP mapping changes; skip rendering-only edits. Isolation as
// above plus a temporary Dashboard SQLite and a loopback server; only the
// scheduler CLI may start a child (asserted). Teardown closes server, store,
// auth timer and the fixture root.

// Integration: real reader summary -> unchanged legacy form functions -> real
// scheduler CLI write. Run for summary field or edit/write contract changes;
// skip unrelated rendering edits. scheduleEnv prints/asserts isolated HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR, private tmux directory and DB paths. The CLI
// child is timeout-bounded; teardown closes handles and removes the fixture.
test('an older editor changing priority cannot write a summary back over the full task content', async context => {
  const d = dashboard(context);
  const prompt = 'Full task content. '.repeat(40) + 'Retain this final instruction.';
  const created = await d.write('POST', '/api/schedules', { name: 'Long task', prompt,
    schedule: { kind: 'every', value: '2h' }, priority: '3' });
  assert.equal(created.body.ok, true);
  const id = created.body.data.task.id;
  const listed = (await d.reader.read()).items.find(task => task.id === id);
  assert.equal(Object.hasOwn(listed, 'prompt'), false);
  assert.equal(Array.from(listed.promptSummary).length, 200);
  assert.equal(listed.promptTruncated, true);
  // These form functions are unchanged from the pre-summary client version.
  const original = initialForm(listed, { tz: 'Asia/Singapore' });
  assert.equal(original.prompt, '');
  const payload = formPayload({ ...original, priority: '1' }, original);
  assert.equal(payload.prompt, '');
  const result = await d.write('PUT', `/api/schedules/${id}`, payload);
  assert.equal(result.body.ok, true);
  const saved = d.open().prepare('SELECT priority, prompt FROM tasks WHERE id = ?').get(id);
  assert.equal(saved.priority, 1);
  assert.equal(saved.prompt, prompt);
});
