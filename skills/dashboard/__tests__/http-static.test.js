import assert from 'node:assert/strict';
import path from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { serveStatic } from '../src/lib/http.js';

const root = path.resolve(import.meta.dirname, '../public');

function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.body = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

test('static handler preserves traversal rejection', async () => {
  const res = response();
  assert.equal(serveStatic({ url: '/_assets/..%2fpackage.json' }, res, root), true);
  await finished(res);
  assert.equal(res.status, 403);
  assert.equal(res.body(), 'forbidden');
});

// Pure static-file streaming, no listener or service. Run for font asset/MIME changes.

// HTTP integration: real createServer page dispatch and index rendering. Run for
// local page routes or browser-base changes; skip component-only styling edits.
// Runner supplies private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and tmux namespace.
// This case owns one temporary SQLite root and random loopback listener. No Core,
// PM2, tmux or remote transport starts; CLI calls are replaced before import.
// Requests are bounded to 3s, case to 15s. Close listener, timers and Store before
// removing only the owned fixture root, including when import or requests fail.
