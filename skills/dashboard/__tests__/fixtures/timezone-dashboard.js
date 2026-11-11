import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInstanceTimezone, handleInstanceTimezone, handleInstanceTimezoneRestart } from '../../src/lib/instance-timezone.js';
import { AuthGate, hashPassword } from '../../src/lib/auth.js';
import { Store } from '../../src/lib/store.js';
import { handleAction } from '../../src/lib/actions.js';
import { sendJson } from '../../src/lib/http.js';
const root = process.env.ZYLOS_DIR;
const store = new Store(path.join(root, 'components/dashboard/dashboard.db'));
const auth = new AuthGate({ auth: { enabled: true, password: hashPassword('fixture-password') } }, store);
const tokens = {};
for (const scope of ['read', 'admin']) {
  const key = store.insertApiKey({ name: `fixture-${scope}`, keyHash: hashPassword('fixture-key'), scope });
  const token = `zylos_st_${crypto.randomBytes(32).toString('hex')}`;
  store.insertApiSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), apiKeyId: key.lastInsertRowid,
    scope, createdAt: Date.now(), expiresAt: Date.now() + 120000 });
  tokens[scope] = token;
}
const timezone = createInstanceTimezone({ zylosDir: root,
  readPm2: async () => ({ processes: JSON.parse(execFileSync(process.execPath, [process.env.TIMEZONE_TEST_PM2, 'jlist'],
    { env: process.env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })) }), log() {} });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (await auth.handle(req, res, url)) return;
    if (await handleInstanceTimezone(req, res, url, { auth, timezone })) return;
    if (await handleInstanceTimezoneRestart(req, res, url, { auth, timezone,
      runAction: body => handleAction('restart-timezone-services', body, { zylosDir: root }, { timezone }) })) return;
    sendJson(res, 404, { error: 'not_found' });
  } catch (error) { console.error(error); sendJson(res, 500, { error: 'fixture_failed' }); }
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(root, 'dashboard-listener.json'),
  JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, tokens, pid: process.pid })));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearInterval(auth._cleanupTimer); server.closeAllConnections(); server.close(() => { store.close(); });
});
