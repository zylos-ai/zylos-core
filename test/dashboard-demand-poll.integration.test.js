import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChatSandbox, chatEnabled } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';

// Real production Dashboard HTTP/SSE + three real tmux groups. Run for demand
// polling/collector changes only. The official runner and sandbox prove private
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB before any service starts; the child
// and its descendants are lifecycle-bound. No live instance is contacted.
test('Dashboard observation follows browser demand with real isolated tmux', {
  skip: !chatEnabled(), timeout: 115000,
}, async t => {
  const s = createChatSandbox(t);
  await s.runCase(async () => {
    s.env.TZ = 'Asia/Singapore';
    const proof = s.assertIsolation();
    console.log('Demand acceptance readback:', JSON.stringify({ ...proof, TZ: s.env.TZ }));
    const repo = fileURLToPath(new URL('../', import.meta.url));
    fs.mkdirSync(path.join(s.paths.zylos, '.claude'));
    fs.symlinkSync(path.join(repo, 'skills'), path.join(s.paths.zylos, '.claude/skills'));
    const binary = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
    const tmux = (...args) => execFileSync(binary, ['-f', '/dev/null', '-S', s.paths.socket, ...args], { env: s.env, timeout: 3000 });
    s.addCleanup(() => { try { tmux('kill-server'); } catch {} });
    const configDir = path.join(s.paths.zylos, '.zylos'); fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi', timezone: 'Asia/Singapore' }));
    fs.mkdirSync(path.join(s.paths.zylos, 'activity-monitor'), { recursive: true });
    fs.writeFileSync(path.join(s.paths.zylos, 'activity-monitor/restart-requests.json'), '[]');
    const c4 = fixture(t, {}, s.paths.c4Db); s.addCleanup(() => { if(c4.db.open) c4.db.close(); });
    const writeStatus = (group, state) => {
      const dir = path.join(s.paths.zylos, 'activity-monitor/session-groups', group);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'current-session.json'), JSON.stringify({ runId: `run-${group}`, sessionId: `sid-${group}`, ts: Date.now(), startupControlIds: [] }));
      fs.writeFileSync(path.join(dir, 'agent-status.json'), JSON.stringify({ runId: `run-${group}`, sessionId: `sid-${group}`, state, updated_at: Date.now() }));
    };
    for (const group of ['origin', 'worker-a', 'worker-b']) {
      tmux('new-session', '-d', '-s', `zylos-group-${group}`, '-e', `ZYLOS_RUN_ID=run-${group}`, '-e', `ZYLOS_SESSION_GROUP=${group}`, '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', 'sleep', '180');
      writeStatus(group, 'idle');
    }
    let originState = 'idle';
    const statusWriter = setInterval(() => { for (const group of ['origin','worker-a','worker-b']) writeStatus(group, group === 'origin' ? originState : 'idle'); }, 1000);
    s.addCleanup(() => clearInterval(statusWriter));
    const bin = path.join(s.root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'zylos'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(repo,'cli/zylos.js')}' \"$@\"\n`, { mode: 0o700 });
    const trace = path.join(s.root, 'tmux.jsonl'); fs.writeFileSync(trace, '');
    const wrapper = path.join(bin, 'tmux');
    fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DASH_TRACE"\nexec '${binary}' "$@"\n`, { mode: 0o700 });
    const config = path.join(s.paths.zylos, 'components/dashboard/config.json');
    fs.writeFileSync(config, JSON.stringify({ port: 0, host: '127.0.0.1', auth: { enabled: true, password: 'fixture-password' }, observer: { enabled: false } }));
    const child = s.startChild(process.execPath, [path.join(repo, 'test/helpers/dashboard-demand-worker.js'), repo], {
      env: { ...s.env, ZYLOS_PACKAGE_ROOT: repo, PATH: `${bin}:${s.env.PATH}`, TMUX: `${s.paths.socket},0,0`, DASH_TRACE: trace }, timeoutMs: 110000,
    });
    let output = ''; child.stderr.on('data', chunk => { output = (output + chunk).slice(-8192); }); child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); });
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async predicate => { const end = Date.now() + 15000; while (!predicate()) { assert(Date.now() < end, `Dashboard startup timeout: ${output}`); await delay(50); } };
    await wait(() => /ACCEPTANCE_PORT=(\d+)/.test(output));
    const base = `http://127.0.0.1:${output.match(/ACCEPTANCE_PORT=(\d+)/)[1]}`;
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'fixture-password' }) });
    assert.equal(login.status, 302); const cookie = login.headers.get('set-cookie');
    const read = async route => { const response = await fetch(base + route, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200, route); return response.json(); };
    const commands = () => fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean);
    await delay(17000); // Includes production deferred startup and first system collection.
    fs.writeFileSync(trace, '');
    await delay(35000); // Exceeds the former 30-second background interval.
    assert.equal(commands().length, 0, `Unwatched tmux calls: ${JSON.stringify(commands())}`);
    t.diagnostic('Three online groups, no browser for 35 seconds: zero Dashboard tmux clients');
    const instance = await read('/api/instance'); assert(instance.session_mode);
    const fleet = await read('/api/fleet'); assert.equal(fleet.agents.find(agent => agent.self).state, 'IDLE');
    originState = 'busy'; writeStatus('origin', 'busy'); await delay(2100);
    assert.equal((await read('/api/fleet')).agents.find(agent => agent.self).state, 'BUSY', 'Fleet stays fresh without browser subscription');
    originState = 'idle'; writeStatus('origin', 'idle'); await delay(2100);
    assert.equal((await read('/api/fleet')).agents.find(agent => agent.self).state, 'IDLE');
    const health = await read('/api/health'); assert.equal(JSON.stringify(health.source ?? {}).includes('statusline'), false);
    let controller;
    s.addCleanup(() => controller?.abort());
    const open = async () => {
      controller = new AbortController();
      const response = await fetch(base + '/api/stream', { headers: { Cookie: cookie }, signal: controller.signal });
      assert.equal(response.status, 200); return response.body.getReader();
    };
    let stream = await open();
    let buffered = '', decoder = new TextDecoder();
    const untilState = async expected => {
      const deadline = Date.now() + 2900;
      while (Date.now() < deadline) {
        let timer; const result = await Promise.race([stream.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Missing SSE state ${expected}`)), Math.max(1, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
        assert(!result.done); buffered += decoder.decode(result.value, { stream: true });
        while (buffered.includes('\n\n')) { const end = buffered.indexOf('\n\n'), frame = buffered.slice(0,end); buffered = buffered.slice(end+2); if (/^event: groups$/m.test(frame)) { const counts = JSON.parse(frame.match(/^data: (.*)$/m)[1]); if (expected === 'IDLE' ? counts.running.states.idle === 3 : counts.running.states.working === 1) return; } }
      }
      assert.fail(`Missing state ${expected}`);
    };
    await untilState('IDLE'); fs.writeFileSync(trace, '');
    await delay(10000);
    const watched = commands();
    assert(watched.length >= 6 && watched.length <= 10, `Expected 3–5 shared two-command batches in 10 seconds, got ${watched.length} commands`);
    assert(watched.every(line => /list-panes/.test(line)), 'Only batched pane observations are allowed');
    const started = performance.now(); originState = 'busy'; writeStatus('origin', 'busy'); await untilState('BUSY');
    const latencyMs = performance.now() - started; assert(latencyMs < 2900);
    controller.abort(); await stream.cancel().catch(() => {}); await delay(600);
    fs.writeFileSync(trace, ''); await delay(3500); assert.equal(commands().length, 0, 'Last subscriber closes polling');
    originState = 'idle'; writeStatus('origin', 'idle'); buffered = ''; stream = await open(); await untilState('IDLE');
    controller.abort(); await stream.cancel().catch(() => {});
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'demand-acceptance.json'), JSON.stringify({ isolation: proof, instance, fleet, health, watchedCommands: watched, latencyMs }, null, 2)); }
  }, { timeoutMs: 110000 });
});
