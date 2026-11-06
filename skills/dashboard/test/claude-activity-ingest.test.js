import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { desiredClaudeHooks } from '../../../cli/lib/sync-runtime-hooks.js';
import { Store } from '../src/lib/store.js';
import { CoreLogImporter } from '../src/lib/core-log-importer.js';
import { UsageTranscripts } from '../src/lib/collectors/usage-transcripts.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { activityBuckets } from '../src/lib/workbench/activity-buckets.js';

// Isolated integration: generated command -> native-shaped stdin -> Core event log
// -> unmodified Dashboard importer/collector/activity buckets. Run for hook wiring
// or event attribution changes; skip UI-only changes. No real Claude/model request:
// transcript usage is a fixture. Owned HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR and
// private tmux directory; no tmux/PM2/network commands. Children have 5s timeout,
// all handles close before owned files are removed, including assertion failures.
test('registered Claude hooks feed grouped transcript usage and child activity into Dashboard', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ingest-'));
  let store, importer;
  t.after(async () => { await importer?.stop(); store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, 'home'), zylosDir = path.join(root, 'instance');
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylosDir, PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'),
    ZYLOS_SESSION_GROUP: 'chat:claude', ZYLOS_RUN_ID: 'run-claude', ZYLOS_MODEL_CONFIG: '{"runtime":"claude"}' };
  delete env.TMUX; delete env.CLAUDE_SESSION_ID; delete env.CODEX_SESSION_ID;
  delete env.HOOK_ACTIVITY_DISABLE_MAIN;
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep));
  }
  const skills = path.join(zylosDir, '.claude', 'skills');
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../../', import.meta.url)), skills, 'dir');
  const transcript = path.join(home, 'claude-session.jsonl');
  const sessionId = 'session-claude', now = new Date().toISOString();
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', uuid: 'line-1', requestId: 'request-1',
    sessionId, timestamp: now, message: { id: 'message-1', model: 'claude-fixture', content: [{ type: 'text', text: 'fixture answer' }],
      usage: { input_tokens: 100, output_tokens: 20 } } }) + '\n');
  const db = path.join(zylosDir, 'components/dashboard/dashboard.db');
  assert.ok(db.startsWith(root + path.sep));
  store = new Store(db);
  importer = new CoreLogImporter({ store, zylosDir });
  const desired = desiredClaudeHooks({ zylosDir, subagentHooksSupported: true });
  function hook(event, extra = {}) {
    const command = desired[event][0].hooks.find(item => item.command.endsWith('/hook-activity.js')).command;
    const result = spawnSync('/bin/sh', ['-c', command], { env,
      input: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: transcript, ...extra }),
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'activity hook must not inject context');
  }
  hook('SessionStart', { source: 'startup' });
  await importer.poll();
  const starts = store.queryEvents({ types: ['session_start'], sessionGroup: 'chat:claude' });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].runtime, 'claude'); assert.equal(starts[0].source, 'core-log');
  assert.equal(starts[0].run_id, 'run-claude');
  assert.equal(starts[0].metadata.transcript_path, transcript);
  assert.ok(path.isAbsolute(starts[0].metadata.transcript_path));
  const config = { zylosDir, homeDir: home, runtimeModelPrices: {
    claude: { 'claude-fixture': { input: 2, output: 8, cacheRead: 0, cacheCreation: 0 } } } };
  const rows = [{ sessionGroup: 'chat:claude', live: { runId: 'run-claude' } }];
  const transcripts = new UsageTranscripts(store, config, { getSnapshot: async () => ({ listKnown: true, rows }) });
  const collector = new ConversationCollector(store, config, { transcripts });
  await collector.collect();
  const usage = store.queryMetrics({ name: 'usage_event' });
  assert.equal(usage.length, 1); assert.equal(usage[0].session_group, 'chat:claude');
  assert.equal(usage[0].dimensions.output, 20);
  assert.ok(usage[0].dimensions.cost > 0);
  await collector.collect();
  assert.equal(store.queryMetrics({ name: 'usage_event' }).length, 1);
  hook('SubagentStart', { agent_id: 'child-1', agent_type: 'Explore' });
  await importer.poll();
  const activity = at => activityBuckets({ range: '60m', now: at, rows, events: store.queryEvents() });
  assert.equal(activity(Date.now() + 1000).groups['chat:claude'].cells.at(-1), 'busy');
  hook('SubagentStop', { agent_id: 'child-1', agent_type: 'Explore', agent_transcript_path: path.join(home, 'child.jsonl') });
  await importer.poll();
  const children = store.queryEvents({ types: ['subagent_start', 'subagent_stop'] });
  assert.deepEqual(children.map(row => row.event_type), ['subagent_start', 'subagent_stop']);
  assert.ok(children.every(row => row.metadata.agent_id === 'child-1'));
  assert.equal(activity(Date.now() + 120000).groups['chat:claude'].cells.at(-1), 'idle');
});
