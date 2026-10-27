// Opt-in real-model integration harness. This executes tools, never the Sync procedure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readyTmuxTarget } from '../../../../../test/helpers/ready-tmux-target.js';
import { tmuxNameForGroup, groupMemoryDir, groupRunDir } from '../../../../../cli/lib/session-group-paths.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
import { renderStateSkeleton, validateStateDocument, parseStateHeader } from '../../state-format.js';
import { extractAbsorbedBlock } from '../../sync-files.js';
import { EDIT_MEMORY_TOOL } from '../../memory-mcp-server.js';

export const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const memoryScripts = path.join(repository, 'skills/zylos-memory/scripts');
const bridgeScripts = path.join(repository, 'skills/comm-bridge/scripts');
const digest = value => createHash('sha256').update(value).digest('hex');
export const provenIds = [3, 17, 89, 144, 233, 377, 512, 688, 901, 997];
const originalCount = 1000;
const oldDate = '2026-10-20T08:00:00Z';
const scripts = Object.fromEntries(['sync-lock', 'sync-files', 'origin-cursor', 'request-rotation']
  .map(name => [name, path.join(memoryScripts, `${name}.js`)]));
Object.assign(scripts, Object.fromEntries(['c4-db', 'c4-fetch'].map(name => [name, path.join(bridgeScripts, `${name}.js`)])));

export const tools = [
  { name: 'read_file', description: 'Read a complete UTF-8 fixture file, relative to ZYLOS_DIR. No writes.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'list_files', description: 'List a fixture directory, relative to ZYLOS_DIR.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'run_script', description: 'Execute a real repository CLI with fixture-bound environment, argv and optional stdin. No shell.', inputSchema: { type: 'object', required: ['script', 'args'], properties: { script: { type: 'string', enum: Object.keys(scripts) }, args: { type: 'array', items: { type: 'string' } }, stdin: { type: 'string' } } } },
  EDIT_MEMORY_TOOL,
];

function makeOriginalRows(group) {
  return Array.from({ length: originalCount }, (_, index) => {
    const id = index + 1;
    const content = id === 2 ? 'Original request with LF\nCR\rTAB\t and U+2028\u2028.'
      : id === 4 ? '汉字'.repeat(400)
      : id === 5 ? 'x'.repeat(513)
      : id === 6 ? 'x'.repeat(512)
      : `Please track request ${id}; no completion has been received.`;
    return { id, timestamp: oldDate, channel: 'fixture', endpointId: id === 7 ? 'route'.repeat(150) : 'private', content, sessionGroup: group };
  });
}
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function serializeRows(db) { return JSON.stringify(db.prepare('SELECT * FROM conversations ORDER BY id').all()); }
function stateWithCoverage(scope, rows, runId) {
  return renderStateSkeleton({ scope, syncedAt: oldDate, absorbed: { runId, rows } }).replace('coverage= |', 'coverage=1000 |');
}

export function createFixture(t, { scope = 'p07', kind = scope === '*' ? 'global' : 'group', fault = null } = {}) {
  const runId = `p07-${randomUUID()}`;
  const f = readyTmuxTarget(t, { prefix: 'p07-model-', mode: scope === '*' ? 'single' : 'multi', runtime: 'codex', runId, packageRoot: repository });
  // Keep the shared helper's owned server alive across slow model calls.
  f.tmux('respawn-pane', '-k', '-t', '=zylos-group-origin:', '/bin/sleep', '3600');
  const env = { ...f.env, ZYLOS_RUN_ID: runId, PM2_HOME: path.join(f.root, '.pm2'), TZ: 'UTC' };
  if (scope !== '*') env.ZYLOS_SESSION_GROUP = scope;
  if (scope !== '*' && scope !== 'origin') {
    f.tmux('rename-session', '-t', '=zylos-group-origin', tmuxNameForGroup(scope));
    f.tmux('set-environment', '-t', `=${tmuxNameForGroup(scope)}`, 'ZYLOS_SESSION_GROUP', scope);
  }
  for (const [key, value] of Object.entries(process.env)) if (key.startsWith('P07_')) env[key] = value;
  const memoryDir = scope === '*' ? path.join(f.root, 'memory') : groupMemoryDir(scope, env);
  const runDir = groupRunDir(scope === '*' ? 'origin' : scope, env);
  fs.mkdirSync(runDir, { recursive: true });
  const sourceGroup = kind === 'origin' ? 'p07-source' : scope === '*' ? 'p07-source' : scope;
  const store = createStore(f.db);
  const rows = makeOriginalRows(sourceGroup);
  const insert = f.db.prepare('INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,status,session_group) VALUES(?,?,?,?,?,?,?,?)');
  f.db.transaction(() => {
    for (const row of rows) insert.run(row.id, row.timestamp, 'in', row.channel, row.endpointId, row.content, 'delivered', sourceGroup);
    f.db.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?)').run(sourceGroup, originalCount);
  })();
  const checkpoint = store.createCheckpoint(kind === 'origin' ? sourceGroup : scope, originalCount, 'Prior requests remain pending; no user-confirmed progress is recorded.');
  if (kind === 'origin') store.advanceOriginSyncCursor(sourceGroup, { syncedId: originalCount, checkpointId: checkpoint.id });
  const original = stateWithCoverage(scope, rows, runId);
  const statePath = path.join(memoryDir, 'state.md');
  write(statePath, fault === 'formal-bad-header' ? original.replace(/^.*\n/, '<!-- broken header -->\n') : original);
  write(path.join(memoryDir, 'inbox.md'), '# 2026-10-20\n\n- 08:01 [fact] Unresolved inbox item: keep the next appointment pending.\n');
  write(path.join(memoryDir, 'sessions/2026-10-20.md'), '# 2026-10-20\n\nThe next appointment is still pending. No additional request completions occurred.\n');
  write(path.join(f.root, 'memory/identity.md'), '# Identity\n\nI am Finch.\n');
  write(path.join(f.root, 'memory/references.md'), '# References\n\n- Projects: reference/projects.md\n');
  write(path.join(f.root, 'memory/reference/projects.md'), '# Projects\n\nNo cross-group correlations recorded.\n');
  if (kind === 'origin') write(path.join(f.root, `memory/session-groups/${sourceGroup}/sessions/2026-10-20.md`), '# 2026-10-20\n\nThe confirmed identity update is the only new durable fact.\n');
  const fixture = { ...f, env, scope, kind, sourceGroup, runId, runDir, memoryDir, statePath, original, rows, store, fault, trace: [], round: 0 };
  fixture.addInput = (content, direction = 'in') => {
    const result = f.db.prepare("INSERT INTO conversations(timestamp,direction,channel,endpoint_id,content,status,session_group) VALUES(?,?,?,?,?,'delivered',?)")
      .run('2026-10-20T09:00:00Z', direction, 'fixture', 'private', content, sourceGroup);
    f.db.prepare('UPDATE group_heads SET head_id=? WHERE session_group=?').run(Number(result.lastInsertRowid), sourceGroup);
    return Number(result.lastInsertRowid);
  };
  fixture.snapshot = () => ({ state: fs.readFileSync(statePath, 'utf8'), stateHash: digest(fs.readFileSync(statePath)), rowsHash: digest(serializeRows(f.db)),
    segments: fs.readdirSync(memoryDir).filter(name => /^inbox\./.test(name)).sort(),
    checkpoints: f.db.prepare('SELECT * FROM checkpoints ORDER BY id').all(), cursors: f.db.prepare('SELECT * FROM origin_sync_cursors ORDER BY session_group').all() });
  fixture.prepareRound = round => {
    fixture.round = round;
    fixture.trace = [];
    if (round === 1) {
      for (const id of provenIds) fixture.addInput(`User confirmation: I received the requested answer for original message #${id}, and its requested follow-up is complete.`);
      fixture.addInput('Outbound audit: sent an answer for original message #11. No recipient receipt was recorded.', 'out');
      fixture.addInput('SEND_FAILED for original message #12. Delivery is unconfirmed; the request remains pending.', 'out');
    } else if (round === 2) fixture.addInput('There has been no further progress on any pending original message. Keep every remaining request pending.');
    else fixture.addInput(`User confirmation: I received and accepted the completed follow-up for each of these original messages: ${rows.filter(row => !provenIds.includes(row.id)).map(row => '#' + row.id).join(', ')}. There are no unresolved original requests left.`);
    fixture.before = fixture.snapshot();
  };
  if (fault === 'rotation-transition' || fault === 'rotation-enqueue') {
    fixture.addInput('Owner confirms a durable identity change: the assistant is now called Juniper, replacing Finch. Record this in shared identity.');
    if (kind === 'origin') store.createCheckpoint(sourceGroup, originalCount + 1, 'Owner confirmed assistant identity changes from Finch to Juniper; shared identity must be updated.');
    if (fault === 'rotation-transition') store.beginModeTransition(scope === '*' ? 'single' : 'multi', scope === '*' ? 'multi' : 'single');
    fixture.before = fixture.snapshot();
  }
  return fixture;
}

function fixturePath(f, input) {
  if (typeof input !== 'string') throw new Error('path must be a string');
  const target = path.resolve(f.root, input);
  const relative = path.relative(f.root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture path escaped isolated root');
  const resolved = fs.realpathSync(target);
  const root = fs.realpathSync(f.root);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Fixture symlink escaped isolated root');
  return target;
}
function cli(f, name, args, input = '') {
  const result = spawnSync(process.execPath, [scripts[name], ...args], { env: f.env, cwd: f.root, input, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { error: result.error.message } : {}) };
}

function memoryClient(f) {
  const child = spawn(process.execPath, [path.join(memoryScripts, 'memory-mcp-server.js')], { env: f.env, cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message);
  });
  const closed = new Promise(resolve => child.on('close', (code, signal) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited ${code}/${signal}: ${stderr}`)); }
    pending.clear(); resolve();
  }));
  child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timeout')); }, 25000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request, close: async () => { child.stdin.end(); child.kill(); await closed; }, stderr: () => stderr };
}

// Harness faults are visible in the trace; request, effective arguments and the
// real underlying result remain distinct. These are boundary injections, not a
// procedure emulator, and the model must decide how to react.
export async function createToolExecutor(f) {
  const mcp = memoryClient(f);
  await mcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p07-integration', version: '1' } });
  let injected = false;
  return {
    close: mcp.close,
    async execute(request) {
      const event = { sequence: f.trace.length + 1, at: new Date().toISOString(), request: structuredClone(request), effective: structuredClone(request.arguments || {}), before: f.snapshot() };
      const a = event.effective;
      let result;
      try {
        if (request.name === 'read_file') {
          const file = fixturePath(f, a.path), info = fs.statSync(file);
          if (info.size > 2 * 1024 * 1024) throw new Error('File exceeds complete-read limit');
          result = { ok: true, path: a.path, content: fs.readFileSync(file, 'utf8') };
        } else if (request.name === 'list_files') result = { ok: true, entries: fs.readdirSync(fixturePath(f, a.path)).sort() };
        else if (request.name === 'edit_memory') {
          if (!injected && /state\.md\..*\.tmp$/.test(a.path) && ['copy-block', 'temporary-bad-header', 'temporary-missing-section'].includes(f.fault)) {
            if (f.fault === 'copy-block') {
              const block = extractAbsorbedBlock(f.original);
              a.replacement = a.replacement.replace('## Pending\n', '## Pending\n\n' + block.title + block.entries.map(item => item.raw).join(''));
            } else if (f.fault === 'temporary-bad-header') a.replacement = a.replacement.replace(/^.*\n/, '<!-- corrupted temporary header -->\n');
            else a.replacement = a.replacement.replace('## Commitments', '## Missing Commitments');
            event.injection = f.fault; injected = true;
          }
          const rpc = await mcp.request('tools/call', { name: 'edit_memory', arguments: a });
          result = rpc.error ? { ok: false, code: 'TOOL_PROTOCOL_ERROR', rpc } : { ...JSON.parse(rpc.result.content[0].text), rpc };
        } else if (request.name === 'run_script') {
          if (!Object.hasOwn(scripts, a.script) || !Array.isArray(a.args) || a.args.some(value => typeof value !== 'string') || (a.stdin !== undefined && typeof a.stdin !== 'string')) throw new Error('Invalid script request');
          // Read tools must not expose other command surfaces or --out writes.
          if (a.script === 'c4-db' && !['unsummarized', 'origin-sync'].includes(a.args[0])) throw new Error('c4-db command is outside Sync read surface');
          if (a.script === 'c4-fetch' && (a.args.includes('--out') || !['--unsummarized', '--checkpoints', '--origin-sync', '--absorbed', '--begin'].includes(a.args[0]))) throw new Error('c4-fetch command is outside Sync read surface');
          if (!injected && f.fault === 'read-failure' && a.script === 'c4-fetch' && a.args.includes('--unsummarized')) {
            result = { status: 1, stdout: '', stderr: 'Error [READ_FAILED]: injected required source read failure\n' }; event.injection = f.fault; injected = true;
          }
          if (!injected && f.fault === 'token-mismatch' && a.script === 'sync-files' && a.args[0] === 'cleanup') {
            const marker = path.join(f.runDir, 'sync.lock');
            const value = JSON.parse(fs.readFileSync(marker, 'utf8')); value.token = 'b'.repeat(32); fs.writeFileSync(marker, JSON.stringify(value));
            event.injection = f.fault; injected = true;
          }
          if (!injected && f.fault === 'unknown-id' && a.script === 'sync-files' && a.args[0] === 'commit') {
            a.stdin = JSON.stringify({ ...JSON.parse(a.stdin), followedUpIds: [...JSON.parse(a.stdin).followedUpIds, 1000001] }); event.injection = f.fault; injected = true;
          }
          if (!injected && f.fault === 'release-failure' && a.script === 'sync-lock' && a.args[0] === 'release') {
            result = { status: 1, stdout: '', stderr: 'Error [WRITE_FAILED]: injected release publication failure\n' }; event.injection = f.fault; injected = true;
          }
          if (!injected && f.fault === 'rotation-enqueue' && a.script === 'request-rotation') {
            result = { status: 1, stdout: '', stderr: 'Error [DB_WRITE_FAILED]: injected rotation queue failure\n' }; event.injection = f.fault; injected = true;
          }
          result ??= cli(f, a.script, a.args, a.stdin);
        } else throw new Error(`Unknown tool: ${request.name}`);
      } catch (error) { result = { ok: false, code: error.code || 'TOOL_PROTOCOL_ERROR', message: error.message }; }
      event.result = result; event.after = f.snapshot(); f.trace.push(event);
      return result;
    },
  };
}

export function promptFor(f) {
  const skill = fs.readFileSync(path.join(repository, 'skills/zylos-memory/SKILL.md'), 'utf8');
  const procedures = fs.readFileSync(path.join(repository, 'skills/zylos-memory/references/sync-procedures.md'), 'utf8');
  const format = fs.readFileSync(path.join(repository, 'skills/zylos-memory/references/state-format.md'), 'utf8');
  return `Perform one ${f.kind} Memory Sync, using the production instructions below and only the provided tools. This is an isolated fixture with real scripts and a real restricted MCP tool. Do not access the filesystem outside the tools, and do not delegate again. The requesting supervisor has already launched you as its background worker. Resolve facts from the available inputs; do not infer progress from the scenario name. Report the outcome and any failure honestly in your final text.\n\nInherited environment: ZYLOS_DIR=${f.root}; ZYLOS_RUN_ID=${f.env.ZYLOS_RUN_ID}; ${f.scope === '*' ? 'ZYLOS_SESSION_GROUP is absent' : 'ZYLOS_SESSION_GROUP=' + f.scope}; TZ=UTC. Script names map directly to run_script. read_file/list_files paths are relative to ZYLOS_DIR; edit_memory paths are relative to memory as in the production tool. No native write tool is permitted.\n\n${skill}\n\n${procedures}\n\n${format}`;
}

export async function runDriver(f, scenarioId, { executable = process.env.P07_MODEL_DRIVER, args = JSON.parse(process.env.P07_MODEL_DRIVER_ARGS || '[]'), timeoutMs = 600000 } = {}) {
  assert.ok(executable && path.isAbsolute(executable), 'P07_MODEL_DRIVER must be an absolute executable path');
  assert.ok(Array.isArray(args) && args.every(value => typeof value === 'string'), 'P07_MODEL_DRIVER_ARGS must be a JSON array of strings');
  const evidenceRoot = process.env.P07_MODEL_EVIDENCE_DIR || path.join(f.root, 'evidence');
  const evidenceDir = path.join(evidenceRoot, scenarioId + '-' + randomUUID()); fs.mkdirSync(evidenceDir, { recursive: true });
  const executor = await createToolExecutor(f);
  const child = spawn(executable, args, { env: f.env, cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
  const start = { type: 'start', protocol: 1, scenarioId, prompt: promptFor(f), tools,
    context: { scope: f.scope, kind: f.kind, root: f.root, memoryDir: f.memoryDir, runId: f.env.ZYLOS_RUN_ID }, evidenceDir };
  write(path.join(evidenceDir, 'start.json'), JSON.stringify(start, null, 2));
  let final, stderr = '', count = 0, failure;
  const ids = new Set();
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { failure = error; });
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => { failure = new Error('Model driver timed out'); child.kill('SIGKILL'); }, timeoutMs);
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify(start) + '\n');
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const message = JSON.parse(line);
      if (final) throw new Error('Driver emitted data after final');
      if (message.type === 'final') { final = message; child.stdin.end(); continue; }
      if (message.type !== 'tool_call' || typeof message.id !== 'string' || ids.has(message.id)) throw new Error('Invalid or duplicate driver request');
      ids.add(message.id);
      if (++count > 100) throw new Error('Model exceeded 100 tool calls');
      const result = await executor.execute(message);
      fs.appendFileSync(path.join(evidenceDir, 'trace.jsonl'), JSON.stringify(f.trace.at(-1)) + '\n');
      child.stdin.write(JSON.stringify({ type: 'tool_result', id: message.id, result }) + '\n');
    }
    const exit = await exited;
    if (failure) throw failure;
    assert.equal(exit.code, 0, `Model driver exit: ${JSON.stringify(exit)} ${stderr}`);
    assert.ok(final && typeof final.text === 'string', 'Model driver must return a final report');
    return { final, evidenceDir, trace: f.trace, snapshot: f.snapshot() };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    clearTimeout(timer); child.kill('SIGKILL'); await exited; await executor.close();
    write(path.join(evidenceDir, 'result.json'), JSON.stringify({ final: final ?? null, toolCalls: count, failure: failure?.message, stderr, snapshot: f.snapshot() }, null, 2));
  }
}

export function assertPreserved(before, after, followedUpIds) {
  const original = extractAbsorbedBlock(before), current = extractAbsorbedBlock(after);
  const expected = original.entries.filter(entry => !followedUpIds.includes(entry.id));
  assert.deepEqual(current.entries, expected, 'Each remaining original ID and raw line must be byte-for-byte preserved');
  assert.equal(current.title, expected.length ? original.title : null, 'Original title is preserved until the last entry is followed up');
}
const isScript = (event, script, command) => event.request.name === 'run_script' && event.effective.script === script && (command === undefined || event.effective.args[0] === command);
const statusOkay = event => event.result.status === 0;
const sorted = ids => [...new Set(ids)].sort((a, b) => a - b);

export function assertSuccessfulSync(f, result, expectedIds, { copied = false } = {}) {
  const events = result.trace;
  const commits = events.filter(event => isScript(event, 'sync-files', 'commit'));
  assert.equal(commits.length, 1, 'Exactly one commit attempt');
  assert.ok(statusOkay(commits[0]), JSON.stringify(commits[0].result));
  assert.deepEqual(sorted(JSON.parse(commits[0].effective.stdin).followedUpIds), sorted(expectedIds), 'Followed IDs require actual source confirmation, not an outbound audit');
  assertPreserved(f.before.state, result.snapshot.state, expectedIds);
  assert.equal(result.snapshot.rowsHash, f.before.rowsHash, 'C4 source rows are immutable');
  assert.ok(validateStateDocument(result.snapshot.state, { scope: f.scope }));
  const checkpoints = events.filter(event => isScript(event, 'sync-files', 'checkpoint'));
  const temporary = events.filter(event => event.request.name === 'edit_memory' && /state\.md\..*\.tmp$/.test(event.effective.path));
  assert.equal(checkpoints.length, 1); assert.equal(temporary.length, 1);
  assert.ok(statusOkay(checkpoints[0])); assert.equal(temporary[0].result.ok, true);
  assert.equal(extractAbsorbedBlock(temporary[0].request.arguments.replacement).entries.length, 0, 'The model must not copy the absorbed block');
  assert.ok(checkpoints[0].sequence < temporary[0].sequence && temporary[0].sequence < commits[0].sequence, 'checkpoint precedes restricted temporary write and commit');
  const fetch = events.find(event => isScript(event, 'c4-fetch') && event.effective.args.includes('--unsummarized'));
  const cleanup = events.find(event => isScript(event, 'sync-files', 'cleanup'));
  const rotate = events.find(event => isScript(event, 'sync-files', 'rotate'));
  assert.ok(fetch && cleanup && rotate && fetch.sequence < cleanup.sequence && cleanup.sequence < rotate.sequence, 'Required input fetch precedes cleanup and rotate');
  assert.ok(statusOkay(fetch)); assert.ok(statusOkay(cleanup)); assert.ok(statusOkay(rotate));
  const batchEnd = fetch.effective.args.includes('--json')
    ? JSON.parse(fetch.result.stdout).data.upTo
    : Number(/\bupTo=(\d+)\b/.exec(fetch.result.stdout)?.[1]);
  assert.ok(Number.isSafeInteger(batchEnd), 'Fetch exposes an exact batch end');
  assert.equal(Number(checkpoints[0].effective.args[1]), batchEnd, 'Checkpoint uses the returned batch end');
  const header = parseStateHeader(result.snapshot.state, { scope: f.scope });
  assert.equal(header.coverage, batchEnd);
  const reads = events.filter(event => event.request.name === 'read_file' && event.result.ok);
  const readPath = event => path.resolve(f.root, event.effective.path);
  const stateRead = reads.find(event => readPath(event) === f.statePath && event.sequence < checkpoints[0].sequence);
  const listing = events.find(event => isScript(event, 'sync-files', 'list'));
  assert.ok(stateRead && listing && statusOkay(listing), 'State and uncommitted segment listing were read');
  assert.ok(rotate.sequence < stateRead.sequence && stateRead.sequence < listing.sequence);
  const segments = JSON.parse(listing.result.stdout);
  assert.deepEqual([...header.inboxCommitted].sort(), [...segments].sort(), 'Every listed segment is committed');
  const segmentReads = segments.map(id => reads.find(event => readPath(event) === path.join(f.memoryDir, `inbox.${id}.md`)));
  assert.ok(segmentReads.every(event => event && event.sequence > listing.sequence && event.sequence < checkpoints[0].sequence), 'Every listed segment is read before checkpoint');
  assert.deepEqual(segmentReads.map(event => event.sequence), segmentReads.map(event => event.sequence).sort((a, b) => a - b), 'Segments are read in listed order');
  if (f.before.state.split('\n', 1)[0].includes('synced_at=2026-10-20')) {
    assert.ok(reads.some(event => readPath(event) === path.join(f.memoryDir, 'sessions/2026-10-20.md') && event.sequence < checkpoints[0].sequence), 'Required dated log was read');
  }
  assert.ok(reads.some(event => readPath(event) === f.statePath && event.sequence > commits[0].sequence), 'Published state is checked');
  assert.ok(segments.every(id => !result.snapshot.segments.includes(`inbox.${id}.md`)), 'Committed input segments are removed');
  const releases = events.filter(event => isScript(event, 'sync-lock', 'release'));
  assert.equal(releases.length, 1, 'Exactly one release');
  assert.equal(events.at(-1), releases[0], 'Release is the final tool');
  if (f.fault !== 'release-failure') assert.ok(statusOkay(releases[0]));
  if (copied) assert.match(commits[0].result.stderr, /copied absorbed-message lines/);
  if (f.scope === '*') {
    assert.ok(events.every(event => !(event.request.name === 'read_file' && /session-groups/.test(event.effective.path))), 'Global Sync must not read group folders');
    assert.ok(events.filter(event => isScript(event, 'c4-fetch') || isScript(event, 'c4-db')).every(event => !event.effective.args.includes('--group')), 'Global C4 reads omit group');
  }
}

export function assertFailureFlow(f, result, fault) {
  const events = result.trace, releases = events.filter(event => isScript(event, 'sync-lock', 'release'));
  const commits = events.filter(event => isScript(event, 'sync-files', 'commit'));
  if (fault === 'busy' || fault === 'acquire-failure') {
    const acquires = events.filter(event => isScript(event, 'sync-lock', 'acquire'));
    assert.equal(acquires.length, 1);
    assert.equal(releases.length, 0); assert.equal(events.at(-1), acquires[0], 'No operation follows unsuccessful acquire');
    assert.ok(events.slice(0, -1).every(event => event.request.name === 'read_file' && path.resolve(f.root, event.effective.path) === path.join(f.root, '.zylos/config.json')), 'Only limit configuration may be read before acquire');
    assert.match(result.final.text, fault === 'busy' ? /SYNC_BUSY|already running|busy|已.*运行|忙/i : /SCOPE_UNBOUND|fail|失败|identity|身份/i);
  } else if (fault === 'token-mismatch') {
    const index = events.findIndex(event => event.result.status === 3 || event.result.code === 'TOKEN_MISMATCH');
    assert.ok(index >= 0); assert.equal(index, events.length - 1, 'TOKEN_MISMATCH stops all tools, including release'); assert.equal(releases.length, 0);
    assert.match(result.final.text, /TOKEN_MISMATCH|token|令牌/i);
  } else {
    assert.equal(releases.length, 1, 'Required-step failure releases exactly once');
    assert.equal(events.at(-1), releases[0], 'Release is the final tool after failure');
    if (fault === 'read-failure') {
      assert.equal(commits.length, 0);
      assert.equal(events.filter(event => isScript(event, 'sync-files')).length, 0, 'Read failure precedes every file mutation');
      assert.match(result.final.text, /READ_FAILED|read|读取|失败/i);
    } else {
      assert.equal(commits.length, 1); assert.equal(commits[0].result.status, 1);
      assert.match(commits[0].result.stderr, fault === 'unknown-id' ? /INVALID_INPUT/ : /STATE_DOCUMENT_INVALID/);
      assert.equal(commits[0].before.stateHash, commits[0].after.stateHash);
      assert.deepEqual(commits[0].before.segments, commits[0].after.segments);
    }
  }
  assert.equal(result.snapshot.stateHash, f.before.stateHash, 'Failure does not publish a replacement');
  assert.equal(result.snapshot.rowsHash, f.before.rowsHash);
}

export function assertRotationFlow(f, result) {
  const events = result.trace;
  const identityWrite = events.find(event => event.request.name === 'edit_memory' && event.effective.path === 'identity.md' && event.result.ok);
  const rotation = events.find(event => isScript(event, 'request-rotation'));
  assert.ok(identityWrite && rotation && identityWrite.sequence < rotation.sequence, 'Identity must be written before rotation request');
  assert.match(fs.readFileSync(path.join(f.root, 'memory/identity.md'), 'utf8'), /Juniper/);
  assert.equal(rotation.result.status, 1);
  assert.match(rotation.result.stderr, /TRANSITION_OPEN|DB_WRITE_FAILED/);
  assert.match(result.final.text, /rotation|轮转/i);
  assert.match(result.final.text, /incomplete|not.*(?:complete|queued)|failed|blocked|未完成|失败|拒绝|未.*(?:入队|完成)/i);
  assert.doesNotMatch(result.final.text, /(?:will|shall) (?:automatically )?retry|(?:会|将).*自动.*(?:重试|补发)/i);
  if (f.kind === 'global') assertSuccessfulSync(f, result, []);
  else {
    assert.equal(result.snapshot.stateHash, f.before.stateHash, 'Origin job must not change its own group Pending');
    assert.ok(!events.some(event => isScript(event, 'sync-files')));
    assert.ok(!events.some(event => event.request.name === 'read_file' && /session-groups\/[^/]+\/(?:state\.md|inbox)/.test(event.effective.path)));
    const advances = events.filter(event => isScript(event, 'origin-cursor', 'advance'));
    assert.equal(advances.length, 1); assert.ok(statusOkay(advances[0])); assert.ok(rotation.sequence < advances[0].sequence);
    const summaries = events.find(event => isScript(event, 'c4-fetch') && event.effective.args.includes('--summaries-only'));
    assert.ok(summaries && statusOkay(summaries) && summaries.sequence < advances[0].sequence, 'Advance follows the first successful summary read');
    const { coverageEnd, checkpointId } = JSON.parse(summaries.result.stdout);
    assert.ok(Number.isSafeInteger(checkpointId) && checkpointId > 0);
    const cursor = result.snapshot.cursors.find(row => row.session_group === f.sourceGroup);
    assert.equal(cursor.synced_id, coverageEnd); assert.equal(cursor.checkpoint_id, checkpointId);
    assert.equal(events.filter(event => isScript(event, 'sync-lock', 'release')).length, 1);
  }
}

export function prepareAcquireFault(f, fault) {
  if (fault === 'busy') { const result = cli(f, 'sync-lock', ['acquire', '--kind', f.kind]); assert.equal(result.status, 0, result.stderr); }
  else if (fault === 'acquire-failure') f.env.ZYLOS_RUN_ID = 'not-the-running-session';
}
