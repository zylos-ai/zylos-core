import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function parity(coreUrl, localUrl) {
  const { default: assert } = await import('node:assert/strict');
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const core = await import(coreUrl);
  const local = await import(localUrl);
  const file = path.join(process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos'), '.zylos/config.json');
  assert.equal(core.CONFIG_FILE, file);
  assert.equal(local.CONFIG_FILE, file);
  const sources = [null, '{}', '{"session_mode":"single","runtime":"claude"}',
    '{"session_mode":"multi","runtime":"codex"}',
    '{"session_mode":"unknown","extra":{"nested":[1,false,null]},"__proto__":{"safe":true}}',
    '{"runtime":', 'null', '[]', '42', '"text"', 'true'];
  for (const source of sources) {
    fs.rmSync(file, { force: true });
    if (source !== null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    const before = fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)) : [];
    const a = core.readZylosConfigStrict(), b = local.readZylosConfigStrict();
    assert.equal(b.state, a.state, String(source));
    if (a.state === 'ok') {
      assert.deepEqual(b.config, a.config);
      assert.deepEqual(local.readZylosConfigOrThrow(), a.config);
    } else if (a.state === 'missing') assert.deepEqual(local.readZylosConfigOrThrow(), {});
    else assert.throws(() => local.readZylosConfigOrThrow(), error => error.code === 'CONFIG_UNREADABLE' && error.cause instanceof Error);
    assert.deepEqual(fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)) : [], before);
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(core.readZylosConfigStrict().state, 'error');
  assert.equal(local.readZylosConfigStrict().state, 'error');
  fs.rmdirSync(file);
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0);
  try {
    const a = core.readZylosConfigStrict(), b = local.readZylosConfigStrict();
    assert.equal(a.state, 'error');
    assert.equal(a.error.code, 'EACCES');
    assert.equal(b.state, a.state);
    assert.equal(b.error.code, 'EACCES');
    assert.throws(() => local.readZylosConfigOrThrow(), { code: 'CONFIG_UNREADABLE' });
  } finally { fs.chmodSync(file, 0o600); }
}

for (const explicitDirectory of [false, true]) {
  test('local and Core strict readers agree on FX-F1 and paths; explicit directory = ' + explicitDirectory, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-f1-parity-'));
    try {
      const env = { ...process.env, HOME: root };
      delete env.ZYLOS_DIR;
      if (explicitDirectory) env.ZYLOS_DIR = path.join(root, 'custom-zylos');
      const args = [
        new URL('../../../../cli/lib/config.js', import.meta.url).href,
        new URL('../local-config.js', import.meta.url).href,
      ];
      const source = '(' + parity.toString() + ')(...' + JSON.stringify(args) + ')';
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(path.join(root, '.zylos')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
