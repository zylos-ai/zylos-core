import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';
import { generateRouteBlocks } from '../cli/lib/caddy.js';

const caddyBin = path.join(process.env.HOME, 'zylos/bin/caddy');
const runtimeTest = fs.existsSync(caddyBin) ? test : test.skip;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForProxy(url, child) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode != null) throw new Error(`Caddy exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* listener not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Caddy did not start');
}

describe('Caddy cookie allowlist runtime', () => {
  runtimeTest('preserves order and duplicates, drops collisions, and fails closed', async () => {
    const backend = http.createServer((req, res) => res.end(req.headers.cookie || ''));
    const backendPort = await listen(backend);
    const proxyPort = await unusedPort();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-caddy-cookie-'));
    const configPath = path.join(tempDir, 'Caddyfile');
    const grant = `grant.${'a'.repeat(32)}`;
    const routes = generateRouteBlocks([{
      path: '/proxy/*',
      type: 'reverse_proxy',
      target: `127.0.0.1:${backendPort}`,
      strip_prefix: '/proxy',
      cookie_allowlist: {
        exact: ['session'],
        patterns: ['^grant\\.[a-f0-9]{32}$', '^first|second$'],
      },
    }]);
    fs.writeFileSync(configPath, `http://127.0.0.1:${proxyPort} {\n${routes}\n}\n`);
    const caddy = spawn(caddyBin, ['run', '--config', configPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    caddy.stderr.on('data', (chunk) => { stderr += chunk; });

    try {
      const url = `http://127.0.0.1:${proxyPort}/proxy/check`;
      await waitForProxy(url, caddy);
      const filtered = await fetch(url, {
        headers: { Cookie: `blocked=1; session=one; ${grant}=g; session=two; session_backup=no` },
      });
      expect((await filtered.text()).trim()).toBe(`session=one; ${grant}=g; session=two;`);

      const malformed = await fetch(url, { headers: { Cookie: 'broken; session=one' } });
      expect(await malformed.text()).toBe('');

      const anchoredAlternatives = await fetch(url, {
        headers: {
          Cookie: `prefix-${grant}=no; ${grant}-suffix=no; ${grant}=yes; prefix-first=no; second-suffix=no; first=1; second=2`,
        },
      });
      expect((await anchoredAlternatives.text()).trim()).toBe(`${grant}=yes; first=1; second=2;`);

      const overflow = Array.from({ length: 33 }, (_, index) => `c${index}=v`).join('; ');
      const overflowed = await fetch(url, { headers: { Cookie: `${overflow}; session=one` } });
      expect(await overflowed.text()).toBe('');
    } catch (err) {
      throw new Error(`${err.message}\n${stderr}`);
    } finally {
      caddy.kill('SIGTERM');
      await new Promise((resolve) => caddy.once('exit', resolve));
      await new Promise((resolve) => backend.close(resolve));
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10_000);
});
