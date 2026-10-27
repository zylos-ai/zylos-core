import { test, afterEach } from '@jest/globals';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture as storeFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { createModeSwitchConverter } from '../skills/activity-monitor/scripts/mode-switch-convert.js';
import { createQueryHandlers } from '../skills/comm-bridge/scripts/c4-v2-cli.js';
import { shellQuote } from '../skills/comm-bridge/scripts/c4-query-format.js';
import { emitC4Conversations } from '../skills/comm-bridge/scripts/c4-session-init.js';
import { formatConversationsForAgent } from '../skills/comm-bridge/scripts/c4-db.js';
import { readWorkMemory } from '../cli/lib/read-work-memory.js';
import { sendInternal } from '../skills/comm-bridge/scripts/c4-send-internal.js';
import { readAbsorbedReply, sendExternal } from '../skills/comm-bridge/scripts/c4-send-external.js';
import { commit, extractAbsorbedBlock } from '../skills/zylos-memory/scripts/sync-files.js';
import { acquire, release, memoryScope } from '../skills/zylos-memory/scripts/sync-lock.js';
import { renderStateSkeleton } from '../skills/zylos-memory/scripts/state-format.js';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-if67-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'comm-bridge'), { recursive: true });
  const { db, store } = storeFixture({ after: fn => cleanups.push(fn) }, {}, path.join(root, 'comm-bridge/c4.db'));
  db.pragma('journal_mode=WAL');
  const skills = path.join(root, '.claude/skills'); fs.mkdirSync(skills, { recursive: true });
  for (const skill of ['comm-bridge', 'zylos-memory']) fs.symlinkSync(path.join(repo, 'skills', skill), path.join(skills, skill));
  const sender = path.join(skills, 'demo/scripts/send.js'); fs.mkdirSync(path.dirname(sender), { recursive: true });
  const argvFile = path.join(root, 'argv.jsonl');
  fs.writeFileSync(path.join(skills, 'demo/package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(sender, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2).map(x => Buffer.from(x).toString('hex'))) + '\\n'); process.exit(process.argv[2] === 'fail-route' ? 1 : 0);`);
  const target = source === 'single' ? 'multi' : 'single';
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true }); fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: target }));
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, TMPDIR: root, ZYLOS_RUN_ID: 'fx-session-0' }; delete env.ZYLOS_SESSION_GROUP;
  const trace = [];
  if (process.env.P10_IF67_EVIDENCE_DIR) cleanups.push(() => {
    fs.mkdirSync(process.env.P10_IF67_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.P10_IF67_EVIDENCE_DIR, source + '-' + path.basename(root) + '.json'), JSON.stringify({ source, trace, argv: fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8') : '', conversations: db.prepare('SELECT * FROM conversations ORDER BY id').all() }, null, 2));
  });
  const add = (body, endpoint, group = 'a') => store.insertConversation('in', 'demo', endpoint, body, { groupName: group });
  function convert() { const { runId } = store.beginModeTransition(source, target); store.setDrainFence('*'); store.absorbForTransition(runId); const row = store.getModeTransition(); const result = createModeSwitchConverter({ db: store, zylosDir: root })(row); store.setModeTransitionPhase(runId, 'cutover'); store.setModeTransitionPhase(runId, 'complete'); return { row, ...result }; }
  function cli(name, args, { input = '', group, shell = false } = {}) {
    const childEnv = { ...env }; if (group && group !== '*') childEnv.ZYLOS_SESSION_GROUP = group;
    const script = path.join(skills, 'comm-bridge/scripts', name + '.js');
    const command = [process.execPath, script, ...args];
    const result = shell ? spawnSync('sh', ['-c', command.map(shellQuote).join(' ')], { env: childEnv, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) : spawnSync(command[0], command.slice(1), { env: childEnv, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    trace.push({ command, status: result.status, stdout: result.stdout, stderr: result.stderr }); return result;
  }
  return { root, db, store, env, skills, argvFile, trace, add, convert, cli, query: createQueryHandlers(store), api: { ...store, getDb: () => db, getConversationsByRange: (a, b) => db.prepare('SELECT * FROM conversations WHERE id>=? AND id<=? ORDER BY id').all(a,b) } };
}
function inputSnapshot(f) { return f.db.prepare("SELECT * FROM conversations WHERE direction='in' AND channel!='internal' ORDER BY id").all(); }
function argv(f) { return fs.existsSync(f.argvFile) ? fs.readFileSync(f.argvFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; }
function decodeEscapes(value) { return value.replace(/\\(u[0-9a-f]{4}|x[0-9a-f]{2}|[\\nrt])/g, (_, x) => x[0] === 'u' || x[0] === 'x' ? String.fromCharCode(parseInt(x.slice(1), 16)) : ({ '\\': '\\', n: '\n', r: '\r', t: '\t' })[x]); }
async function boot(f, scope, run, expectedHandoff) {
  const env = { ...f.env, ZYLOS_RUN_ID: run }; if (scope !== '*') env.ZYLOS_SESSION_GROUP = scope;
  const memory = await memoryScope(env);
  const output = await emitC4Conversations({}, null, {
    scopeReader: async () => ({ mode: scope === '*' ? 'single' : 'multi', scope, sessionGroup: scope === '*' ? null : scope, root: f.root, memoryDir: memory.memoryDir }),
    withDb: async (_label, action) => action({ ...f.store, formatConversationsForAgent }),
    migrationReader: async () => ({ state: 'done' }),
  });
  assert.match(output, /read-work-memory\.js/); assert.match(output, /handoff\.md/);
  const work = await readWorkMemory({ env, temporaryDir: f.root });
  const complete = work.data.spill ? JSON.parse(fs.readFileSync(work.data.spill.path, 'utf8')).data : work.data;
  assert.match(complete.text, /# Working State/);
  const handoff = fs.readFileSync(expectedHandoff, 'utf8'); assert.match(handoff, /--absorbed-reply/);
  // Group W4 is the retained main handoff referenced by the converter; all
  // replacement sessions reread it and their own guarded work-memory snapshot.
  f.trace.push({ boot: run, scope, output, handoff, state: complete.text });
  return { env, memory, work: complete };
}
async function commitProgress(f, scope, ids, commitFn = commit) {
  const env = { ...f.env, ZYLOS_RUN_ID: 'sync-' + scope }; if (scope !== '*') env.ZYLOS_SESSION_GROUP = scope;
  const memory = await memoryScope(env); const kind = scope === '*' ? 'global' : 'group';
  const token = await acquire({ env, kind }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const state = path.join(memory.memoryDir, 'state.md'), before = fs.readFileSync(state, 'utf8');
  fs.writeFileSync(`${state}.${token}.tmp`, renderStateSkeleton({ scope, syncedAt: '2026-10-27T00:00:00Z' }));
  try { await commitFn({ env, token, input: { followedUpIds: ids } }); } finally { await release({ env, token, kind }); }
  const after = fs.readFileSync(state, 'utf8'); f.trace.push({ commit: ids, scope, before, after }); return { before, after };
}

for (const source of ['single', 'multi']) test(`IF67 ${source}: converted W4, P06 replacement, real query/send CLI and guarded Sync preserve route/body bytes`, async () => {
  const f = fixture(source);
  const variants = [
    ['A', 'a'.repeat(65536), 'route-A'], ['H', 'hello', 'h'.repeat(20 * 1024)],
    ['I', 'hello', 'line\nback\\slash'], ['J', '\0'.repeat(8192), 'route-J'],
    ['K', '\u2028'.repeat(2730), 'route-K'], ['M', '', '"'.repeat(800)],
    ...['$(printf ROUTE_CHANGED)', '`printf ROUTE_CHANGED`', 'a"b\'c\\d', 'x; printf INJECTED'].map((e, i) => ['N' + i, 'hello', e]),
    ['O', 'hello', 'bad\0endpoint'], ['FAILED', 'hello', 'fail-route'], ['AFTER', 'continue', 'after-route'],
  ];
  const rows = variants.map(([name, body, endpoint]) => ({ name, ...f.add(body, endpoint) }));
  for (let i = 0; i < 3; i++) { const row = f.add('unscoped-' + i, 'origin-' + i, 'legacy'); f.db.prepare("UPDATE conversations SET session_group='' WHERE id=?").run(row.id); rows.push({ name: 'C' + i, ...row, session_group: '' }); }
  const converted = f.convert(), before = inputSnapshot(f), runId = converted.row.run_id;
  const scopes = source === 'single' ? ['origin', 'demo:a'] : ['*'];
  const finished = new Map(scopes.map(g => [g, []]));
  await boot(f, scopes[0], 'fx-origin-0', converted.handoff);
  if (source === 'single') {
    for (let replacement = 0; replacement < 2; replacement++) {
      await sendInternal(['internal', 'demo:a'], async () => `Read ${converted.handoff} and follow absorbed run ${runId}`, { env: { ...f.env, ZYLOS_SESSION_GROUP: 'origin' }, readIdentity: async () => null, insertMessage: f.store.insertInternalMessage });
    }
    assert.equal(f.db.prepare("SELECT count(*) n FROM conversations WHERE channel='internal' AND direction='in' AND session_group='demo:a'").get().n, 2);
  }
  // FX-RT tool corruption is rejected before recording any progress. Retry
  // smaller pages through the actual public CLI, for both tail and middle loss.
  for (const corruption of ['tail', 'middle']) {
    const full = f.cli('c4-fetch', ['--absorbed', '--run-id', runId, '--limit', '12', '--json']); assert.equal(full.status, 0, full.stderr);
    const bytes = Buffer.from(full.stdout);
    const damaged = (corruption === 'tail' ? bytes.subarray(0, -20) : Buffer.concat([bytes.subarray(0, 100), Buffer.from('<tool truncated>'), bytes.subarray(160)])).toString('utf8');
    assert.throws(() => JSON.parse(damaged));
    const retry = f.cli('c4-fetch', ['--absorbed', '--run-id', runId, '--limit', '2', '--json']); assert.equal(retry.status, 0, retry.stderr); assert.equal(JSON.parse(retry.stdout).data.items.length, 2);
    f.trace.push({ corruption, damaged, accepted: false, retryLimit: 2 });
  }
  let after = 0, pageIds = [];
  do {
    const result = f.cli('c4-fetch', ['--absorbed', '--run-id', runId, '--limit', '3', '--after', String(after), '--json']); assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout).data; assert.ok(page.count <= 3);
    for (const item of page.items) { const row = rows.find(r => r.id === item.id); assert.equal(item.textBytes, Buffer.byteLength(row.content)); assert.equal(item.text, Array.from(row.content).slice(0,300).join('')); assert.equal(item.textTruncated, Array.from(row.content).length > 300); pageIds.push(item.id); }
    after = page.next;
  } while (after !== null);
  assert.deepEqual(pageIds, rows.map(r => r.id));
  for (const row of rows) {
    const scope = source === 'single' ? row.session_group || 'origin' : '*';
    if (row.name === 'A') await boot(f, scope, 'fx-group-0', converted.handoff);
    const out = path.join(f.root, `full-${row.id}`);
    const args = ['--absorbed', '--run-id', runId, '--id', String(row.id)];
    if (Buffer.byteLength(row.content) > 8192 || ['J','K'].includes(row.name)) {
      const result = f.cli('c4-fetch', [...args, '--out', out]); assert.equal(result.status, 0, result.stderr); assert.deepEqual(fs.readFileSync(out), Buffer.from(row.content));
    }
    const fullJson = f.cli('c4-fetch', [...args, '--json']); assert.equal(fullJson.status, 0, fullJson.stderr); assert.equal(JSON.parse(fullJson.stdout).data.data, row.content);
    if (['J','K'].includes(row.name)) { const fullText = f.cli('c4-fetch', args); assert.equal(fullText.status, 0); const encoded = fullText.stdout.split('\ndata: ')[1].split('\nend id=')[0]; assert.equal(decodeEscapes(encoded), row.content); }
    const priorArgv = argv(f).length, priorOut = f.db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n;
    const sent = f.cli('c4-send', ['--absorbed-reply', runId, String(row.id)], { input: 'handled ' + row.name, group: scope, shell: row.name.startsWith('N') });
    if (row.name === 'O') {
      assert.equal(sent.status, 1); assert.match(sent.stderr, /ENDPOINT_NOT_PASSABLE/); assert.equal(argv(f).length, priorArgv); assert.equal(f.db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n, priorOut); continue;
    }
    assert.equal(argv(f).length, priorArgv + 1); assert.deepEqual(argv(f).at(-1), [Buffer.from(row.endpoint_id).toString('hex'), Buffer.from('handled ' + row.name).toString('hex')]);
    if (row.name === 'FAILED') { assert.equal(sent.status, 1); assert.match(sent.stderr, /SEND_FAILED/); continue; }
    assert.equal(sent.status, 0, sent.stderr); finished.get(scope).push(row.id);
    if (row.name === 'A') {
      await boot(f, scope, 'fx-group-replacement-1', converted.handoff);
      await boot(f, scope, 'fx-group-replacement-2', converted.handoff);
      // Audits are inspected but never treated as proof. FX-RT retained actual
      // component completion above; it resumes remaining rows without resend.
      assert.equal(argv(f).filter(a => a[0] === Buffer.from(row.endpoint_id).toString('hex')).length, 1);
    }
  }
  assert.equal(argv(f).filter(a => a[0] === Buffer.from('fail-route').toString('hex')).length, 1);
  assert.ok(argv(f).some(a => a[0] === Buffer.from('after-route').toString('hex')));
  for (const [scope, ids] of finished) {
    const { before: stateBefore, after: stateAfter } = await commitProgress(f, scope, ids);
    const original = extractAbsorbedBlock(stateBefore), remaining = extractAbsorbedBlock(stateAfter);
    assert.deepEqual(remaining.entries, original.entries.filter(e => !ids.includes(e.id)));
    if (remaining.entries.length) assert.equal(remaining.title, original.title);
  }
  assert.deepEqual(inputSnapshot(f), before);
  const remainingScope = source === 'single' ? 'demo:a' : '*';
  const remainingPath = remainingScope === '*' ? path.join(f.root, 'memory/state.md') : path.join(f.root, 'memory/session-groups', remainingScope, 'state.md');
  assert.deepEqual(extractAbsorbedBlock(fs.readFileSync(remainingPath, 'utf8')).entries.map(e => e.id), rows.filter(r => ['O','FAILED'].includes(r.name)).map(r => r.id));
}, 90000);

for (const source of ['single','multi']) test(`IF67 B ${source}: 1000 converted entries, actual reply progress, 10→990→empty guarded commits`, async () => {
  const f = fixture(source); for (let n = 0; n < 1000; n++) f.add('x', 'route-' + n);
  const converted = f.convert(), runId = converted.row.run_id, before = inputSnapshot(f), scope = source === 'single' ? 'demo:a' : '*';
  await boot(f, scope, 'fx-b-0', converted.handoff);
  const read = JSON.parse(f.query.absorbed({ runId, limit: 100, json: true })).data;
  assert.equal(read.items.length, 100); assert.ok(read.items.every(i => i.text === 'x' && !i.textTruncated));
  const evidence = [];
  async function handle(ids) {
    for (const id of ids) {
      const full = JSON.parse(f.query.absorbed({ runId, id, json: true })).data; assert.equal(full.data, 'x');
      // P09 production path with the same real D9/D1 transaction and argv child
      // as the CLI; avoids 1000 extra parent Node startups in the bulk case.
      await sendExternal(readAbsorbedReply(runId, String(id), f.api), 'ack', { api: f.api, skillsDir: f.skills, env: f.env, appendFallback: async () => {} }); evidence.push(id);
    }
  }
  await handle(Array.from({ length: 10 }, (_, i) => i + 1));
  const first = await commitProgress(f, scope, evidence);
  const original = extractAbsorbedBlock(first.before), remainder = extractAbsorbedBlock(first.after);
  assert.equal(original.entries.length, 1000); assert.equal(remainder.entries.length, 990); assert.equal(remainder.title, original.title); assert.deepEqual(remainder.entries, original.entries.slice(10));
  const empty = await commitProgress(f, scope, []); assert.deepEqual(extractAbsorbedBlock(empty.after), remainder);
  await boot(f, scope, 'fx-b-replacement', converted.handoff);
  const rest = Array.from({ length: 990 }, (_, i) => i + 11); await handle(rest);
  const final = await commitProgress(f, scope, rest); assert.equal(extractAbsorbedBlock(final.after).entries.length, 0); assert.doesNotMatch(final.after, /切换来信/);
  assert.equal(argv(f).length, 1000); assert.deepEqual(inputSnapshot(f), before);
}, 180000);

test('IF67 unsafe-integer IDs are rejected without misrouting or sending', () => {
  const f = fixture('single'), row = f.add('x', 'exact-route'), converted = f.convert(), runId = converted.row.run_id;
  const exact = '1000000000000000001'; f.db.prepare('UPDATE conversations SET id=? WHERE id=?').run(BigInt(exact), row.id);
  f.db.prepare('UPDATE mode_transitions SET absorbed_ids=? WHERE run_id=?').run(`[${exact}]`, runId);
  const query = f.cli('c4-fetch', ['--absorbed', '--run-id', runId, '--id', exact, '--json']); assert.equal(query.status, 1); assert.equal(JSON.parse(query.stdout).error.code, 'INVALID_ARGS');
  const send = f.cli('c4-send', ['--absorbed-reply', runId, exact], { input: 'must not misroute' }); assert.equal(send.status, 1); assert.match(send.stderr, /ABSORBED_NOT_IN_RUN/); assert.equal(argv(f).length, 0);
  assert.equal(Number.isSafeInteger(f.store.getModeTransition({ runId }).absorbed_ids[0]), false);
});

async function sourceVariant(f, relative, before, after) {
  const original = path.join(repo, relative), text = fs.readFileSync(original, 'utf8');
  assert.ok(text.includes(before), 'source mutation anchor must exist');
  const changed = text.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g, (_all, quote, dependency) => 'from ' + quote + pathToFileURL(path.resolve(path.dirname(original), dependency)).href + quote);
  const file = path.join(f.root, path.basename(original, '.js') + '-mutant.mjs'); fs.writeFileSync(file, changed);
  return import(pathToFileURL(file).href);
}

test('IF67 source controls: truncated-route and dropped-Pending mutations fail actual argv/state oracles', async () => {
  const f = fixture('single'), row = f.add('hello', 'r'.repeat(800)); f.add('unfinished', 'second-route'); const converted = f.convert();
  const runId = converted.row.run_id, scope = 'demo:a';
  const request = readAbsorbedReply(runId, String(row.id), f.api);
  await sendExternal(request, 'reply', { api: f.api, skillsDir: f.skills, env: f.env, appendFallback: async () => {} });
  const expected = Buffer.from(row.endpoint_id).toString('hex'); assert.equal(argv(f).at(-1)[0], expected);
  const sender = await sourceVariant(f, 'skills/comm-bridge/scripts/c4-send-external.js', 'endpoint: record.endpoint_id,', 'endpoint: record.endpoint_id.slice(0, 125),');
  await sender.sendExternal(sender.readAbsorbedReply(runId, String(row.id), f.api), 'reply', { api: f.api, skillsDir: f.skills, env: f.env, appendFallback: async () => {} });
  assert.throws(() => assert.equal(argv(f).at(-1)[0], expected), { code: 'ERR_ASSERTION' });
  const positive = await commitProgress(f, scope, []); assert.equal(extractAbsorbedBlock(positive.after).entries.length, 2);
  const sync = await sourceVariant(f, 'skills/zylos-memory/scripts/sync-files.js', 'remaining = block.entries.filter(entry => !followed.has(entry.id))', 'remaining = []');
  const bad = await commitProgress(f, scope, [], sync.commit);
  assert.throws(() => assert.deepEqual(extractAbsorbedBlock(bad.after), extractAbsorbedBlock(bad.before)), { code: 'ERR_ASSERTION' });
  f.trace.push({ sourceControls: ['truncated-route', 'dropped-pending'], detected: true });
});

test('IF67 FX-RT controls: incomplete page and outbound-only progress fail independent completeness/progress oracles', async () => {
  const f = fixture('single'); f.add('one', 'route-one'); const failed = f.add('two', 'fail-route'); const converted = f.convert(), runId = converted.row.run_id;
  const full = f.query.absorbed({ runId, json: true, limit: 2 });
  const actualIds = JSON.parse(full).data.items.map(row => row.id); assert.deepEqual(actualIds, [1, 2]);
  // Faulty tool adapter returns valid JSON after silently dropping one middle
  // item. An independent count/ID oracle must reject it, not just JSON.parse.
  const partial = JSON.parse(full); partial.data.items.splice(0, 1);
  assert.throws(() => assert.equal(partial.data.items.length, partial.data.count), { code: 'ERR_ASSERTION' });
  const result = f.cli('c4-send', ['--absorbed-reply', runId, String(failed.id)], { input: 'failed response', group: 'demo:a' });
  assert.equal(result.status, 1); assert.match(result.stderr, /SEND_FAILED/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n, 1);
  const actualProgress = new Set();
  const checkProgress = ids => { for (const id of ids) assert.ok(actualProgress.has(id), 'outbound audit alone is not actual follow-up evidence'); };
  checkProgress([]); assert.throws(() => checkProgress([failed.id]), { code: 'ERR_ASSERTION' });
  const saved = await commitProgress(f, 'demo:a', []); assert.equal(extractAbsorbedBlock(saved.after).entries.length, 2);
  f.trace.push({ fixtureControls: ['partial-valid-json', 'outbound-audit-only'], detected: true });
});
