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
