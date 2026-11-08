import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const installed = process.argv[2];
const dashboard = path.join(installed, 'skills/dashboard');
const rejectNetwork = () => { throw new Error('Network access is disabled during module import'); };
https.get = https.request = http.get = http.request = net.connect = net.createConnection = rejectNetwork;
syncBuiltinESMExports();
// The API smoke executable performs a health fetch at module evaluation time.
// It receives a private in-memory response; all product modules remain intact.
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });

for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
  assert.ok(process.env[key].startsWith(path.dirname(installed) + path.sep), key);
}
assert.equal(fs.existsSync(path.join(installed, 'skills/web-console')), false);
// Import instead of invoking main: this loads the real graph without starting
// the HTTP service, collectors, CLI writes, or transport commands.
await import(pathToFileURL(path.join(dashboard, 'src/index.js')).href);
const scripts = fs.readdirSync(path.join(dashboard, 'scripts')).filter(name =>
  name.endsWith('.js') && /^#![^\n]*\bnode\b/.test(fs.readFileSync(path.join(dashboard, 'scripts', name), 'utf8'))).sort();
process.argv[2] = 'http://127.0.0.1/';
for (const name of scripts) await import(pathToFileURL(path.join(dashboard, 'scripts', name)).href);
console.log(JSON.stringify({ entry: 'src/index.js', scripts,
  webConsolePresent: fs.existsSync(path.join(installed, 'skills/web-console')) }));
// Module evaluation creates the entry's private database and unref timers.
// Exiting also bounds their lifetime and closes all child-owned descriptors.
process.exit(0);
