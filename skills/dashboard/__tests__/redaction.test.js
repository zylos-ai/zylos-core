import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { redact, createRedactor, UNAVAILABLE } from '../src/lib/redaction/engine.js';

const random = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL';
test('vendor credentials and structures are removed, with nonsecret context retained', () => {
  const values = [
    'AKIA' + 'BCDEFGHJKLMNP2345'.slice(0, 16),
    'ghp_' + random.repeat(2).slice(0, 36),
    'sk-proj-' + random.repeat(6).slice(0, 74) + 'T3BlbkFJ' + random.repeat(6).slice(0, 74),
    'sk-ant-api03-' + random.repeat(3).slice(0, 93) + 'AA',
    'xoxb-1234567890-1234567890-' + random.slice(0, 24),
    'sk_live_' + random.slice(0, 24),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + random,
    '-----BEGIN PRIVATE KEY-----\n' + random.repeat(3) + '\n-----END PRIVATE KEY-----',
    '1234567890:AA' + random.repeat(2).slice(0, 33),
    'gsk_' + random.repeat(2).slice(0, 52),
    'sk-or-v1-' + 'ab1234567890cdef'.repeat(5).slice(0, 64),
    'xai-' + random.repeat(3).slice(0, 80),
    'sk-api-' + random.repeat(4).slice(0, 119),
  ];
  for (const secret of values) {
    const r = redact(secret.startsWith('1234567890:') ? 'TELEGRAM_BOT_TOKEN=' + secret : secret);
    assert.ok(r.count > 0, `missing ${secret.slice(0, 12)}`);
    assert.ok(!r.text.includes(secret));
  }
  for (const text of [
    'password=ordinary-pass',
    'Authorization: Bearer ordinary-pass',
    'Cookie: auth=ordinary-pass',
    'https://user:ordinary-pass@example.com/?token=ordinary-pass',
  ]) {
    const r = redact(text);
    assert.ok(!r.text.includes('ordinary-pass'));
    assert.ok(r.count > 0);
  }
  assert.match(redact('Authorization: Bearer ordinary-pass').text, /Authorization: Bearer /);
});
test('known-value refresh, metadata recursion, cache invalidation and safe failure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'history-redaction-'));
  await mkdir(path.join(dir, 'components', 'test'), { recursive: true });
  await writeFile(path.join(dir, '.env'), 'CUSTOM_TOKEN=unusual-short-password\n');
  await writeFile(
    path.join(dir, 'components', 'test', 'config.json'),
    JSON.stringify({ apiKey: 'component-secret-value' }),
  );
  const r = createRedactor({ zylosDir: dir });
  assert.equal((await r.redact('unusual-short-password')).count, 1);
  assert.equal((await r.redact('component-secret-value')).count, 1);
  await writeFile(path.join(dir, '.env'), 'CUSTOM_TOKEN=replacement-password\n');
  assert.equal((await r.redact('replacement-password')).count, 1);
  const meta = await r.redactValue({
    password: 'weak-but-private',
    nested: { text: 'ghp_' + random.repeat(2).slice(0, 36) },
  });
  assert.ok(!JSON.stringify(meta).includes('weak-but-private'));
  assert.ok(meta.count >= 2);
  await writeFile(path.join(dir, 'components', 'test', 'config.json'), '{invalid');
  assert.equal((await r.redact('sensitive')).text, UNAVAILABLE);
  r.close();
});
test('worker timeout fails closed', async () => {
  const r = createRedactor({ timeoutMs: 0 });
  assert.deepEqual(await r.redact('password=private'), {
    text: UNAVAILABLE,
    count: 0,
    kinds: [],
    failed: true,
  });
  r.close();
});

test('serialized JSON nested in tool output masks escaped credential values', async () => {
  const secret = 'lowentropy-secret-value';
  const text = JSON.stringify({ output: JSON.stringify({ password: secret }) });
  assert.ok(!redact(text).text.includes(secret));
  const quoted = 'private"quoted\\value';
  assert.ok(!redact(JSON.stringify({ password: quoted })).text.includes('quoted'));
  const r = createRedactor();
  const result = await r.redactValue({ output: text });
  assert.ok(!JSON.stringify(result).includes(secret));
  r.close();
});
