import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact, createRedactor, UNAVAILABLE } from '../src/lib/redaction/engine.js';
import { SECRET_PATTERN } from '../src/lib/redaction/dashboard-secret-pattern.js';
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
test('L4 skips code, paths, placeholders, numeric values and normal personal information', () => {
  for (const text of [
    'API_KEY=${VAR}',
    'API_KEY=$(cmd)',
    'API_KEY=/tmp/key',
    'password=12345',
    'maxTokens=500',
    'token=process.env.TOKEN',
    'email=person@example.com phone=1234567890',
  ])
    assert.equal(redact(text).text, text);
});
test('Fleet guard cannot match redacted output; removing L2 would fail this test', () => {
  const text = 'zylos_st_abcDEF123 ZYLOS_AK_ABC read_api_key READ_SESSION_TOKEN';
  assert.ok(SECRET_PATTERN.test(text));
  const r = redact(text);
  assert.equal(SECRET_PATTERN.test(JSON.stringify(r)), false);
  assert.equal(r.count, 4);
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
test('large worker results match direct redaction including boundary secrets and escaped PEM', async () => {
  const text =
    'x '.repeat(600000) +
    'password=hiddenvalue\n' +
    JSON.stringify(
      '-----BEGIN PRIVATE KEY-----\n' + random.repeat(3) + '\n-----END PRIVATE KEY-----',
    );
  const r = createRedactor();
  assert.deepEqual(await r.redact(text), redact(text));
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
test('overlap only reveals fixed public prefix, never a secret suffix', () => {
  const secret = 'ghp_' + random.repeat(2).slice(0, 36);
  const result = redact(secret);
  assert.match(result.text, /ghp_…/);
  assert.ok(!result.text.includes(secret.slice(-6)));
  const known = redact(secret, { knownValues: [{ value: secret, label: '.env:GITHUB_TOKEN' }] });
  assert.match(known.text, /\.env:GITHUB_TOKEN/);
  assert.equal(known.count, 1);
});

test('Dashboard credentials embedded at a chunk boundary are still fully masked', () => {
  const secret = 'zylos_st_synthetic_sensitive_fixture_abcdefghijk';
  const text = 'a'.repeat(262140) + secret;
  assert.ok(!redact(text).text.includes(secret));
});
test('constructed nested-prefix backtracking input remains bounded', () => {
  const text = ('okta sumologic ' + 'a'.repeat(1000) + '\n').repeat(1000);
  const start = performance.now();
  redact(text);
  assert.ok(performance.now() - start < 200, '1 MB nested-prefix fixture exceeded 200ms');
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

test('negative control: removing L2 makes the unchanged Fleet guard reject history', async () => {
  const engineURL = new URL('../src/lib/redaction/engine.js', import.meta.url);
  const original = await readFile(engineURL, 'utf8');
  const mutation = original.replace('...dashboardSpans(text), ', '');
  assert.notEqual(mutation, original, 'mutation must remove the production L2 call');
  const source = mutation.replace(
    /from '(\.\/[^']+)'/g,
    (_, relative) => `from '${new URL(relative, engineURL).href}'`,
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'redaction-l2-mutant-'));
  const file = path.join(directory, 'engine.mjs');
  await writeFile(file, source);
  const mutant = await import(pathToFileURL(file).href);
  const input = 'read_api_key read_session_token zylos_st_synthetic_credential';
  assert.equal(SECRET_PATTERN.test(redact(input).text), false);
  assert.equal(SECRET_PATTERN.test(mutant.redact(input).text), true);
});

test('L4 preserves session identifiers and metadata while masking credential compounds', async () => {
  const metadata = {
    session_id: '2a1fe8c0-828f-4d83-b18b-24cbcb02319b',
    session_name: 'review-dashboard-history',
    start_new_session: 'continue',
    key: 'role',
    auth: 'enabled',
    Auth: 'basic',
    'session-architecture': 'overview.md',
  };
  const redactor = createRedactor();
  try {
    const result = await redactor.redactValue(metadata);
    assert.equal(JSON.stringify(result.value), JSON.stringify(metadata));
    assert.equal(result.count, 0);
    for (const key of [
      'session_token',
      'session_secret',
      'session_key',
      'sessionToken',
      'API_KEY',
    ]) {
      const result = await redactor.redactValue({ [key]: 'actual-private-credential' });
      assert.ok(!JSON.stringify(result.value).includes('actual-private-credential'), key);
      assert.ok(result.count > 0, key);
    }
    assert.ok(
      !redact('Cookie: sessionid=actual-private-credential').text.includes(
        'actual-private-credential',
      ),
    );
  } finally {
    redactor.close();
  }
});

test('L1 excludes short, boolean, numeric and placeholder values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'redaction-known-filter-'));
  await writeFile(
    path.join(directory, '.env'),
    [
      'X_SESSION_ID=true',
      'FOO_KEY=1',
      'BOOLEAN_TOKEN=true',
      'NUMBER_TOKEN=1234567890123',
      'SHORT_TOKEN=small',
      'ENV_TOKEN=${EXAMPLE_TOKEN}',
      'REAL_TOKEN=real-lowentropy-password',
    ].join('\n'),
  );
  const redactor = createRedactor({ zylosDir: directory });
  try {
    const text = '{"ok": true} 1 1234567890123 small ${EXAMPLE_TOKEN}';
    assert.equal((await redactor.redact(text)).text, text);
    assert.equal((await redactor.redact('real-lowentropy-password')).count, 1);
  } finally {
    redactor.close();
  }
});

test('all reviewed 160 KiB adversarial shapes remain linear in direct scanning', () => {
  for (const token of ['a.', 'a-', 'foo.bar-baz.', '?a']) {
    const text = token.repeat(Math.ceil((160 * 1024) / token.length));
    const start = performance.now();
    assert.equal(redact(text).text, text);
    assert.ok(performance.now() - start < 200, `${token} exceeded 200ms`);
  }
});

test('small fields use reusable worker deadlines and recover after a hung worker', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'redaction-worker-deadline-'));
  const file = path.join(directory, 'worker.mjs');
  const engineURL = new URL('../src/lib/redaction/engine.js', import.meta.url).href;
  await writeFile(
    file,
    `import {parentPort} from 'node:worker_threads';
import {redact} from ${JSON.stringify(engineURL)};
parentPort.on('message', ({id,text,options}) => {
  if(text==='hang') { while(true) {} }
  parentPort.postMessage({id,result:redact(text,options)});
});`,
  );
  const redactor = createRedactor({ workerURL: pathToFileURL(file), timeoutMs: 200 });
  try {
    assert.equal((await redactor.redact('warm')).text, 'warm');
    let ticked = false;
    const heartbeat = setTimeout(() => {
      ticked = true;
    }, 10);
    const hung = await redactor.redact('hang');
    clearTimeout(heartbeat);
    assert.equal(ticked, true);
    assert.equal(hung.failed, true);
    assert.equal(hung.text, UNAVAILABLE);
    assert.equal((await redactor.redact('password=actual-private-credential')).count, 1);
  } finally {
    redactor.close();
  }
});
