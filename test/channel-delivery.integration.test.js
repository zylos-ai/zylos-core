import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

const execute = promisify(execFile);
const filename = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '..');
const pm2Cli = path.join(packageRoot, 'node_modules/pm2/bin/pm2');

async function pm2(args, env) {
  return execute(process.execPath, [pm2Cli, ...args], { env, timeout: 10000, maxBuffer: 1024 * 1024 });
}

async function fixture(mode, root) {
  const sandbox = createChatSandbox(null, { existingRoot: root });
  console.log('Channel delivery child isolation:', JSON.stringify(sandbox.assertIsolation({ env: process.env })));
  const { paths } = sandbox;
  const skillsDir = path.join(paths.zylos, '.claude/skills');
  const channelDir = path.join(skillsDir, 'example');
  fs.mkdirSync(path.join(channelDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(paths.zylos, '.zylos'));
  fs.writeFileSync(path.join(paths.zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: mode }));
  fs.symlinkSync(path.join(packageRoot, 'skills/comm-bridge'), path.join(skillsDir, 'comm-bridge'));
  fs.writeFileSync(path.join(channelDir, 'SKILL.md'), '---\nname: example\ntype: communication\nlifecycle:\n  service:\n    name: example-service\n---\n');
  const sendScript = path.join(channelDir, 'scripts/send.js');
  fs.writeFileSync(sendScript, 'process.exit(1);');
  const serviceScript = path.join(paths.zylos, 'service.mjs');
  fs.writeFileSync(serviceScript, "setInterval(() => {}, 1000); process.on('SIGINT', () => process.exit(0));\n");
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // PM2 needs ps for process-tree shutdown and getconf for process metrics.
  for (const [name, target] of [['node', process.execPath], ['pm2', pm2Cli], ['zylos', path.join(packageRoot, 'cli/zylos.js')],
    ['ps', '/usr/bin/ps'], ['getconf', '/usr/bin/getconf']]) {
    fs.symlinkSync(target, path.join(bin, name));
  }
  process.env.PATH = bin;
  assert.deepEqual(fs.readdirSync(bin).sort(), ['getconf', 'node', 'pm2', 'ps', 'zylos']);
  // The private PATH contains no tmux or runtime executable. Runtime state reads
  // can report missing state but cannot connect to any existing tmux server.
  const c4 = await import('../skills/comm-bridge/scripts/c4-db.js');
  const { sendExternal } = await import('../skills/comm-bridge/scripts/c4-send-external.js');
  const { C4Reader } = await import('../skills/dashboard/src/lib/c4-reader.js');
  const { ChatHistory } = await import('../skills/dashboard/src/lib/chat/history.js');
  const { Store } = await import('../skills/dashboard/src/lib/store.js');
  const { PM2Collector } = await import('../skills/dashboard/src/lib/collectors/pm2-collector.js');
  const { loadCoreModule } = await import('../skills/dashboard/src/lib/core-modules.js');
  const { installedChannels, CHANNEL_RESTART_WINDOW_MS } = await import('../skills/dashboard/src/lib/workbench/attention.js');
  const { createGroupSnapshot } = await import('../skills/dashboard/src/lib/workbench/group-snapshot.js');
  const { groupAttention } = await import('../skills/dashboard/public/js/wb/group-data.js');
  sandbox.assertIsolation({ env: process.env });
  c4.getDb();
  assert.equal(c4.getDb().name, paths.c4Db);
  const reader = new C4Reader(paths.zylos);
  const store = new Store(paths.dashboardDb);
  sandbox.addCleanup(() => c4.close());
  sandbox.addCleanup(() => reader.close());
  sandbox.addCleanup(() => store.close());
  sandbox.addCleanup(() => pm2(['kill'], process.env));
  const collector = new PM2Collector(store, { runtime: 'claude' });
  const snapshot = createGroupSnapshot({ zylosDir: paths.zylos, store, c4Reader: reader,
    readPm2: () => collector.getLatestPM2Data() });
  const read = async (at = Date.now()) => {
    const value = await snapshot.getSnapshot(at, { fresh: true });
    assert.equal(value.mode, mode);
    assert.equal(value.sources.c4.ok, true, JSON.stringify(value.sources.c4));
    assert.equal(value.sources.q.ok, true, JSON.stringify(value.sources.q));
    return { value, problems: groupAttention(value.instance, value.counts, value.rows).problems };
  };
  const sample = async () => {
    await collector.collect();
    const data = collector.getLatestPM2Data();
    assert.ok(data && data.processes.length === 1, 'the private daemon owns exactly the fixture service');
    assert.equal(data.processes[0].name, 'example-service');
    assert.equal(data.processes[0].pm2_env.PM2_HOME, paths.pm2);
    console.log('Private PM2 sample:', JSON.stringify({ status: data.processes[0].pm2_env.status,
      restarts: data.processes[0].pm2_env.restart_time, pid: data.processes[0].pid }));
    snapshot.channelRestartCounter.update(data);
    return data;
  };
  try {
    assert.deepEqual(await installedChannels(paths.zylos, loadCoreModule), [{ channel: 'example', service: 'example-service' }]);
    await pm2(['start', serviceScript, '--name', 'example-service', '--interpreter', process.execPath, '--no-autorestart'], process.env);
    await sample();
    assert.equal((await read()).value.instance.services.online, 1);
    for (let count = 1; count <= 3; count++) {
      await assert.rejects(sendExternal({ channel: 'example', endpoint: 'fixture' }, `failure ${count}`,
        { api: c4, skillsDir }), { code: 'SEND_FAILED', exitCode: 1 });
      assert.deepEqual(reader.getChannelSendState('example'), { lastSendFailed: true, consecutiveFailures: count });
      const state = await read();
      assert.deepEqual(state.problems.filter(item => item.kind === 'channel_send_failed'),
        [{ kind: 'channel_send_failed', channel: 'example', count }]);
    }
    fs.writeFileSync(sendScript, 'process.exit(0);');
    await sendExternal({ channel: 'example', endpoint: 'fixture' }, 'success', { api: c4, skillsDir });
    assert.deepEqual(c4.getDb().prepare("SELECT status,delivery_action FROM conversations WHERE direction='out' ORDER BY id").all(), [
      ...Array.from({ length: 3 }, () => ({ status: 'failed', delivery_action: 'send_failed' })),
      { status: 'delivered', delivery_action: null },
    ]);
    assert.deepEqual(reader.getChannelSendState('example'), { lastSendFailed: false, consecutiveFailures: 0 });
    assert.equal((await read()).problems.some(item => item.kind === 'channel_send_failed'), false);
    const history = new ChatHistory({ c4Reader: reader });
    const conversation = history.list({ tab: 'external' }).items.find(item => item.channel === 'example');
    assert.ok(conversation);
    const messages = history.messages(conversation.id, { tab: 'external' }).items;
    assert.equal(messages.filter(item => item.content.startsWith('failure ')).length, 3);
    const failureIds = c4.getDb().prepare("SELECT id FROM conversations WHERE direction='out' AND status='failed'").all().map(row => row.id);
    const statuses = history.status(conversation.id, { tab: 'external', ids: failureIds }).items;
    assert.ok(statuses.every(item => item.deliveryState === 'pending_reconciliation'));
    console.log('Failed outbound Chat history: readable body; status pending_reconciliation; external history omits owned delivery badges');
    const argMax = Number((await execute('/usr/bin/getconf', ['ARG_MAX'], { timeout: 5000 })).stdout.trim());
    assert.ok(Number.isSafeInteger(argMax) && argMax > 0);
    await assert.rejects(sendExternal({ channel: 'example', endpoint: 'fixture' }, 'x'.repeat(argMax + 1),
      { api: c4, skillsDir }), { code: 'COMPONENT_SPAWN_FAILED' });
    assert.equal(c4.getDb().prepare("SELECT delivery_action FROM conversations WHERE direction='out' ORDER BY id DESC LIMIT 1").get().delivery_action, 'spawn_failed');
    assert.deepEqual((await read()).problems.filter(item => item.kind === 'channel_send_failed'),
      [{ kind: 'channel_send_failed', channel: 'example', count: 1 }]);
    await sendExternal({ channel: 'example', endpoint: 'fixture' }, 'recovered', { api: c4, skillsDir });
    assert.equal((await read()).problems.some(item => item.kind === 'channel_send_failed'), false);
    for (let count = 1; count <= 3; count++) {
      await pm2(['restart', 'example-service'], process.env);
      await sample();
      const state = await read();
      const restarts = state.problems.filter(item => item.kind === 'channel_restarting');
      assert.deepEqual(restarts, count < 3 ? [] : [{ kind: 'channel_restarting', channel: 'example', count: 3 }]);
      assert.equal(state.value.instance.services.channels[0].restarts10m, count);
    }
    const expired = await read(Date.now() + CHANNEL_RESTART_WINDOW_MS + 1);
    assert.equal(expired.value.instance.services.channels[0].restarts10m, 0);
    assert.equal(expired.problems.some(item => item.kind === 'channel_restarting'), false);
    await pm2(['stop', 'example-service'], process.env);
    await sample();
    const stopped = await read();
    assert.equal(stopped.value.instance.services.online, 0);
    assert.equal(stopped.value.instance.services.total, 1);
    assert.equal(stopped.value.instance.services.channels[0].status, 'stopped');
    console.log(`Channel delivery ${mode}: failed sends, recovery, restart threshold, rolling expiry and service totals verified`);
  } catch (error) {
    for (const dir of [paths.pm2, path.join(paths.pm2, 'logs')]) {
      for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.log'))) {
        console.error(name, fs.readFileSync(path.join(dir, name), 'utf8').slice(-12000));
      }
    }
    throw error;
  } finally { await sandbox.close(); }
}

if (process.argv[2] === '--fixture') {
  await fixture(process.argv[3], process.argv[4]);
} else {
  for (const mode of ['single', 'multi']) {
    // Real component process -> C4 writer/reader -> discovered channel -> group
    // snapshot -> attention. PM2 is a real daemon under this case's PM2_HOME;
    // its only process is a fixture timer. No network channel or runtime exists.
    // Gate + official runner required; both parent and child prove HOME, DBs,
    // PM2_HOME, short TMPDIR and private tmux socket before resource creation.
    // Run for send/discovery/restart-contract changes; unrelated UI-only edits
    // may skip. All commands have deadlines; child finally and parent fallback kill only
    // this daemon before the harness removes its own sandbox, including timeout.
    test(`${mode} real channel failures and private PM2 reach attention and recover`,
      { skip: !chatEnabled(), timeout: 60000 }, async t => {
        const sandbox = createChatSandbox(t);
        sandbox.addCleanup(async () => {
          if (fs.existsSync(path.join(sandbox.paths.pm2, 'pm2.pid'))) await pm2(['kill'], sandbox.env);
        });
        await sandbox.runCase(async () => {
          const child = sandbox.startChild(process.execPath, [filename, '--fixture', mode, sandbox.root], {
            env: { ZYLOS_PACKAGE_ROOT: packageRoot }, timeoutMs: 50000,
          });
          child.stdin.end();
          const result = await child.completion;
          assert.equal(result.error, undefined);
          assert.equal(result.outputExceeded, false);
          assert.equal(result.signal, null, result.stderr);
          assert.equal(result.code, 0, result.stdout + result.stderr);
          console.log(result.stdout.trim());
        }, { timeoutMs: 55000 });
      });
  }
}
