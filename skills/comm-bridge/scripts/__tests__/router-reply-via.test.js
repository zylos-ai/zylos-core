import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { formatConversation } from '../router/format.js';

const hex = value => Buffer.from(value).toString('hex');
const marker = '---- reply via: ';
const route = output => output.slice(output.lastIndexOf(marker) + marker.length).trimEnd();
const row = (extra = {}) => ({ id: 501, channel: 'telegram', endpoint_id: '-100123|msg:88', session_group: 'telegram:g-100123:topic', content: 'Hello', ...extra });
const recorder = file => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "process.stdout.write(JSON.stringify(process.argv.slice(1).map(x => Buffer.from(x).toString('hex'))))");
};
function execute(command) {
  return JSON.parse(execFileSync('/bin/sh', ['-c', `x() { printf MUTATED; }; ${command}`], {
    encoding: 'utf8', env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
  }));
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router reply ' space "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'c4-send.js'); recorder(scriptPath);
  return scriptPath;
}

// byte identity through the shell, not string snapshots.
test('reply-via preserves endpoint and script bytes in whole, local, single and internal scopes', t => {
  const scriptPath = fixture(t);
  for (const endpoint of ['-100123|msg:88', "it's $(x)", '`id`', 'a"b\\c']) {
    for (const sessionGroup of ['telegram:g-100123:topic', 'telegram', null]) {
      const input = row({ endpoint_id: endpoint, session_group: sessionGroup });
      const expected = [scriptPath, 'telegram', endpoint];
      assert.deepEqual(execute(route(formatConversation(input, { scriptPath }))), expected.map(hex));
    }
  }
  const internal = row({ channel: 'internal', endpoint_id: 'sender:group', session_group: 'receiver:group' });
  assert.deepEqual(execute(route(formatConversation(internal, { scriptPath }))), [scriptPath, 'internal', 'sender:group'].map(hex));
});
