import { afterEach, describe, expect, test } from '@jest/globals';
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
    expect(result.status).toBe(0);
    expect(JSON.parse(result.after)).toEqual({ port: 3470, auth: { enabled: true, password: 'hash' }, host: '0.0.0.0' });
    expect(result.mode).toBe(0o640);
    expect(result.entries).toEqual(['config.json']);
    expect(result.stdout + result.stderr).not.toContain('hash');
  });

  test.each([
    ['loopback', '127.0.0.1'],
    ['an interface address', '10.0.0.5'],
    ['an empty value', ''],
  ])('keeps an explicit host (%s) byte for byte', (_label, host) => {
    const content = `{\n  "host": ${JSON.stringify(host)},\n  "port": 3470\n}\n`;
    const result = run(content);
    expect(result.status).toBe(0);
    expect(result.after).toBe(content);
  });

  test('a missing file is left missing and reported, so the entrypoint warns', () => {
    const result = run(undefined);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Dashboard config not found');
    expect(result.after).toBeUndefined();
  });

  test.each([
    ['invalid JSON', '{ "port": '],
    ['an array', '[]'],
    ['null', 'null'],
  ])('%s is reported and left unchanged', (_label, content) => {
    const result = run(content);
    expect(result.status).toBe(1);
    expect(result.after).toBe(content);
    expect(result.entries).toEqual(['config.json']);
  });
});

describe('Docker wiring for Dashboard', () => {
  test('the image exposes 3470 and ships the listen step next to the entrypoint', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^EXPOSE 3470$/m);
    expect(dockerfile).toMatch(/^EXPOSE 3456$/m);
    expect(dockerfile).toMatch(/^COPY --chown=zylos:zylos docker\/dashboard-host\.mjs \/dashboard-host\.mjs$/m);
  });

  test('compose maps the Dashboard port and passes it into the container', () => {
    const compose = yaml.load(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
    const service = compose.services.zylos;
    expect(service.ports).toEqual(expect.arrayContaining(['${DASHBOARD_PORT:-3470}:3470', '${WEB_CONSOLE_PORT:-3456}:3456']));
    expect(service.environment.DASHBOARD_PORT).toBe('${DASHBOARD_PORT:-3470}');
  });

  test('the entrypoint sets the listen address after init and before services start, then prints the Dashboard lines', () => {
    const entrypoint = fs.readFileSync(path.join(root, 'docker/entrypoint.sh'), 'utf8');
    const init = entrypoint.indexOf('if ! zylos init ${INIT_ARGS}; then');
    const listen = entrypoint.indexOf('node /dashboard-host.mjs "${ZYLOS_DIR}/components/dashboard/config.json"');
    const services = entrypoint.indexOf('pm2 start "${ZYLOS_DIR}/pm2/ecosystem.config.cjs"');
    expect(init).toBeGreaterThan(0);
    expect(listen).toBeGreaterThan(init);
    expect(services).toBeGreaterThan(listen);
    const banner = entrypoint.slice(entrypoint.indexOf('ok "Zylos is ready!"'));
    expect(banner).toContain('info "Dashboard: http://localhost:${DASHBOARD_PORT:-3470}/"\ninfo "Set or reset the password: docker exec -it <container> zylos dashboard reset-password"\n');
  });
});
