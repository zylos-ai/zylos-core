import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';

const root = fs.realpathSync(process.env.ZYLOS_CHAT_CONSUMER_ROOT);
const instance = process.env.ZYLOS_DIR;
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  assert.ok(fs.realpathSync(process.env[key]).startsWith(root + path.sep), `${key} must be private`);
}
assert.ok(process.env.ZYLOS_CHAT_TMUX_SOCKET.startsWith(root + path.sep));
assert.ok(Buffer.byteLength(process.env.ZYLOS_CHAT_TMUX_SOCKET) < 100);
const databaseFile = path.join(instance, 'comm-bridge/c4.db');
assert.equal(fs.realpathSync(databaseFile), databaseFile);
const core = fileURLToPath(new URL('../../../../', import.meta.url));
assert.equal(process.env.ZYLOS_PACKAGE_ROOT, core);
const scripts = path.join(core, 'skills/comm-bridge/scripts');
const skills = path.join(instance, '.claude/skills');
fs.mkdirSync(path.join(instance, '.zylos'), { recursive: true });
fs.mkdirSync(skills, { recursive: true });
fs.writeFileSync(path.join(instance, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi', alert_target: 'web-console:console' }));
fs.symlinkSync(path.join(core, 'skills/dashboard'), path.join(skills, 'dashboard'), 'dir');
fs.symlinkSync(path.join(core, 'skills/comm-bridge'), path.join(skills, 'comm-bridge'), 'dir');
process.env.ZYLOS_SESSION_GROUP = 'dashboard:alpha';
const [{ guardDatabase }, owner, { createStore }, { projectC4Content }, { CONTENT_PREFIX }] = await Promise.all([
  import('../../../comm-bridge/scripts/sqlite-schema.js'), import('../../../comm-bridge/scripts/c4-schema.js'),
  import('../../../comm-bridge/scripts/c4-v2-store.js'), import('../../../comm-bridge/scripts/c4-content-projection.js'),
  import('../../../comm-bridge/scripts/c4-content-schema.js'),
]);
const database = new Database(databaseFile);
guardDatabase(database, owner);
const store = createStore(database, { validateComponent: () => true,
  readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateModel: () => true });
let assertions = 0;
const eq = (a, b, why) => { assertions++; assert.equal(a, b, why); };
const ok = (value, why) => { assertions++; assert.ok(value, why); };
const outlets = [];
const secret = 'PRIVATE_CONSUMER_HOST_SENTINEL';
const fixtures = JSON.parse(fs.readFileSync(path.join(core, 'test/fixtures/c4-content-protocol.json'), 'utf8'));
const question = structuredClone(fixtures.valid.find(item => item.name === 'single').envelope);
question.fallbackText = 'Visible question summary'; question.metadata = { private: secret };
const answer = structuredClone(fixtures.valid.find(item => item.name === 'answer_single_select').envelope);
answer.fallbackText = '回答了 interruptId=question（问题：Visible question summary）：选择一';
answer.metadata.zylos.answerId = secret; answer.action.id = secret;
const long = { ...question, messageId: 'long-visible', fallbackText: 'Visible long summary ' + '中'.repeat(1100) };
const nested = { ...question, messageId: 'literal-prefix', fallbackText: CONTENT_PREFIX + 'literal fallback summary' };
const contents = ['ordinary plain text', CONTENT_PREFIX + JSON.stringify(question), CONTENT_PREFIX + JSON.stringify(answer),
  CONTENT_PREFIX + '{"private":"' + secret + '"', CONTENT_PREFIX + JSON.stringify(long), CONTENT_PREFIX + JSON.stringify(nested)];
let rows;
const invoke = (script, args, extraEnv = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...extraEnv },
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  eq(result.status, 0, result.stderr); return result.stdout;
};
const safe = (text, label) => { eq(text.includes(secret), false, `${label} may not expose host metadata`); };
const checkRows = (actual, expected, label) => {
  eq(actual.length, expected.length, label);
  for (let i = 0; i < expected.length; i++) {
    eq(actual[i].id, expected[i].id); eq(actual[i].content, projectC4Content(expected[i].content, { c4Id: expected[i].id }));
    safe(actual[i].content, label);
  }
};
try {
  rows = contents.map((content, i) => {
    const row = store.insertConversation(i === 2 || i === 0 ? 'in' : 'out', 'dashboard', 'alpha', content, { groupName: 'alpha' });
    database.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
    return { ...row, status: 'delivered' };
  });
  const rawBefore = database.prepare('SELECT id,content FROM conversations ORDER BY id').all();
  const db = await import('../../../comm-bridge/scripts/c4-db.js');
  const { formatConversation } = await import('../../../comm-bridge/scripts/router/format.js');
  for (const row of rows) {
    const projected = projectC4Content(row.content, { c4Id: row.id });
    for (const [name, text] of [['formatter', db.formatConversations([row])], ['agent', db.formatConversationsForAgent([row], { spill: false })]]) {
      safe(text, name); ok(text.includes(projected), `${name}: exact projection`);
    }
    for (const [name, text] of [['live', formatConversation(row)], ['agent-spill', db.formatConversationsForAgent([row])]]) {
      safe(text, name);
      if (row.content === contents[4]) {
        const spill = path.join(instance, 'comm-bridge/attachments', `conv-${row.id}`, 'message.txt');
        ok(text.includes(spill), `${name}: actual spill reference`);
        const full = fs.readFileSync(spill, 'utf8'); safe(full, name); ok(full.includes(projected));
      } else ok(text.includes(projected));
    }
  }
  outlets.push('router formatter/realtime spill', 'public formatter', 'agent formatter/spill');
  const { createDelivery } = await import('../../../comm-bridge/scripts/router/delivery.js');
  for (const runtime of ['claude', 'codex']) {
    for (const row of rows) {
      let sent = null, closed = 0;
      const target = { ready: true, runtime, runId: 'consumer-run', sessionId: '$1', paneId: '%1' };
      const delivery = createDelivery({
        getSessionMode: () => 'multi',
        openTmuxConnection: async () => ({ close: async () => { closed++; }, command: async () => '0' }),
        resolveSessionTarget: async () => target, revalidateSessionTarget: async () => {},
        readSessionState: async () => ({ identity: target, status: { valid: true, value: { state: 'idle', health: 'ok' } } }),
        readRuntimeHealth: () => ({ health: 'ok' }),
        readCurrentSession: async () => ({ runId: target.runId, sessionId: 'consumer-session' }),
        getSessionAdapter: () => ({ sendText: async ({ text }) => { sent = text; }, sendKeys: async () => {}, captureScreen: async () => '❯ ' }),
        formatConversation, notifyDelivered: () => {}, sleep: async () => {},
        db: { markDelivered: () => true, requeueConversation: () => assert.fail('consumer delivery requeued'), failDelivery: () => assert.fail('consumer delivery failed') },
      }, { periodicEnabled: false, captureEnabled: false });
      try {
        const result = await delivery.deliverConversation({ ...row, direction: 'in' });
        eq(result.delivered, true); eq(closed, 1); safe(sent, 'delivery adapter');
        if (row.content === contents[4]) ok(sent.includes('message.txt'));
        else ok(sent.includes(projectC4Content(row.content, { c4Id: row.id })));
      } finally { delivery.stop(); }
    }
  }
  outlets.push('actual delivery adapter boundary for Claude/Codex (injected transport)');
  const begin = String(rows[0].id), end = String(rows.at(-1).id);
  for (const [label, args] of [['range', ['--begin', begin, '--end', end]], ['since', ['--since', '2000-01-01']],
    ['unsummarized', ['--unsummarized', '--group', 'dashboard:alpha']],
    ['origin-combined', ['--origin-sync', '--group', 'dashboard:alpha']],
    ['origin-raw', ['--origin-sync', '--group', 'dashboard:alpha', '--raw-only', '--after', '0']]]) {
    for (const json of [false, true]) {
      const text = invoke(path.join(scripts, 'c4-fetch.js'), [...args, ...(json ? ['--json'] : [])]); safe(text, label);
      if (json || label === 'origin-combined') {
        const value = JSON.parse(text); const data = json ? value.data : value;
        checkRows(label === 'origin-raw' ? data : data.rows, rows, label);
      } else for (const row of rows) ok(text.includes(projectC4Content(row.content, { c4Id: row.id })));
    }
    outlets.push(`fetch ${label} text/JSON`);
  }
  for (const json of [false, true]) {
    const text = invoke(path.join(scripts, 'c4-db.js'), ['recent', '20', ...(json ? ['--json'] : [])]);
    const value = JSON.parse(text); checkRows(json ? value.data : value, rows, 'recent');
  }
  outlets.push('recent default/JSON');
  // Both startup consumers run with genuine SQLite and the real scoped bootstrap.
  const { initC4Session } = await import('../../../comm-bridge/scripts/c4-session-init.js');
  const startup = await initC4Session(); safe(startup, 'session init');
  for (const row of rows) ok(startup.includes(projectC4Content(row.content, { c4Id: row.id })));
  const { CORE_SHARDS } = await import('../../../activity-monitor/scripts/shard-registry.js');
  const shard = await CORE_SHARDS.find(item => item.name === 'c4-conversations').emit({ runtime: 'codex' });
  safe(shard, 'registry startup shard'); ok(shard.includes('Visible question summary'));
  const { runSessionStartShard } = await import('../../../activity-monitor/scripts/session-start-orchestrator.js');
  const output = path.join(root, 'startup-shard.txt'), fd = fs.openSync(output, 'w');
  try { await runSessionStartShard('c4-conversations', { runtime: 'claude' }, { stdout: { fd }, zylosDir: instance, tmpdir: process.env.TMPDIR }); }
  finally { fs.closeSync(fd); }
  const orchestrated = fs.readFileSync(output, 'utf8'); safe(orchestrated, 'startup orchestrator');
  ok(orchestrated.includes('Visible question summary')); eq(orchestrated.includes('UNAVAILABLE'), false);
  outlets.push('legacy startup', 'registry startup shard', 'startup orchestrator');
  // The external components are installed into this disposable instance only.
  for (const [name, key, command] of [['identity-reflection', 'ZYLOS_CHAT_IDENTITY_SOURCE', 'reflect.js'],
    ['thinking-patterns', 'ZYLOS_CHAT_THINKING_SOURCE', 'extract.js']]) {
    const source = fs.realpathSync(process.env[key]); const target = path.join(skills, name);
    fs.cpSync(source, target, { recursive: true, filter: file => !file.split(path.sep).includes('.git') && !file.split(path.sep).includes('node_modules') });
    const data = path.join(instance, 'components', name); fs.mkdirSync(data, { recursive: true });
    const config = name === 'identity-reflection'
      ? { min_conversations: 1, max_conversations: 20, c4_db: databaseFile, c4_fetch_script: path.join(scripts, 'c4-fetch.js') }
      : { min_conversations: 1, max_conversations: 20, c4_db_cli: path.join(scripts, 'c4-db.js') };
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
    if (name === 'thinking-patterns') fs.writeFileSync(path.join(data, 'policy.md'), `## Target\nPatterns file: ${path.join(root, 'patterns.md')}\n## Sources\nChannels: dashboard\nExclude channels:\n`);
    const text = invoke(path.join(target, 'scripts', command), ['fetch'], { ZYLOS_DATA_DIR: data });
    safe(text, name); const value = JSON.parse(text); eq(value.status, 'ready'); eq(value.count, rows.length);
    for (const row of rows) ok(value.conversations.includes(projectC4Content(row.content, { c4Id: row.id })));
    eq(fs.existsSync(path.join(data, 'state.json')), false, 'fetch does not advance the component cursor');
    outlets.push(`${name} actual fetch/prompt`);
  }
  // Preview and matching operate on the projected 80-character prefix.
  const { createQueryHandlers } = await import('../../../comm-bridge/scripts/c4-v2-cli.js');
  const query = createQueryHandlers(store);
  const groups = query.groups({ keyMatch: 'dashboard:' });
  safe(JSON.stringify(groups), 'preview'); eq(query.groups({ match: secret }).length, 0);
  eq(groups[0].preview.text, [...projectC4Content(rows[2].content, { c4Id: rows[2].id })].slice(0, 80).join(''));
  for (const [i, content] of contents.entries()) {
    const row = store.insertConversation('in', 'dashboard', `preview-${i}`, content, { groupName: `preview-${i}` });
    database.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
    const preview = query.groups({ keyMatch: `dashboard:preview-${i}` });
    eq(preview.length, 1);
    eq(preview[0].preview.text, [...projectC4Content(content, { c4Id: row.id })].slice(0, 80).join(''));
    safe(JSON.stringify(preview), 'all preview content classes');
  }
  for (const json of [false, true]) {
    for (const args of [[], ['--active-since', '0'], ['--key-match', 'dashboard:']]) {
      const text = invoke(path.join(scripts, 'c4-db.js'), ['groups', ...args, ...(json ? ['--json'] : [])]);
      safe(text, 'CLI group list'); const value = JSON.parse(text), data = json ? value.data : value;
      const page = Array.isArray(data) ? data : data.groups; eq(page.length, contents.length + 1);
    }
    const hiddenMatch = JSON.parse(invoke(path.join(scripts, 'c4-db.js'), ['groups', '--match', secret, ...(json ? ['--json'] : [])]));
    eq((json ? hiddenMatch.data : hiddenMatch).length, 0);
  }
  outlets.push('group preview/match and CLI listing modes');
  // Direct insert receipt is a model output; storage itself remains serialized.
  for (const json of [false, true]) {
    const text = invoke(path.join(scripts, 'c4-db.js'), ['insert', 'out', 'dashboard', 'alpha', contents[1], ...(json ? ['--json'] : [])]);
    safe(text, 'insert receipt'); const value = JSON.parse(json ? text : text.slice('Inserted: '.length));
    const row = json ? value.data : value; eq(row.content, projectC4Content(contents[1], { c4Id: row.id }));
    eq(database.prepare('SELECT content FROM conversations WHERE id=?').get(row.id).content, contents[1]);
  }
  outlets.push('direct insert text/JSON receipt');
  // Genuine mode-switch absorption and conversion, without launching a runtime.
  for (const content of [contents[1], contents[2], contents[3]]) store.insertConversation('in', 'dashboard', 'alpha', content, { groupName: 'alpha' });
  const { runId } = store.beginModeTransition('multi', 'single'); store.setDrainFence('*'); store.absorbForTransition(runId);
  const absorbed = store.getAbsorbedConversations(runId);
  eq(absorbed.length, 3);
  for (const json of [false, true]) {
    const args = ['--absorbed', '--run-id', runId];
    const page = invoke(path.join(scripts, 'c4-fetch.js'), [...args, ...(json ? ['--json'] : [])]); safe(page, 'absorbed page');
    if (json) { const items = JSON.parse(page).data.items; eq(items.length, absorbed.length);
      for (let i = 0; i < items.length; i++) { const projected = projectC4Content(absorbed[i].content, { c4Id: absorbed[i].id });
        eq(items[i].text, [...projected].slice(0, 300).join('')); eq(items[i].textBytes, Buffer.byteLength(projected)); }
    }
    for (const row of absorbed) {
      const text = invoke(path.join(scripts, 'c4-fetch.js'), [...args, '--id', String(row.id), ...(json ? ['--json'] : [])]); safe(text, 'absorbed full');
      const destination = path.join(root, `absorbed-${row.id}-${json}.txt`);
      invoke(path.join(scripts, 'c4-fetch.js'), [...args, '--id', String(row.id), '--out', destination, ...(json ? ['--json'] : [])]);
      eq(fs.readFileSync(destination, 'utf8'), projectC4Content(row.content, { c4Id: row.id }));
    }
  }
  outlets.push('absorbed text/JSON page/full/export');
  const { createModeSwitchConverter } = await import('../../../activity-monitor/scripts/mode-switch-convert.js');
  const conversion = createModeSwitchConverter({ db: store, zylosDir: instance })({ run_id: runId });
  const handoff = fs.readFileSync(conversion.handoff, 'utf8'); safe(handoff, 'conversion handoff');
  const exports = conversion.materials.filter(file => path.dirname(file) === path.join(instance, 'memory/mode-switch', runId));
  ok(exports.length > 0, 'conversion material list includes real exports');
  for (const file of conversion.materials) { ok(fs.statSync(file).isFile()); safe(fs.readFileSync(file, 'utf8'), 'conversion material'); }
  for (const file of exports) { const exported = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    ok(exported.length > 0); for (const row of exported) { const raw = database.prepare('SELECT content FROM conversations WHERE id=?').get(row.id); eq(row.content, projectC4Content(raw.content, { c4Id: row.id })); } }
  const state = fs.readFileSync(path.join(instance, 'memory/state.md'), 'utf8'); safe(state, 'converted state');
  for (const row of absorbed) ok(state.includes(String(row.id)));
  outlets.push('mode-switch state/handoff/material exports');
  store.setModeTransitionPhase(runId, 'cutover'); store.setModeTransitionPhase(runId, 'complete');
  // A legacy ungrouped serialized row exercises the other conversion export
  // branch. This is test-data setup, not a product insert bypass.
  const legacy = store.insertConversation('out', 'system', null, contents[1]);
  database.prepare("UPDATE conversations SET session_group='' WHERE id=?").run(legacy.id);
  const reverse = store.beginModeTransition('single', 'multi'); store.setDrainFence('*'); store.absorbForTransition(reverse.runId);
  const converted = createModeSwitchConverter({ db: store, zylosDir: instance })({ run_id: reverse.runId });
  const ungrouped = path.join(instance, 'memory/mode-switch', reverse.runId, 'ungrouped.md');
  ok(converted.materials.includes(ungrouped));
  const exportedLegacy = fs.readFileSync(ungrouped, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  eq(exportedLegacy.length, 1); eq(exportedLegacy[0].id, legacy.id);
  eq(exportedLegacy[0].content, projectC4Content(contents[1], { c4Id: legacy.id }));
  for (const file of converted.materials) { ok(fs.statSync(file).isFile()); safe(fs.readFileSync(file, 'utf8'), 'reverse conversion materials'); }
  safe(fs.readFileSync(converted.handoff, 'utf8'), 'reverse conversion handoff');
  eq(database.prepare('SELECT content FROM conversations WHERE id=?').get(legacy.id).content, contents[1]);
  outlets.push('single-to-multi legacy ungrouped export/material list');
  for (const before of rawBefore) eq(database.prepare('SELECT content FROM conversations WHERE id=?').get(before.id).content, before.content);
  outlets.push('raw SQLite preservation');
  db.close();
  process.stdout.write(JSON.stringify({ assertions, outlets, firstCounterexample: null }) + '\n');
} finally { database.close(); }
