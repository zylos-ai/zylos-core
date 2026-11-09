import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChatSandbox } from '../../skills/dashboard/test/helpers/chat-integration-harness.js';
import Database from '../../skills/comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import { runtimeTools } from './group-deletion-runtime.js';
import { SupervisorScenes } from '../../skills/activity-monitor/scripts/supervisor-scenes.js';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixturePath = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export async function createGroupDeletionFixture(t, { group = 'telegram:room' } = {}) {
  const sandbox = createChatSandbox(t, { gateEnv: { ...process.env, ZYLOS_CHAT_INTEGRATION: '1' } });
  const root = sandbox.paths.zylos;
  const env = { ...sandbox.env, TZ: 'UTC', ZYLOS_PACKAGE_ROOT: repo,
    GROUP_DELETION_TEST_SOCKET: sandbox.paths.socket, TMUX: `${sandbox.paths.socket},0,0` };
  console.log('Group deletion isolation:', JSON.stringify(sandbox.assertIsolation({ env })));
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ session_mode: 'multi', runtime: 'claude',
    session_pool_size: 4, session_hot_ttl: 3600, upgrade_check_enabled: false, daily_upgrade_enabled: false,
    usage_monitor_enabled: false, health_check_enabled: false, usage_alert_enabled: false }));
  fs.writeFileSync(path.join(root, '.env'), 'TZ=UTC\n');
  // This executable is a terminal fixture, never a model client. Its comm name
  // enables the real process observer, and its stdin receipt proves actual I/O.
  const source = path.join(root, 'terminal.c');
  fs.writeFileSync(source, '#include <stdio.h>\n#include <stdlib.h>\nint main(void){char *line=NULL;size_t n=0;fputs("❯ ",stdout);fflush(stdout);while(getline(&line,&n,stdin)>0){FILE *f=fopen(getenv("GROUP_DELETION_RECEIPTS"),"a");if(f){fputs(line,f);fclose(f);}fputs("❯ ",stdout);fflush(stdout);}free(line);return 0;}\n');
  execFileSync('cc', [source, '-o', path.join(root, 'claude')], { env, timeout: 20_000 });
  const database = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  guardDatabase(database, schema); database.pragma('journal_mode=WAL'); database.pragma('busy_timeout=5000');
  const store = createStore(database, { validateComponent: () => true,
    readConfig: () => ({ state: 'ok', config: { session_mode: 'multi', runtime: 'claude' } }) });
  const tools = runtimeTools(env);
  sandbox.addCleanup(async () => {
    try { tools.tmux(['kill-server']); } catch {}
    const { waitForServerExit } = await import('./isolated-tmux.js');
    await waitForServerExit({ binary: 'tmux', socketPath: sandbox.paths.socket });
  });
  async function waitFor(predicate, label, timeoutMs = 12_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const result = await predicate(); if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    for (const child of sandbox.children) if (child.exitCode !== null) console.log(await child.completion);
    for (const name of ['monitor-output.txt', 'command-result.json', 'dispatcher-output.txt', 'dispatcher-diagnostics.jsonl']) {
      try { console.log(name, fs.readFileSync(path.join(root, name), 'utf8').slice(-12000)); } catch {}
    }
    assert.fail(label);
  }
  tools.startRuntime('origin', { runId: 'fixture-origin-run', sessionId: 'fixture-origin-session' });
  const monitor = sandbox.startChild(process.execPath, [fixturePath('group-deletion-monitor.js')], { env, timeoutMs: 120_000 });
  for (const stream of [monitor.stdout, monitor.stderr]) stream.on('data', bytes => fs.appendFileSync(path.join(root, 'monitor-output.txt'), bytes));
  await waitFor(() => fs.existsSync(path.join(root, 'monitor-round.json')), 'Real monitor must finish a round');
  const scenes = new SupervisorScenes({ env, connectionOptions: { socketPath: sandbox.paths.socket },
    readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state: 'idle', idleSince: Date.now() - 60_000 }), readUsage: () => 0 });
  function startDeleteChild({ group: target = group, operationId, pauseAfterFiles = false } = {}) {
    const child = sandbox.startChild(process.execPath, [fixturePath('group-deletion-command.js'), '--group', target,
      '--yes', '--json', '--actor', 'integration:owner', '--operation-id', operationId], {
      env: { ...env, GROUP_DELETION_PAUSE: pauseAfterFiles ? '1' : '0' }, timeoutMs: 30_000 });
    child.completion.then(result => { if (fs.existsSync(root)) fs.writeFileSync(path.join(root, 'command-result.json'), JSON.stringify(result)); });
    return child;
  }
  return { sandbox, env, root, zylosDir: root, homeDir: sandbox.paths.home, database, store, scenes,
    ...tools, waitFor, startDeleteChild, monitor,
    startDispatcher() {
      const child = sandbox.startChild(process.execPath, [fixturePath('group-deletion-dispatcher.js')], { env, timeoutMs: 90_000 });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => fs.appendFileSync(path.join(root, 'dispatcher-output.txt'), bytes));
      return child;
    },
    setBusy(value) { if (value) fs.writeFileSync(path.join(root, 'busy'), '1'); else fs.rmSync(path.join(root, 'busy'), { force: true }); },
    close: () => sandbox.close(),
  };
}
