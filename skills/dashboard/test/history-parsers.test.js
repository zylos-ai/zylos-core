import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SessionLogIndex, SessionLogIndexCache } from '../src/lib/history/session-log-index.js';
import { ClaudeHistory } from '../src/lib/history/claude-history.js';
import { CodexHistory } from '../src/lib/history/codex-history.js';
import { parseOutbound, parseInbound, safeFullText } from '../src/lib/history/inbound-parser.js';
import { claudeProjectSlug } from '../src/lib/claude-project-path.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'history-parser-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const zylosDir = path.join(homeDir, 'zylos.test_dir');
  await fs.mkdir(zylosDir, { recursive: true });
  const projectDir = path.join(homeDir, '.claude', 'projects', claudeProjectSlug(zylosDir));
  await fs.mkdir(projectDir, { recursive: true });
  return { root, homeDir, zylosDir, projectDir };
}
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';

test('index handles incomplete tails, byte offsets, append, truncate and replacement', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'log');
  await fs.writeFile(file, '汉\n{"incomplete":');
  const index = new SessionLogIndex(file);
  const pending = index.update();
  assert.equal(index.update(), pending);
  await pending;
  assert.deepEqual(index.lines.map(l => [l.offset, l.length]), [[0, 3]]);
  await fs.appendFile(file, 'true}\n'); await index.update();
  assert.equal(index.lines[1].offset, 4);
  assert.equal(await index.readLine(index.lines[1]), '{"incomplete":true}');
  const generation = index.generation;
  await fs.writeFile(file, 'a\n'); await index.update();
  assert.equal(index.lines.length, 1); assert.ok(index.generation > generation);
  await fs.rename(file, file + '.old'); await fs.writeFile(file, 'replacement\n');
  await index.update(); assert.equal(await index.readLine(index.lines[0]), 'replacement');
});

test('17MiB lines are indexed without parsing and cache is LRU 8', async t => {
  const { root } = await fixture(t);
  const cache = new SessionLogIndexCache();
  for (let i = 0; i < 9; i++) {
    const file = path.join(root, `${i}.jsonl`);
    await fs.writeFile(file, i === 0 ? JSON.stringify({ data: 'x'.repeat(17 * 1024 * 1024) }) + '\n' : '{}\n');
    const index = await cache.get(file);
    if (i === 0) { assert.equal(index.lines.length, 1); assert.equal(index.lines[0].deferred, true); }
  }
  assert.equal(cache.cache.size, 8); assert.equal(cache.cache.has(path.join(root, '0.jsonl')), false);
});

test('Claude real-format fixture preserves busy inbound, file order, pairing and binary data read-only', async t => {
  const options = await fixture(t);
  const file = path.join(options.projectDir, 'session-1.jsonl');
  await fs.copyFile(new URL('./fixtures/history/claude.jsonl', import.meta.url), file);
  const before = await fs.stat(file), hash = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  await fs.chmod(file, 0o444);
  const parser = new ClaudeHistory({ ...options, stateEngine: { getCurrentSessionId: () => 'session-1' } });
  const list = await parser.listSessions(); assert.equal(list.current, 'session-1');
  const { entries } = await parser.loadSession('session-1');
  assert.ok(entries.some(e => e.kind === 'inbound' && e.fields.body.includes('message while busy')));
  assert.deepEqual(entries.filter(e => e.kind === 'text').map(e => e.fields.body), ['Part one', 'Part two']);
  const tool = entries.find(e => e.kind === 'tool'); assert.equal(tool.status, 'success'); assert.equal(tool.fields.output, 'fixture');
  assert.ok(Number.isFinite(tool.updatedOffset));
  const binary = entries.filter(e => e.binaries); assert.equal(binary.length, 2);
  assert.equal(binary[1].binaries.attachment.data.toString(), '%PDF');
  assert.ok(entries.some(e => e.kind === 'marker'));
  assert.ok(entries.some(e => e.kind === 'internal' && e.fields.body === 'Runtime did not save thinking content.'));
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'), hash);
});

test('Claude lists subagents lacking meta across clear, correct shared slug, rejects unknown sessions', async t => {
  const options = await fixture(t);
  assert.ok(path.basename(options.projectDir).includes('zylos-test-dir'));
  await fs.mkdir(path.join(options.projectDir, 'old-session', 'subagents'), { recursive: true });
  await fs.writeFile(path.join(options.projectDir, 'old-session', 'subagents', 'agent-123.jsonl'), '{}\n');
  const parser = new ClaudeHistory(options);
  const list = await parser.listSessions(); assert.equal(list.sessions[0].id, 'old-session/agent-123');
  await assert.rejects(parser.loadSession('../outside'), /invalid_session/);
});

test('full text allowlists recover real files and reject traversal, symlink and foreign files', async t => {
  const options = await fixture(t);
  const conv = path.join(options.zylosDir, 'comm-bridge', 'attachments', 'conv-12');
  await fs.mkdir(conv, { recursive: true });
  const file = path.join(conv, 'message.txt'); await fs.writeFile(file, 'complete inbound');
  assert.equal((await safeFullText(file, options)).text, 'complete inbound');
  const outside = path.join(options.root, 'outside.txt'); await fs.writeFile(outside, 'DO NOT READ');
  assert.ok((await safeFullText(outside, options)).unavailable);
  assert.ok((await safeFullText(`${conv}/../conv-12/message.txt`, options)).unavailable);
  await fs.rename(file, path.join(conv, 'original.txt')); await fs.symlink(outside, file);
  assert.ok((await safeFullText(file, options)).unavailable);
  assert.ok((await safeFullText(path.join(conv, 'missing.txt'), options)).unavailable);
});

test('Claude recovers C4 and persisted tool output, reports missing source while preserving preview', async t => {
  const options = await fixture(t);
  const full = path.join(options.zylosDir, 'comm-bridge', 'attachments', 'conv-1', 'message.txt');
  const tools = path.join(options.projectDir, 'session-1', 'tool-results');
  await fs.mkdir(path.dirname(full), { recursive: true }); await fs.mkdir(tools, { recursive: true });
  await fs.writeFile(full, '[TG DM from Owner] full body'); await fs.writeFile(path.join(tools, 'result.txt'), 'full tool output');
  const file = path.join(options.projectDir, 'session-1.jsonl');
  await fs.writeFile(file, jsonl([
    { type: 'user', message: { content: `[TG DM] preview\n[C4] TRUNCATED complete message file: ${full}` } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'fixture' } }] } },
    { type: 'user', toolUseResult: { persistedOutputPath: path.join(tools, 'result.txt') }, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '<persisted-output>preview</persisted-output>' }] } },
    { type: 'user', message: { content: `[TG DM] retained preview\n[C4] complete message file: ${full.replace('conv-1', 'conv-2')}` } }
  ]));
  const { entries } = await new ClaudeHistory(options).loadSession('session-1');
  assert.equal(entries[0].fields.body, '[TG DM from Owner] full body');
  assert.equal(entries[1].fields.output, 'full tool output');
  assert.match(entries.at(-1).fields.body, /retained preview[\s\S]*no longer exists/);
});

test('Codex pairs multiple CommandExecution records to nearest call in the same turn', async t => {
  const options = await fixture(t);
  const dir = path.join(options.homeDir, '.codex', 'sessions', '2026', '09', '27');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'rollout-fixture.jsonl');
  await fs.copyFile(new URL('./fixtures/history/codex.jsonl', import.meta.url), file);
  const row = { session_id: 'codex-main', transcript_path: file };
  const parser = new CodexHistory({ ...options, store: { listCodexRolloutPaths: () => [row], latestCodexRolloutPath: () => row } });
  assert.equal((await parser.listSessions()).current, 'codex-main');
  let { entries } = await parser.loadSession('codex-main');
  const tool = entries.find(e => e.kind === 'tool');
  assert.deepEqual(tool.fields.commands.map(c => c.output), ['one complete', 'two complete']);
  assert.equal(entries.filter(e => e.kind === 'inbound').length, 1);
  await fs.appendFile(file, jsonl([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-2', item: { type: 'CommandExecution', aggregated_output: 'unrelated' } } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'late', name: 'exec_command', arguments: '{"cmd":"echo late"}' } }
  ]));
  ({ entries } = await parser.loadSession('codex-main'));
  assert.equal(tool.fields.commands.length, 2);
  const late = entries.find(e => e.kind === 'tool' && e !== tool); assert.equal(late.status, 'running');
  await fs.appendFile(file, jsonl([{ type: 'response_item', payload: { type: 'function_call_output', call_id: 'late', output: 'late output' } }]));
  await parser.loadSession('codex-main'); assert.equal(late.status, 'success'); assert.equal(late.fields.output, 'late output');
});

test('parses C4 heredoc direct and Codex wrapped command; void stays internal', () => {
  const command = "node /fixture/c4-send.js openmax target <<'EOF'\nfull\nmessage\nEOF";
  assert.equal(parseOutbound(command).fields.body, 'full\nmessage');
  assert.equal(parseOutbound(`await tools.exec_command({cmd: ${JSON.stringify(command)}})`).target, 'target');
  assert.equal(parseOutbound(command.replace('openmax', 'void')).kind, 'internal');
  assert.equal(parseInbound('Meanwhile, Heartbeat: check').system, true);
});

test('deferred large records expand into complete structured text and binary download descriptors', async t => {
  const options = await fixture(t);
  const file = path.join(options.projectDir, 'huge-session.jsonl');
  const document = Buffer.alloc(5 * 1024 * 1024, 65);
  const record = { type: 'user', message: { content: [
    { type: 'text', text: 'document caption' },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: document.toString('base64') } }
  ] } };
  await fs.writeFile(file, jsonl([record]));
  const parser = new ClaudeHistory(options);
  const loaded = await parser.loadSession('huge-session');
  assert.equal(loaded.entries[0].deferred, true);
  const expanded = await parser.expandEntry('huge-session', 'o:0');
  assert.equal(expanded.fields.body.message.content[0].text, 'document caption');
  assert.equal(expanded.fields.body.message.content[1].source.data, '[Binary attachment available separately]');
  assert.deepEqual(expanded.binaries.attachment_1.data, document);
});

test('transcript symlink replacement after listing never reads the foreign target', async t => {
  const options = await fixture(t);
  const file = path.join(options.projectDir, 'session-1.jsonl');
  await fs.writeFile(file, '{}\n');
  const parser = new ClaudeHistory(options); await parser.listSessions();
  await fs.rename(file, file + '.old');
  const outside = path.join(options.root, 'foreign.jsonl'); await fs.writeFile(outside, '{"secret":"foreign"}\n');
  await fs.symlink(outside, file);
  await assert.rejects(parser.loadSession('session-1'), /transcript_path_changed/);
});

test('index growth during snapshot is picked up on next update without duplicating lines', async t => {
  const { root } = await fixture(t); const file = path.join(root, 'growing');
  const line = 'x'.repeat(1024) + '\n'; await fs.writeFile(file, line.repeat(3000));
  const index = new SessionLogIndex(file);
  const work = index.update(); await fs.appendFile(file, 'new\n'); await work; await index.update();
  assert.equal(index.lines.length, 3001);
  assert.equal(await index.readLine(index.lines.at(-1)), 'new');
});

test('repeated session lists do not evict the selected index, including more than eight files', async t => {
  const options = await fixture(t);
  for (let i = 0; i < 10; i++) await fs.writeFile(path.join(options.projectDir, `session-${i}.jsonl`), '{}\n');
  const parser = new ClaudeHistory(options);
  const first = await parser.loadSession('session-0');
  await parser.listSessions(); await parser.listSessions();
  const second = await parser.loadSession('session-0'); assert.equal(second.index, first.index);
});

test('negative control: removing queued-command handling loses the busy inbound fixture', async t => {
  const options = await fixture(t);
  const file = path.join(options.projectDir, 'session-1.jsonl');
  await fs.copyFile(new URL('./fixtures/history/claude.jsonl', import.meta.url), file);
  const sourceUrl = new URL('../src/lib/history/claude-history.js', import.meta.url);
  let source = await fs.readFile(sourceUrl, 'utf8');
  source = source.replace("record.attachment?.type === 'queued_command'", "record.attachment?.type === 'disabled_queued_command'");
  source = source.replace(/from '([.][^']+)'/g, (_, relative) => `from '${new URL(relative, sourceUrl).href}'`);
  const { ClaudeHistory: Mutant } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const live = (await new ClaudeHistory(options).loadSession('session-1')).entries;
  const mutant = (await new Mutant(options).loadSession('session-1')).entries;
  const hasBusy = entries => entries.some(e => e.kind === 'inbound' && typeof e.fields.body === 'string' && e.fields.body.includes('message while busy'));
  assert.equal(hasBusy(live), true);
  assert.equal(hasBusy(mutant), false, 'acceptance must reject parser without queued-command branch');
});

test('raw internal and oversized views cannot reveal reasoning blocks', async t => {
  const options = await fixture(t);
  const record = { type: 'assistant', isMeta: true, message: { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING_SENTINEL' }] } };
  const large = { ...record, padding: 'x'.repeat(5 * 1024 * 1024) };
  await fs.writeFile(path.join(options.projectDir, 'reasoning.jsonl'), jsonl([record, large]));
  const parser = new ClaudeHistory(options);
  const { entries } = await parser.loadSession('reasoning');
  assert.ok(!JSON.stringify(entries).includes('PRIVATE_REASONING_SENTINEL'));
  const expanded = await parser.expandEntry('reasoning', entries[1].id);
  assert.ok(!JSON.stringify(expanded).includes('PRIVATE_REASONING_SENTINEL'));
});

test('metadata and parser read appended bytes with constant descriptor counts', async t => {
  const options = await fixture(t);
  const file = path.join(options.projectDir, 'session-perf.jsonl');
  const first = { type: 'user', timestamp: '2026-09-27T01:00:00Z', message: { content: 'First title' } };
  const ordinary = { type: 'assistant', timestamp: '2026-09-27T01:00:01Z', message: { content: 'x'.repeat(1000) } };
  await fs.writeFile(file, jsonl([first]) + jsonl([ordinary]).repeat(2000));
  const metrics = { opens: 0, bytes: 0 };
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('.jsonl')) {
      metrics.opens++;
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { const result = await read(...readArgs); metrics.bytes += result.bytesRead; return result; };
    }
    return handle;
  });
  const parser = new ClaudeHistory(options);
  await parser.listSessions();
  assert.equal(metrics.opens, 1, 'cold metadata opens once, not per line');
  assert.equal(metrics.bytes, (await fs.stat(file)).size);
  const initial = await parser.loadSession('session-perf');
  metrics.opens = 0; metrics.bytes = 0;
  const added = jsonl([ordinary, { type: 'ai-title', title: 'Updated title' }]);
  await fs.appendFile(file, added);
  const sessions = await parser.listSessions();
  const updated = await parser.loadSession('session-perf');
  assert.equal(updated.index, initial.index);
  assert.equal(sessions.sessions[0].title, 'Updated title');
  assert.equal(metrics.opens, 3, 'one metadata scan, one index scan, one batched parse');
  assert.equal(metrics.bytes, 3 * Buffer.byteLength(added), 'only appended bytes are read');
  metrics.opens = 0; metrics.bytes = 0;
  await parser.listSessions(); await parser.loadSession('session-perf');
  assert.equal(metrics.bytes, 0);
  assert.equal(metrics.opens, 1, 'unchanged parser only validates current file identity');
});

test('metadata cursor preserves incomplete tail and resets title on truncate or replacement', async t => {
  const options = await fixture(t); const file = path.join(options.projectDir, 'session-meta.jsonl');
  await fs.writeFile(file, jsonl([{ type: 'user', timestamp: '2026-09-27T00:00:00Z', message: { content: 'Original' } }]) + '{"type":"ai-title","title":"Pending');
  const parser = new ClaudeHistory(options);
  assert.equal((await parser.listSessions()).sessions[0].title, 'Original');
  await fs.appendFile(file, ' title"}\n');
  assert.equal((await parser.listSessions()).sessions[0].title, 'Pending title');
  await fs.writeFile(file, jsonl([{ type: 'ai-title', title: 'Short' }]));
  assert.equal((await parser.listSessions()).sessions[0].title, 'Short');
  await fs.rename(file, file + '.old');
  await fs.writeFile(file, jsonl([{ type: 'ai-title', title: 'Replacement' }]));
  assert.equal((await parser.listSessions()).sessions[0].title, 'Replacement');
});
