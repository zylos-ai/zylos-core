import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from '../config.js';
import { initCommand } from '../../commands/init.js';

test('init refuses corrupt before running any installation/auth stage', async t => {
  const previous = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE) : null;
  t.after(() => {
    if (previous === null) fs.rmSync(CONFIG_FILE, { force: true });
    else fs.writeFileSync(CONFIG_FILE, previous);
  });
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, '{broken');
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');
  await assert.rejects(() => initCommand(['--json', '-y']), error => error.code === 'CONFIG_UNREADABLE');
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before);
});
