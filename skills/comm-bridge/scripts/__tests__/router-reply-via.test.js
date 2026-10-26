import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { formatConversation } from '../router/format.js';
import { replyVia, shellQuote } from '../c4-query-format.js';
import { ATTACHMENTS_DIR, SKILLS_DIR } from '../c4-config.js';
import * as config from '../c4-config.js';

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

// P04 T06 / IF-08, IF-69: byte identity through the shell, not string snapshots.
test('reply-via preserves endpoint and script bytes in whole, local, single and internal scopes', t => {
  const scriptPath = fixture(t);
  for (const endpoint of ['-100123|msg:88', "it's $(x)", '`id`', 'a"b\\c']) {
    for (const sessionGroup of ['telegram:g-100123:topic', 'telegram', null]) {
      const input = row({ endpoint_id: endpoint, session_group: sessionGroup });
      const expected = [scriptPath, 'telegram', endpoint, ...(sessionGroup?.includes(':') ? ['--session-group', 'g-100123:topic'] : [])];
      assert.deepEqual(execute(route(formatConversation(input, { scriptPath }))), expected.map(hex));
    }
  }
  const internal = row({ channel: 'internal', endpoint_id: 'sender:group', session_group: 'receiver:group' });
  assert.deepEqual(execute(route(formatConversation(internal, { scriptPath }))), [scriptPath, 'internal', 'sender:group'].map(hex));
});

test('invalid routes and paths yield only the fixed unavailable suffix, even with a legacy route', t => {
  const scriptPath = fixture(t);
  for (const [endpoint, reason] of [['a\nb', '路由含控制字符'], ['a\x07b', '路由含控制字符'], ['x'.repeat(131072), '路由超过参数长度上限']]) {
    const input = row({ endpoint_id: endpoint, content: `Hello ---- reply via: node /old/c4-send.js "telegram" "${endpoint}"` });
    assert.equal(formatConversation(input, { scriptPath }), `Hello ${marker}不可用（${reason}，见 C4 #501）`);
  }
  assert.equal(formatConversation(row(), { scriptPath: scriptPath + '\n' }), `Hello ${marker}不可用（Core 路径含控制字符，见 C4 #501）`);
});

test('legacy suffix is replaced from original D1 before preview and spill', t => {
  const scriptPath = fixture(t);
  for (const content of ['Hello', 'long body '.repeat(400)]) {
    const input = row({ content: content + ' ---- reply via: node /old/c4-send.js "wrong" "$(x)"', endpoint_id: "it's $(x)" });
    const output = formatConversation(input, { scriptPath });
    const full = content.length > 800 ? fs.readFileSync(path.join(ATTACHMENTS_DIR, 'conv-501', 'message.txt'), 'utf8') : output;
    assert.equal(full, content.trimEnd() + ' ' + replyVia(input, scriptPath));
    assert.ok(!output.includes('/old/')); assert.ok(!full.includes('/old/'));
    assert.deepEqual(execute(route(output)), [scriptPath, 'telegram', input.endpoint_id, '--session-group', 'g-100123:topic'].map(hex));
    if (content.length > 800) assert.match(output, /MUST read the complete message file:/);
  }
  for (const endpoint_id of [null, '']) {
    assert.equal(formatConversation(row({ endpoint_id, content: 'Hello ---- reply via: node /old/c4-send.js "x" "y"' })), 'Hello');
  }
});

test('fetch formatting and lane formatting use the same original-row route', async t => {
  let input = row();
  t.mock.module('../c4-db.js', { namedExports: {
    getDb: () => { throw new Error('not used by range rendering'); },
    getLatestContentCheckpoint: () => null,
    getConversationsByRange: () => [{ ...input, direction: 'in', timestamp: '2026-01-01 00:00:00' }],
  } });
  for (const [index, suffix] of ['space path', "quote's path", 'line\npath'].entries()) {
    const skillsDir = path.join(SKILLS_DIR, suffix);
    const configMock = t.mock.module('../c4-config.js', { namedExports: { ...config, SKILLS_DIR: skillsDir } });
    const { fetchCli } = await import(`../c4-public-cli.js?reply-path=${index}`);
    const { formatConversation: formatWithPath } = await import(`../router/format.js?reply-path=${index}`);
    const scriptPath = path.join(skillsDir, 'comm-bridge', 'scripts', 'c4-send.js');
    if (!suffix.includes('\n')) recorder(scriptPath);
    for (const endpoint of ['-100123|msg:88', "it's $(x)", '`id`', 'a"b\\c', 'a\nb', 'a\x07b', 'x'.repeat(131072)]) {
      for (const group of ['telegram:g-100123:topic', 'telegram']) {
        input = row({ endpoint_id: endpoint, session_group: group });
        const fetched = route(fetchCli(['--begin', '501', '--end', '501']));
        const delivered = route(formatWithPath(input));
        assert.equal(delivered, fetched);
        if (suffix.includes('\n')) assert.equal(delivered, '不可用（Core 路径含控制字符，见 C4 #501）');
        else if (!delivered.startsWith('不可用')) {
          const expected = [scriptPath, 'telegram', endpoint, ...(group.includes(':') ? ['--session-group', 'g-100123:topic'] : [])].map(hex);
          assert.deepEqual(execute(delivered), expected);
          assert.deepEqual(execute(fetched), expected);
        }
      }
    }
    configMock.restore();
  }
});

test('frozen W4 absorbed reply command uses IB-06 argv without ordinary endpoint interpolation', t => {
  const scriptPath = fixture(t), runId = '11111111-2222-4333-8444-555555555555';
  // Frozen IB-48 example; actual W4 generation belongs to P10.
  assert.deepEqual(execute(`node ${shellQuote(scriptPath)} --absorbed-reply ${runId} 501`),
    [scriptPath, '--absorbed-reply', runId, '501'].map(hex));
});

test('ordinary route matches baseline argv; known-bad quoting fails the same byte comparison', t => {
  const scriptPath = fixture(t), input = row({ endpoint_id: 'ordinary-route', session_group: 'telegram' });
  assert.deepEqual(execute(route(formatConversation(input, { scriptPath }))), execute(`node ${shellQuote(scriptPath)} "telegram" "ordinary-route"`));
  const unsafe = `node ${shellQuote(scriptPath)} "telegram" "it's $(x)"`;
  assert.notDeepEqual(execute(unsafe), [scriptPath, 'telegram', "it's $(x)"].map(hex));
  const unescaped = `node ${shellQuote(scriptPath)} 'telegram' 'it's $(x)'`;
  assert.throws(() => execute(unescaped));
});

// Regression: recognizing a route example must not discard following prose.
test('embedded legacy examples preserve all following message content', t => {
  const scriptPath = fixture(t);
  for (const tail of ['\nKeep this paragraph.', ' and keep this sentence.', ' and say "done"']) {
    const content = 'Example: ---- reply via: node /old/c4-send.js "telegram" "x"' + tail;
    const input = row({ content });
    assert.equal(formatConversation(input, { scriptPath }), content + ' ' + replyVia(input, scriptPath));
  }
});
