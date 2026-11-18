import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import Database from '../skills/comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { tmuxNameForGroup } from '../cli/lib/session-group-paths.js';
import { signIn } from '../skills/dashboard/__tests__/helpers/dashboard-sign-in.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const helper = fileURLToPath(new URL('./helpers/tmux-dashboard-reads-server.js', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function until(read, predicate, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  let last;
  while (performance.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(100);
  }
  throw new Error(`Fixture condition timed out: ${JSON.stringify(last)}`);
}

// Actual Dashboard HTTP, SQLite, browser and tmux readers. Only optional external
// version HTTPS is blocked; no backend API is replaced. Runtime hooks/quota are
// synthetic local files; the three panes are unauthenticated input recorders.
// Run for bound-read, Dashboard tmux observation or delivery identity changes;
// unrelated UI/docs changes may skip this opt-in integration.
test('real Dashboard observes three groups for 10s without if-shell; real delivery retains its write guard',
  { skip: !chatEnabled(), timeout: 120000 }, async t => {
    const tmuxCommand = process.env.TEST_TMUX_BIN || 'tmux';
    const candidates = tmuxCommand.includes(path.sep) ? [path.resolve(tmuxCommand)]
      : (process.env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir, tmuxCommand));
    const tmuxBinary = candidates.find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    });
    if (!tmuxBinary) {
      if (process.env.TEST_TMUX_BIN) assert.fail('TEST_TMUX_BIN must name an executable tmux artifact');
      t.skip('tmux is not available on PATH');
      return;
    }
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { paths, env } = sandbox;
      for (const key of ['ZYLOS_CHAT_BROWSER_MODULE', 'ZYLOS_CHAT_BROWSER_BIN']) {
        assert.ok(process.env[key] && fs.existsSync(process.env[key]), `${key} must name a provisioned artifact`);
      }
      const bin = path.join(sandbox.root, 'bin'); fs.mkdirSync(bin);
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      fs.symlinkSync(path.join(repo, 'cli/zylos.js'), path.join(bin, 'zylos'));
      const traceClient = path.join(repo, 'test/helpers/tmux-dashboard-reads-client.js');
      fs.copyFileSync(traceClient, path.join(bin, 'tmux'));
      fs.chmodSync(path.join(bin, 'tmux'), 0o755);
      const trace = path.join(sandbox.root, 'tmux.jsonl'); fs.writeFileSync(trace, '');
      Object.assign(env, { PATH: `${bin}:/usr/bin:/bin`, TZ: 'Asia/Singapore',
        ZYLOS_PACKAGE_ROOT: repo, TEST_REAL_TMUX: tmuxBinary,
        TEST_PRIVATE_SOCKET: paths.socket, TEST_TMUX_TRACE: trace,
        TMUX: `${paths.socket},0,0` });
      const tmux = (...args) => execFileSync(env.TEST_REAL_TMUX, ['-u', '-S', paths.socket, ...args],
        { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      sandbox.addCleanup(() => { try { tmux('kill-server'); } catch {} });
      fs.mkdirSync(path.join(paths.zylos, '.zylos'));
      fs.writeFileSync(path.join(paths.zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
      fs.writeFileSync(path.join(paths.zylos, '.env'), 'TZ=Asia/Singapore\n');
      fs.mkdirSync(path.join(paths.zylos, '.claude/skills'), { recursive: true });
      fs.symlinkSync(path.join(repo, 'skills/comm-bridge'), path.join(paths.zylos, '.claude/skills/comm-bridge'));
      fs.writeFileSync(path.join(paths.zylos, 'components/dashboard/config.json'), JSON.stringify({ host: '127.0.0.1', auth: { password: 'tmux-reads-password' }, observer: { enabled: false } }));
      const c4 = sandbox.openDatabase(paths.c4Db, filename => new Database(filename));
      guardDatabase(c4, schema);
      const groups = ['origin', 'dashboard:alpha', 'dashboard:beta'];
      const update = () => {
        for (const [index, group] of groups.entries()) {
          const dir = path.join(paths.zylos, 'activity-monitor/session-groups', group);
          fs.mkdirSync(dir, { recursive: true });
          const now = Date.now(), runId = `fixture-run-${index}`, sessionId = `fixture-session-${index}`;
          for (const [name, value] of Object.entries({
            'current-session.json': { runId, sessionId, ts: now, startupControlIds: [] },
            'agent-status.json': { runId, sessionId, state: 'idle', idle_seconds: 1 },
            'statusline.json': { session_id: sessionId, zylos: { v: 1, runId, capturedAt: now },
              model: { id: 'claude-sonnet-4' }, context_window: { used_percentage: 21 + index, context_window_size: 200000 },
              rate_limits: { seven_day: { used_percentage: 37, resets_at: new Date(now + 86400000).toISOString() } } },
          })) {
            fs.writeFileSync(path.join(dir, `${name}.next`), JSON.stringify(value));
            fs.renameSync(path.join(dir, `${name}.next`), path.join(dir, name));
          }
        }
      };
      update();
      const timer = setInterval(update, 1000); sandbox.addCleanup(() => clearInterval(timer));
      for (const [index, group] of groups.entries()) {
        const input = path.join(sandbox.root, `input-${index}`);
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', tmuxNameForGroup(group),
          '-e', `ZYLOS_RUN_ID=fixture-run-${index}`, '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',
          '-e', `ZYLOS_SESSION_GROUP=${group}`, `stty -echo -icanon min 1 time 0; exec cat > ${quote(input)}`);
      }
      assert.deepEqual(tmux('list-sessions', '-F', '#{session_name}').split('\n').sort(), groups.map(tmuxNameForGroup).sort());
      sandbox.assertIsolation();
      console.log('Dashboard tmux acceptance targets:', JSON.stringify({ ...sandbox.assertIsolation(), groups, version: tmux('-V') }));
      const child = sandbox.startChild(process.execPath, [helper], { timeoutMs: 110000, maxOutputBytes: 262144 });
      let output = '', stderr = '';
      child.stdout.on('data', data => { output = (output + data).slice(-32768); });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-32768); });
      const base = await until(() => output.match(/DASHBOARD_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1]
        ?? (child.exitCode !== null ? `EXIT ${child.exitCode} ${stderr}` : ''), value => value.startsWith('http://'));
      const cookie = await signIn(base, 'tmux-reads-password');
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      // Keep Chromium inside the official runner's inherited data-size limit.
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, env,
        headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
          '--disable-component-update', '--no-first-run', '--renderer-process-limit=1',
          '--disable-gpu', '--no-zygote', '--single-process',
          '--js-flags=--max-old-space-size=256'] });
      sandbox.addCleanup(() => browser.close());
      const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: 'en-GB' });
      await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: cookie.split('=')[1], domain: '127.0.0.1', path: '/', secure: true }]);
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => { if (pageErrors.length < 10) pageErrors.push(error.message); });
      page.on('console', message => { if (message.type() === 'error' && pageErrors.length < 10) pageErrors.push(message.text()); });
      page.on('response', response => { if (response.status() >= 400 && pageErrors.length < 10) pageErrors.push(`${response.status()} ${response.url()}`); });
      page.on('requestfailed', request => { if (pageErrors.length < 10) pageErrors.push(`${request.failure()?.errorText} ${request.url()}`); });
      await page.route(/^https:\/\//, route => route.abort());
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.locator('.wb-row[data-group="origin"]').waitFor({ timeout: 15000 });
      try { await page.locator('#wb-tech-btn').click({ timeout: 10000 }); }
      catch (error) { throw new Error(`${error.message}; URL: ${page.url()}; page errors: ${JSON.stringify(pageErrors)}; server: ${stderr}; body: ${(await page.locator('body').innerText()).slice(0, 3000)}`); }
      try { await page.locator('.wb-row[data-group="origin"] .wb-context').waitFor({ timeout: 15000 }); }
      catch (error) { throw new Error(`${error.message}; page errors: ${JSON.stringify(pageErrors)}; server: ${stderr}; body: ${(await page.locator('body').innerText()).slice(0, 3000)}`); }
      const readStart = Date.now();
      const request = async route => {
        const response = await fetch(base + route, { headers: { cookie } });
        assert.equal(response.status, 200, `${route}: ${stderr}`);
        return response.json();
      };
      const verify = async () => {
        const running = await request('/api/groups/running');
        assert.equal(running.rows.length, 3, JSON.stringify(running));
        for (const [index, group] of groups.entries()) {
          const row = running.rows.find(row => row.id === group);
          assert.ok(row, group);
          assert.equal(row.state.kind, 'idle', JSON.stringify(row.state));
          const detail = await request(`/api/groups/${encodeURIComponent(group)}?include=`);
          assert.equal(detail.contextPct, 21 + index, JSON.stringify(detail));
          assert.equal(await page.locator(`.wb-row[data-group="${group}"] .wb-context`).textContent(), String(21 + index));
          assert.match(await page.locator(`.wb-row[data-group="${group}"] .wb-state`).innerText(), /idle/i);
        }
        assert.match(await page.locator('#wb-instance .wb-account').first().innerText(), /63%/);
      };
      await verify();
      while (Date.now() - readStart < 10000) { await delay(2000); await verify(); }
      const readEnd = Date.now();
      const readTrace = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
        .filter(row => row.at >= readStart && row.at <= readEnd);
      let readRounds = 0, lastRoundAt = -Infinity;
      for (const row of readTrace) {
        if (row.argv.includes('show-environment') && row.at - lastRoundAt >= 2000) {
          readRounds++;
          lastRoundAt = row.at;
        }
      }
      assert.ok(readRounds >= 3, `Expected at least three time-separated tmux environment read rounds, got ${readRounds}`);
      assert.equal(readTrace.filter(row => row.argv.includes('if-shell')).length, 0);
      assert.ok(readTrace.some(row => row.argv.includes('show-environment')));
      if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) {
        const evidence = path.resolve(process.env.ZYLOS_CHAT_EVIDENCE_DIR);
        assert.ok(!evidence.startsWith(repo) && !evidence.startsWith(sandbox.root));
        fs.mkdirSync(evidence, { recursive: true });
        const version = tmux('-V').replaceAll(/[^a-zA-Z0-9.]/g, '-');
        await page.screenshot({ path: path.join(evidence, `dashboard-reads-${version}.png`), fullPage: true });
        fs.writeFileSync(path.join(evidence, `dashboard-reads-${version}.json`), JSON.stringify({ readStart,
          readEnd, readRounds, groups, trace: readTrace }, null, 2));
      }
      const beforeWrite = fs.statSync(trace).size;
      const delivery = sandbox.startChild(process.execPath, [helper, '--deliver'], { timeoutMs: 15000 });
      const result = await delivery.completion;
      assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /DELIVERED/);
      assert.equal(await until(() => fs.readFileSync(path.join(sandbox.root, 'input-0'), 'utf8'), value => value.includes('dashboard-delivery-control')),
        'dashboard-delivery-control\n');
      const writeTrace = fs.readFileSync(trace, 'utf8').slice(beforeWrite).trim().split('\n').map(JSON.parse);
      assert.ok(writeTrace.some(row => row.argv.includes('if-shell') && row.argv.some(arg => arg.includes('paste-buffer'))));
      for (const index of [1, 2]) assert.equal(fs.readFileSync(path.join(sandbox.root, `input-${index}`), 'utf8'), '');
      console.log('Dashboard tmux acceptance evidence:', JSON.stringify({ durationMs: readEnd - readStart,
        readRounds, readClients: readTrace.length, readIfShell: 0, groups: 3, states: 'idle', contexts: [21, 22, 23],
        weeklyRemaining: 63, delivery: 'real SessionAdapter paste/send-keys succeeded with if-shell write guard' }));
      await browser.close();
      child.kill('SIGTERM');
      await child.completion;
    }, { timeoutMs: 110000 });
    assert.equal(fs.existsSync(sandbox.root), false);
  });
