import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HistoryService } from '../src/lib/history/history-service.js';
import { ClaudeHistory } from '../src/lib/history/claude-history.js';
import { CodexHistory } from '../src/lib/history/codex-history.js';
import { claudeProjectSlug } from '../src/lib/claude-project-path.js';
import { createRedactor } from '../src/lib/redaction/engine.js';
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const params = value => new URLSearchParams(value);
async function snapshot(files) {
  return Promise.all(files.map(async file => ({ file, mtime: (await fs.stat(file)).mtimeMs, hash: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') })));
}
async function complete(service, session, entry, field) {
  let offset = 0, text = '';
  do {
    const result = await service.content(params({ session, entry, field, offset: String(offset) }));
    assert.ok(Buffer.byteLength(result.text) <= 256 * 1024);
    text += result.text; offset = result.next;
  } while (offset !== null);
  return text;
}

test('read-only Claude files recover full C4 and persisted outputs through redacted paginated API', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'history-http-')));
  const zylosDir = path.join(root, 'zylos');
  await fs.mkdir(zylosDir);
  const project = path.join(root, '.claude', 'projects', claudeProjectSlug(zylosDir));
  const c4 = path.join(zylosDir, 'comm-bridge', 'attachments', 'conv-1', 'message.txt');
  const tool = path.join(project, 'session', 'tool-results', 'output.txt');
  await fs.mkdir(path.dirname(c4), { recursive: true });
  await fs.mkdir(path.dirname(tool), { recursive: true });
  const secret = 'zylos_st_fixture_private_value';
  const message = '正文😀\n'.repeat(40000) + secret;
  const output = 'output line\n'.repeat(70000) + secret;
  await fs.writeFile(c4, message); await fs.writeFile(tool, output);
  const log = path.join(project, 'session.jsonl');
  await fs.writeFile(log, jsonl([
    { type: 'user', message: { content: `[TG DM] preview\ncomplete message file: ${c4}` } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'printf fixture', API_KEY: secret } }] } },
    { type: 'user', toolUseResult: { persistedOutputPath: tool }, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'truncated preview' }] } },
    { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('raster fixture').toString('base64') } }] } },
  ]));
  const files = [log, c4, tool];
  const before = await snapshot(files);
  const directories = [project, path.dirname(c4), path.dirname(tool)];
  for (const file of files) await fs.chmod(file, 0o444);
  for (const dir of directories) await fs.chmod(dir, 0o555);
  t.after(async () => { for (const dir of directories) await fs.chmod(dir, 0o755); await fs.rm(root, { recursive: true, force: true }); });
  const redactor = createRedactor({ zylosDir });
  const service = new HistoryService({ parser: new ClaudeHistory({ zylosDir, homeDir: root }), redactor });
  try {
    const listing = await service.sessions(); assert.equal(listing.sessions.length, 1);
    const page = await service.entries(params({ session: 'session' }));
    const inbound = page.entries.find(entry => entry.fields.body);
    const call = page.entries.find(entry => entry.kind === 'tool');
    assert.equal(await complete(service, 'session', inbound.id, 'body'), (await redactor.redact(message)).text);
    assert.equal(await complete(service, 'session', call.id, 'output'), (await redactor.redact(output)).text);
    assert.equal(JSON.parse(await complete(service, 'session', call.id, 'input')).command, 'printf fixture');
    const image = page.entries.find(entry => entry.fields.attachment);
    assert.equal((await service.content(params({ session: 'session', entry: image.id, field: 'attachment' }))).binary.data.toString(), 'raster fixture');
    assert.equal((await service.search(params({ session: 'session', q: 'fixture_private_value' }))).matches.length, 0);
    assert.ok((await service.search(params({ session: 'session', q: 'output line' }))).matches.some(match => match.entry === call.id));
    assert.deepEqual(await snapshot(files), before);
  } finally { await service.close(); }
});

test('Codex full aggregated command output reaches API beyond the model preview', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'history-codex-http-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.codex', 'sessions', '2026', '09', '27');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'rollout-fixture.jsonl');
  const full = 'complete command output\n'.repeat(20000) + 'zylos_st_fixture_secret';
  await fs.writeFile(file, jsonl([
    { type: 'session_meta', payload: { id: 'thread', source: 'cli' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'exec_command', arguments: '{"cmd":"fixture"}' } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn', item: { type: 'CommandExecution', command: 'fixture', aggregated_output: full, exit_code: 0 } } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'Warning: truncated output' } },
  ]));
  const row = { session_id: 'thread', transcript_path: file };
  const parser = new CodexHistory({ homeDir: root, store: { listCodexRolloutPaths: () => [row], latestCodexRolloutPath: () => row } });
  const service = new HistoryService({ config: { runtime: 'codex' }, parser });
  try {
    const page = await service.entries(params({ session: 'thread' }));
    const tool = page.entries.find(entry => entry.kind === 'tool');
    assert.equal(await complete(service, 'thread', tool.id, 'output'), (await service.redactor.redact(full)).text);
    assert.match(await complete(service, 'thread', tool.id, 'modelOutput'), /truncated/);
  } finally { await service.close(); }
});
