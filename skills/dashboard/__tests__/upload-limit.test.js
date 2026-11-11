import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readUploadLimit } from '../scripts/attachment-utils.js';

test('upload limit reads only the Dashboard setting and reloads environment changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.env');
  fs.writeFileSync(file, 'WEB_CONSOLE_MAX_UPLOAD_MB=1\n');
  assert.equal(readUploadLimit(root), 20 * 1024 * 1024);
  fs.writeFileSync(file, 'DASHBOARD_MAX_UPLOAD_MB=1\n');
  assert.equal(readUploadLimit(root), 1024 * 1024);
  fs.writeFileSync(file, 'WEB_CONSOLE_MAX_UPLOAD_MB=1\nDASHBOARD_MAX_UPLOAD_MB=2\n');
  assert.equal(readUploadLimit(root), 2 * 1024 * 1024);
  fs.writeFileSync(file, 'DASHBOARD_MAX_UPLOAD_MB=invalid\n');
  assert.equal(readUploadLimit(root), 20 * 1024 * 1024);
});
