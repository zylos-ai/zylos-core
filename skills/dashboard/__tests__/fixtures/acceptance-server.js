// The sandbox server imports product modules normally; only network boundaries
// and the unrelated remote version poller are disabled for local acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mock } from 'node:test';
import { VersionChecker } from '../../src/lib/version-checker.js';

const root = fs.realpathSync(process.env.ZYLOS_DIR);
for (const key of ['HOME', 'PM2_HOME', 'TMPDIR']) {
  const value = fs.realpathSync(process.env[key]);
  assert.ok(value.startsWith(root + path.sep), key + ' must be private');
}
console.log('Acceptance child isolation:', JSON.stringify(Object.fromEntries(
  ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX', 'TMUX_TMPDIR'].map(key => [key, process.env[key]]))));
const blocked = () => { throw Error('External network forbidden in acceptance fixture'); };
https.request = https.get = blocked;
const local = value => {
  const hostname = typeof value === 'string' || value instanceof URL ? new URL(value).hostname : value?.hostname ?? value?.host;
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname), 'HTTP target must be loopback');
};
for (const method of ['get', 'request']) {
  const original = http[method];
  http[method] = (...args) => { local(args[0]); return original(...args); };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { local(args[0]); return originalFetch(...args); };
mock.method(VersionChecker.prototype, 'start', () => {});
