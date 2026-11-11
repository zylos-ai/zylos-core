import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_PREFIX, parseC4Content } from '../c4-content-schema.js';
import { projectC4Content } from '../c4-content-projection.js';
import { formatConversation } from '../router/format.js';
import { replyVia } from '../c4-query-format.js';
import { ATTACHMENTS_DIR, SKILLS_DIR } from '../c4-config.js';

// Formatters are real; storage and runtime transports are forbidden boundaries.
let databaseOpens = 0, dashboardCalls = 0;
mock.module('better-sqlite3', { defaultExport: class {
  constructor() { databaseOpens++; assert.fail('projection must not open a database'); }
} });
mock.module('../../../dashboard/src/lib/c4-reader.js', { namedExports: { C4Reader: class {
  constructor() { dashboardCalls++; assert.fail('startup must not query Dashboard'); }
} } });
const actualDb = await import('../c4-db.js');
let rows = [], scopeMode = 'multi', closeCalls = 0;
const queryCalls = [];
mock.module('../c4-db.js', { namedExports: {
  ...actualDb,
  formatConversationsForAgent: (values, options) => actualDb.formatConversationsForAgent(values,
    { ...options, ownerName: () => 'Replay Owner' }),
  close: () => { closeCalls++; },
  getCoverageEnd: group => { queryCalls.push(['coverage', group]); return 40; },
  getGlobalCoverageEnd: () => { queryCalls.push(['globalCoverage']); return 40; },
  getDeliveredSince: (group, after, options) => { queryCalls.push(['tail', group, after, options]); return rows; },
  getGlobalDeliveredSince: (after, options) => { queryCalls.push(['globalTail', after, options]); return rows; },
  getUnsummarizedRange: group => { queryCalls.push(['range', group]); return { count: 1, firstConversationId: 95 }; },
  getGlobalUnsummarizedRange: () => { queryCalls.push(['globalRange']); return { count: 1, firstConversationId: 95 }; },
} });
mock.module('../../../activity-monitor/scripts/bootstrap-scope.js', { namedExports: {
  bootstrapScope: async () => ({ mode: scopeMode, scope: scopeMode === 'multi' ? 'work' : '*',
    sessionGroup: scopeMode === 'multi' ? 'work' : null, root: process.env.ZYLOS_DIR,
    memoryDir: path.join(process.env.ZYLOS_DIR, 'memory') }),
  loadCoreModule: async () => assert.fail('startup must not load a runtime or pending-question store'),
} });
const { initC4Session, emitC4Conversations } = await import('../c4-session-init.js');
const { runSessionStartShard } = await import('../../../activity-monitor/scripts/session-start-orchestrator.js');
const { createDelivery } = await import('../router/delivery.js');

const home = fs.realpathSync(process.env.HOME), root = fs.realpathSync(process.env.ZYLOS_DIR);
assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
assert.ok(root.startsWith(home + path.sep));
const canonical = value => {
  let ancestor = path.resolve(value); const suffix = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(fs.realpathSync(ancestor), ...suffix);
};
for (const name of ['PM2_HOME', 'TMPDIR']) assert.ok(canonical(process.env[name]).startsWith(path.dirname(home) + path.sep));
console.log(JSON.stringify({ HOME: home, ZYLOS_DIR: root, PM2_HOME: process.env.PM2_HOME,
  TMPDIR: process.env.TMPDIR, database: 'forbidden constructor', tmux: 'injected transport only', Dashboard: 'throwing reader' }));
fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ alert_target: 'web-console:console' }));
const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const secret = 'HOST_SECRET_SENTINEL';
const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
function sample(name, id = 95) {
  const fixtureName = name === 'answer' ? 'answer_single_select' : 'single';
  const envelope = structuredClone(fixtures.valid.find(item => item.name === fixtureName).envelope);
  if (name === 'answer') {
    envelope.action.id = secret;
    envelope.metadata.zylos.answerId = secret;
  } else envelope.metadata = { private: secret, padding: name === 'long' ? 'x'.repeat(30000) : '' };
  if (name === 'invalid') envelope.version = 2;
  return Object.freeze({ id, direction: name === 'answer' ? 'in' : 'out', timestamp: '2026-11-07 03:00:00',
    channel: 'telegram', endpoint_id: 'chat', session_group: 'telegram:chat', content: encode(envelope) });
}
const heading = row => `[${row.timestamp}] ${row.direction === 'in' ? 'IN' : 'OUT'} (${row.channel}:${row.endpoint_id}):\n`;
const route = row => row.direction === 'in'
  ? ` ---- reply via: node ${fileURLToPath(new URL('../c4-send.js', import.meta.url))} "${row.channel}" "${row.endpoint_id}"` : '';
function checkVisible(text, row) {
  const projected = projectC4Content(row.content, { c4Id: row.id });
  assert.ok(text.includes(projected), 'complete projected summary and references are present');
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(CONTENT_PREFIX), false);
}

for (const name of ['question', 'answer', 'invalid', 'long']) test(`public formatters project complete ${name} content in both spill modes`, () => {
  const row = sample(name), before = JSON.stringify(row), projected = projectC4Content(row.content, { c4Id: row.id });
  assert.equal(actualDb.formatConversations([row]), heading(row) + projected + '\n');
  for (const spill of [true, false]) {
    const text = actualDb.formatConversationsForAgent([row], { spill });
    assert.equal(text, heading(row) + projected + route(row) + '\n');
    checkVisible(text, row);
    assert.equal(text.includes('TRUNCATED'), false, 'raw size must not cause a spill');
  }
  assert.equal(JSON.stringify(row), before);
});

test('ordinary formatter and live output retain the original bytes and routing', () => {
  for (const content of ['ordinary\r\ntext\t😀', '{"version":2,"private":"ordinary JSON"}']) {
    for (const direction of ['in', 'out']) {
      const row = { ...sample('question'), direction, content };
      assert.equal(actualDb.formatConversations([row]), heading(row) + content + '\n');
      assert.equal(actualDb.formatConversationsForAgent([row]), heading(row) + content + route(row) + '\n');
      assert.equal(formatConversation(row), content + ' ' + replyVia(row, path.join(SKILLS_DIR, 'comm-bridge/scripts/c4-send.js')));
    }
  }
});

test('tagged content is validated before stripping legacy reply suffixes', () => {
  const original = sample('question');
  const row = { ...original, content: original.content + ' ---- reply via: node /old/c4-send.js "telegram" "chat"' };
  const text = formatConversation(row);
  assert.ok(text.startsWith('[C4 content invalid; c4_id=95]'));
  assert.equal(text.includes(secret), false);
});

test('hidden legacy route text cannot suppress the actual inbound reply route', () => {
  const row = sample('answer'), envelope = JSON.parse(row.content.slice(CONTENT_PREFIX.length));
  envelope.action.payload = { freeText: '---- reply via: node /hidden/c4-send.js' };
  const text = actualDb.formatConversationsForAgent([{ ...row, content: encode(envelope) }]);
  assert.ok(text.includes(envelope.fallbackText));
  assert.ok(text.endsWith(route(row) + '\n'));
  assert.equal(text.includes('/hidden/'), false);
});

// New output-boundary interface case: run on formatter/projection/spill changes;
// skip unrelated UI. Only private runner filesystem and injected transport used.
test('real spill files and previews contain only projected text in live and agent paths', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.fallbackText = 'Visible summary ' + '中'.repeat(1000);
  envelope.metadata = { private: secret };
  for (const [id, format] of [[801, row => formatConversation(row)], [802, row => actualDb.formatConversationsForAgent([row])]]) {
    const row = { ...sample('question', id), content: encode(envelope) };
    const output = format(row);
    const file = path.join(ATTACHMENTS_DIR, `conv-${id}`, 'message.txt');
    assert.ok(output.includes(file));
    assert.equal(output.includes(secret), false);
    const full = fs.readFileSync(file, 'utf8');
    checkVisible(full, row);
    assert.ok(full.startsWith(projectC4Content(row.content, { c4Id: id })));
  }
});

// New delivery interface cases: run on live formatter/transport handoff changes;
// skip unrelated UI. No real tmux/socket/process/database is created.
for (const runtime of ['claude', 'codex']) for (const name of ['question', 'answer', 'invalid', 'long'])
test(`${runtime} real delivery entry passes projected ${name} text to its adapter`, async t => {
  const row = sample(name), before = JSON.stringify(row), sent = [];
  const target = { ready: true, runtime, runId: 'fixture-run', sessionId: '$1', paneId: '%1' };
  let closed = 0, delivered = 0;
  const connection = { close: async () => { closed++; }, command: async () => '0' };
  const delivery = createDelivery({
    getSessionMode: () => 'multi', openTmuxConnection: async () => connection,
    resolveSessionTarget: async () => target, revalidateSessionTarget: async () => {},
    readSessionState: async () => ({ identity: target, status: { valid: true, value: { state: 'idle', health: 'ok' } } }),
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => ({ runId: target.runId, sessionId: 'fixture-session' }),
    getSessionAdapter: () => ({ sendText: async ({ text }) => { sent.push(text); }, sendKeys: async () => {}, captureScreen: async () => '❯ ' }),
    formatConversation, notifyDelivered: () => {}, sleep: async () => {},
    db: { markDelivered: () => { delivered++; return true; }, requeueConversation: () => assert.fail('delivery blocked'),
      failDelivery: () => assert.fail('delivery failed') },
  }, { periodicEnabled: false, captureEnabled: false });
  t.after(() => delivery.stop());
  const result = await delivery.deliverConversation(row);
  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  checkVisible(sent[0], row);
  assert.equal(closed, 1); assert.equal(delivered, 1);
  assert.equal(JSON.stringify(row), before);
});

// New startup interface cases: real c4-session-init and real core shard resolver;
// run on history formatting or startup budgets. No pending/Dashboard queries.
for (const runtime of ['claude', 'codex']) for (const entry of ['legacy', 'shard'])
for (const name of ['question', 'answer', 'invalid', 'long'])
test(`${runtime} ${entry} startup retains projected ${name} history`, async t => {
  rows = [sample(name)]; scopeMode = 'multi'; queryCalls.length = 0;
  const before = JSON.stringify(rows), initialClose = closeCalls;
  let output;
  if (entry === 'legacy') output = await initC4Session();
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projected-shard-'));
    const file = path.join(dir, 'stdout.txt'), fd = fs.openSync(file, 'w');
    t.after(() => fs.closeSync(fd));
    await runSessionStartShard('c4-conversations', { session_id: `projection-${runtime}`, runtime }, {
      stdout: { fd }, zylosDir: root, tmpdir: dir,
      waitForFlagImpl: async () => ({ ok: true, waitedMs: 0 }),
      writeFlagImpl: () => {}, registerExitFlagImpl: () => {},
    });
    output = fs.readFileSync(file, 'utf8');
    assert.match(output, /ZYLOS STARTUP CONTEXT \[4\/4\] c4-conversations/);
  }
  checkVisible(output, rows[0]);
  assert.equal(output.includes('UNAVAILABLE'), false);
  assert.equal(output.includes('TRUNCATED'), false);
  assert.deepEqual(queryCalls, [['coverage', 'work'], ['tail', 'work', 40, { limit: 6 }], ['range', 'work']]);
  assert.equal(closeCalls, initialClose + 1);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(dashboardCalls, 0); assert.equal(databaseOpens, 0);
});

// Startup budget boundary: run on packing/formatter changes; skip unrelated UI.
// Query fixtures and private runner files only; no DB, socket or runtime.
test('startup budgets count projected messages and preserve ordinary whole-message policy', async () => {
  rows = [sample('long')]; scopeMode = 'multi';
  const full = await emitC4Conversations({});
  const budget = { maxChars: full.length + 200, maxTokens: 100000 };
  checkVisible(await emitC4Conversations({}, budget), rows[0]);
  const ordinary = { ...sample('question', 96), content: 'OLD-PLAIN-' + 'x'.repeat(500) };
  rows = [sample('answer', 97)];
  budget.maxChars = Math.max(full.length, (await emitC4Conversations({})).length) + 200;
  rows = [ordinary, rows[0]];
  const output = await emitC4Conversations({}, budget);
  assert.equal(output.includes(ordinary.content), false);
  checkVisible(output, rows[1]);
  scopeMode = 'single'; rows = [sample('answer')];
  // Global scope migration is an existing separate startup concern.
  const single = await emitC4Conversations({ agent_id: 'fixture-child' });
  checkVisible(single, rows[0]);
});

test('Dashboard replay decorates only agent-facing inbound content in either spill mode', t => {
  for (const spill of [false, true]) {
    const row = Object.freeze({ ...sample('answer', 980), channel: 'dashboard', endpoint_id: 'dialog' });
    const projected = projectC4Content(row.content, { c4Id: row.id });
    const options = { spill, ownerName: () => 'Replay Owner' };
    assert.equal(actualDb.formatConversationsForAgent([row], options),
      heading(row) + '[Dashboard]\n<current-message>\nReplay Owner said: ' + projected + '\n</current-message>' + route(row) + '\n');
    assert.equal(actualDb.formatConversations([row]), heading(row) + projected + '\n');
    for (const other of [{ ...row, direction: 'out' }, { ...row, channel: 'telegram' }]) {
      assert.equal(actualDb.formatConversationsForAgent([other], options),
        heading(other) + projected + route(other) + '\n');
    }
  }
  const row = { ...sample('answer', 981), channel: 'dashboard', content: 'Complete body ' + 'x'.repeat(1200) };
  const directory = path.join(ATTACHMENTS_DIR, `conv-${row.id}`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = actualDb.formatConversationsForAgent([row], { ownerName: () => 'Replay Owner' });
  const file = path.join(directory, 'message.txt');
  assert.ok(output.includes(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '[Dashboard]\n<current-message>\nReplay Owner said: ' + row.content + '\n</current-message>' + route(row));
  assert.equal(actualDb.formatConversationsForAgent([row], { spill: false, ownerName: () => 'Replay Owner' }),
    heading(row) + '[Dashboard]\n<current-message>\nReplay Owner said: ' + row.content + '\n</current-message>' + route(row) + '\n');
});

// Real startup whole-message packing with a fixed owner provider. Run when
// replay/source formatting or budget handling changes; no storage/runtime opens.
test('startup replay counts the Dashboard source label inside its whole-message budget', async () => {
  scopeMode = 'multi';
  const newest = { ...sample('answer', 983), channel: 'dashboard', content: 'NEW-DASHBOARD-BODY' };
  const older = { ...newest, id: 982, content: 'OLDER-DASHBOARD-BODY' + 'x'.repeat(100) };
  rows = [newest];
  const newestOnly = await emitC4Conversations({});
  rows = [older, newest];
  const full = await emitC4Conversations({});
  const budget = { maxChars: full.length + 200, maxTokens: 100000 };
  assert.equal(await emitC4Conversations({}, budget), full);
  budget.maxChars--;
  const packed = await emitC4Conversations({}, budget);
  assert.equal(packed, newestOnly);
  assert.equal(packed.includes(older.content), false);
  assert.ok(packed.includes('[Dashboard]\n<current-message>\nReplay Owner said: ' + newest.content + '\n</current-message>'));
  assert.equal(packed.includes('TRUNCATED'), false);
  assert.equal(packed.split('[Dashboard]').length - 1, 1);
  assert.equal(databaseOpens, 0); assert.equal(dashboardCalls, 0);
});

// Real Core formatters, startup packer and spill files; run for View/projection
// changes, skip unrelated UI. Storage opens are forbidden above; transports are
// injected, files stay under the mandatory runner's private ZYLOS_DIR.
test('View metadata stays absent from Core default reading long packets startup and spill', async () => {
  const shared = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));
  const view = structuredClone(shared.views.find(item => item.name === 'balanced_columns').view);
  const unknown = { ...structuredClone(view), schemaVersion: 99 };
  const overdeep = structuredClone(view); overdeep.nodes[1].extra = { b: { c: 'VIEW_ONLY_SECRET' } };
  for (const [name, layout, valid] of [['valid', view, true], ['unknown', unknown, false], ['overdeep', overdeep, false]]) {
    const envelope = structuredClone(shared.message);
    envelope.blocks[0].data.text = 'CONTENT_ONLY_SECRET' + 'x'.repeat(30000);
    const noView = encode(envelope), withView = encode({ ...envelope, metadata: { view: layout } });
    const parsed = parseC4Content(withView);
    assert.equal(parsed.kind, 'envelope', name);
    assert.equal(parsed.view !== null, valid, name);
    const row = { ...sample('question', 950), content: noView };
    const plain = actualDb.formatConversations([row]);
    assert.equal(actualDb.formatConversations([{ ...row, content: withView }]), plain, name);
    assert.equal(actualDb.formatConversationsForAgent([{ ...row, content: withView }]),
      actualDb.formatConversationsForAgent([row]), name);
    assert.equal(plain.includes('CONTENT_ONLY_SECRET'), false);
    assert.equal(plain.includes('VIEW_ONLY_SECRET'), false);
    if (parsed.viewError) assert.equal(plain.includes(parsed.viewError), false);
    assert.equal(plain.includes('TRUNCATED'), false, 'raw packet length does not consume the output budget');

    scopeMode = 'multi'; rows = [row];
    const startup = await emitC4Conversations({});
    const budget = { maxChars: startup.length + 200, maxTokens: 100000 };
    rows = [{ ...row, content: withView }];
    assert.equal(await emitC4Conversations({}, budget), startup, name);

    envelope.fallbackText = 'Visible long summary ' + '中'.repeat(1000);
    const plainLong = { ...row, content: encode(envelope) };
    const viewLong = { ...row, content: encode({ ...envelope, metadata: { view: layout } }) };
    for (const format of [value => formatConversation(value), value => actualDb.formatConversationsForAgent([value])]) {
      const expectedPreview = format(plainLong);
      const file = path.join(ATTACHMENTS_DIR, 'conv-950', 'message.txt');
      const expectedFull = fs.readFileSync(file, 'utf8');
      assert.equal(format(viewLong), expectedPreview, name);
      const full = fs.readFileSync(file, 'utf8');
      assert.equal(full, expectedFull, name);
      assert.equal(full.includes('VIEW_ONLY_SECRET'), false);
      assert.equal(full.includes('CONTENT_ONLY_SECRET'), false);
      assert.equal(full.includes('"nodes"'), false);
      if (parsed.viewError) assert.equal(full.includes(parsed.viewError), false);
    }
  }
  assert.equal(databaseOpens, 0);
  assert.equal(dashboardCalls, 0);
});
