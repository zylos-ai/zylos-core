import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'docker/dashboard-host.mjs');
const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

// Runs the real container step on a private file. Run when the Docker Dashboard step changes; skip otherwise.
// Only a temporary directory is touched: no Docker, PM2, tmux, network or database.
function run(content, mode = 0o600) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-host-')));
  fixtures.push(dir);
  const file = path.join(dir, 'config.json');
  if (content !== undefined) fs.writeFileSync(file, content, { mode });
  const result = spawnSync(process.execPath, [script, file], {
    cwd: dir, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
  });
  const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  return { ...result, file, after, mode: after === undefined ? null : fs.statSync(file).mode & 0o777, entries: fs.readdirSync(dir) };
}

describe('Dashboard listen address in the container', () => {
  test('sets 0.0.0.0 when the file has no host, keeping other keys and permissions', () => {
    const result = run(JSON.stringify({ port: 3470, auth: { enabled: true, password: 'hash' } }), 0o640);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.after), { port: 3470, auth: { enabled: true, password: 'hash' }, host: '0.0.0.0' });
    assert.equal(result.mode, 0o640);
    assert.deepEqual(result.entries, ['config.json']);
    assert.ok(!(result.stdout + result.stderr).includes('hash'));
  });

  for (const [label, host] of [
    ['loopback', '127.0.0.1'],
    ['an interface address', '10.0.0.5'],
    ['an empty value', ''],
  ]) {
    test(`keeps an explicit host (${label}) byte for byte`, () => {
      const content = `{\n  "host": ${JSON.stringify(host)},\n  "port": 3470\n}\n`;
      const result = run(content);
      assert.equal(result.status, 0);
      assert.equal(result.after, content);
    });
  }

  test('a missing file is left missing and reported, so the entrypoint warns', () => {
    const result = run(undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('Dashboard config not found'));
    assert.equal(result.after, undefined);
  });

  for (const [label, content] of [
    ['invalid JSON', '{ "port": '],
    ['an array', '[]'],
    ['null', 'null'],
  ]) {
    test(`${label} is reported and left unchanged`, () => {
      const result = run(content);
      assert.equal(result.status, 1);
      assert.equal(result.after, content);
      assert.deepEqual(result.entries, ['config.json']);
    });
  }
});

describe('Docker wiring for Dashboard', () => {
  test('the image exposes 3470 and ships the listen step next to the entrypoint', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^EXPOSE 3470$/m);
    assert.doesNotMatch(dockerfile, /^EXPOSE 3456$/m);
    assert.match(dockerfile, /^COPY --chown=zylos:zylos docker\/dashboard-host\.mjs \/dashboard-host\.mjs$/m);
  });

  test('compose maps the Dashboard port and passes it into the container', () => {
    const compose = yaml.load(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
    const service = compose.services.zylos;
    assert.ok(service.ports.includes('${DASHBOARD_PORT:-3470}:3470'));
    assert.equal(service.ports.some(port => port.includes('3456')), false);
    assert.equal(service.environment.DASHBOARD_PORT, '${DASHBOARD_PORT:-3470}');
    assert.ok(!('WEB_CONSOLE_BIND' in service.environment));
    assert.ok(!('ZYLOS_WEB_PASSWORD' in service.environment));
  });

  test('the entrypoint sets the listen address after init and before services start, then prints the Dashboard lines', () => {
    const entrypoint = fs.readFileSync(path.join(root, 'docker/entrypoint.sh'), 'utf8');
    const init = entrypoint.indexOf('if ! zylos init ${INIT_ARGS}; then');
    const listen = entrypoint.indexOf('node /dashboard-host.mjs "${ZYLOS_DIR}/components/dashboard/config.json"');
    const services = entrypoint.indexOf('pm2 start "${ZYLOS_DIR}/pm2/ecosystem.config.cjs"');
    assert.ok(init > 0);
    assert.ok(listen > init);
    assert.ok(services > listen);
    const banner = entrypoint.slice(entrypoint.indexOf('ok "Zylos is ready!"'));
    assert.ok(banner.includes('info "Dashboard: http://localhost:${DASHBOARD_PORT:-3470}/"\ninfo "Set or reset the password: docker exec -it <container> zylos dashboard reset-password"\n'));
    assert.doesNotMatch(entrypoint, /WEB_CONSOLE_BIND|Web console:/);
  });
});

describe('Docker Codex launch arguments', () => {
  test('disables interactive tools before the permission bypass condition and preserves the setting when bypassing', () => {
    const entrypoint = fs.readFileSync(path.join(root, 'docker/entrypoint.sh'), 'utf8');
    assert.ok(entrypoint.includes('  CODEX_ARGS="-c tools.experimental_request_user_input.enabled=false -c features.goals=false -c features.apps=false"\n'
      + '  if [ "${CODEX_BYPASS_PERMISSIONS:-true}" = "true" ]; then\n'
      + '    CODEX_ARGS="${CODEX_ARGS} --dangerously-bypass-approvals-and-sandbox"\n'
      + '  fi'));
    assert.ok(entrypoint.includes('exec codex ${CODEX_ARGS}'));
    assert.equal(entrypoint.match(/tools\.experimental_request_user_input\.enabled=false/g).length, 1);
  });
});

describe('Docker Claude launch arguments', () => {
  test('disables interactive tools before the permission bypass condition and keeps the single-argument form', () => {
    const entrypoint = fs.readFileSync(path.join(root, 'docker/entrypoint.sh'), 'utf8');
    assert.ok(entrypoint.includes('  CLAUDE_ARGS="--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode,Artifact,ReportFindings,Workflow"\n'
      + '  if [ "${CLAUDE_BYPASS_PERMISSIONS:-true}" = "true" ]; then\n'
      + '    CLAUDE_ARGS="${CLAUDE_ARGS} --dangerously-skip-permissions"\n'
      + '  fi'));
    assert.doesNotMatch(entrypoint, /--disallowedTools(?:\s|["'])/);
    assert.ok(entrypoint.includes('exec claude ${CLAUDE_ARGS}'));
    assert.equal(entrypoint.match(/--disallowedTools=/g).length, 1);
  });
});
