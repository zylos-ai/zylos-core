import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/lib/auth.js';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Covers the real local index.js /chat route and base-prefixed assets after
// login. Run for page-route/auth changes; skip before DB/HTTP/process creation
// unless explicitly arranging isolated integration.
test('local chat route serves the application with base-prefixed module URLs', { skip: !chatEnabled(), timeout: 30_000 }, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    const configPath = path.join(sandbox.paths.zylos, 'components/dashboard/config.json');
    fs.writeFileSync(configPath, JSON.stringify({ auth: { enabled: true, password: hashPassword('route-fixture-password') } }));
    const child = sandbox.startChild(process.execPath,
      [fileURLToPath(new URL('./fixtures/chat-local-route.js', import.meta.url))], { env: { DASHBOARD_PORT: '0' } });
    let origin;
    const limit = Date.now() + 15_000;
    let buffered = '';
    child.stdout.on('data', chunk => {
      buffered = (buffered + chunk).slice(-8192);
      for (const line of buffered.split('\n')) {
        try { origin ||= JSON.parse(line).chatRouteOrigin; } catch { /* bounded startup diagnostics */ }
      }
    });
    while (!origin && Date.now() < limit && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
    if (!origin && child.exitCode !== null) {
      const result = await child.completion;
      assert.fail(`Actual Dashboard fixture exited ${result.code}: ${result.stderr.slice(-4096)}`);
    }
    assert.ok(origin, 'Actual Dashboard must start inside the private instance');
    const denied = await fetch(`${origin}/chat`, { redirect: 'manual' });
    assert.equal(denied.status, 302);
    assert.match(denied.headers.get('location'), /login/);
    const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'route-fixture-password', next: '/chat' }) });
    assert.equal(login.status, 302);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_dashboard_session='))?.split(';')[0];
    assert.ok(cookie);
    for (const base of ['', '/dashboard']) {
      const page = await fetch(`${origin}/chat`, { headers: { cookie, ...(base ? { 'x-forwarded-prefix': base } : {}) } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /id="wb-chat"/);
      assert.equal(html.includes('__BASE_PATH__'), false);
      assert.ok(html.includes(`${base}/_assets/`));
    }
    const module = await fetch(`${origin}/_assets/js/wb/chat.js`, { headers: { cookie } });
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.match(await module.text(), /export function mountChat/);
  }, { timeoutMs: 25_000 });
  assert.equal(fs.existsSync(sandbox.root), false);
  assert.equal(sandbox.children.size, 0);
});
