import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStartupTimezone } from '../startup-timezone.js';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-tz-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, '.env') };
}
test('startup timezone uses dotenv export, quoting and comment grammar and only changes TZ', t => {
  const { root, file } = fixture(t), env = { ZYLOS_DIR: root, TZ: 'UTC', OTHER: 'original' };
  fs.writeFileSync(file, '# instance\nexport TZ = "Asia/Tokyo" # clock\nOTHER=do-not-import\n');
  loadStartupTimezone(env);
  assert.deepEqual(env, { ZYLOS_DIR: root, TZ: 'Asia/Tokyo', OTHER: 'original' });
});
test('missing environment file or TZ preserves inherited or absent timezone', t => {
  const { root, file } = fixture(t);
  for (const withFile of [false, true]) {
    if (withFile) fs.writeFileSync(file, 'OTHER=value\n');
    for (const inherited of [undefined, 'Europe/London']) {
      const env = { ZYLOS_DIR: root, ...(inherited ? { TZ: inherited } : {}) };
      loadStartupTimezone(env); assert.equal(env.TZ, inherited);
      assert.equal(Object.hasOwn(env, 'TZ'), inherited !== undefined);
    }
  }
});
test('invalid and empty instance timezone fail explicitly before startup', t => {
  const { root, file } = fixture(t), env = { ZYLOS_DIR: root, TZ: 'UTC' };
  for (const value of ['', 'Invalid/Zone']) {
    fs.writeFileSync(file, `TZ=${value}\n`);
    assert.throws(() => loadStartupTimezone(env), { code: 'INVALID_TZ' });
    assert.equal(env.TZ, 'UTC');
  }
});
test('unreadable environment file fails explicitly', t => {
  const { root, file } = fixture(t); fs.mkdirSync(file);
  assert.throws(() => loadStartupTimezone({ ZYLOS_DIR: root }), { code: 'TZ_ENV_READ_ERROR' });
});
