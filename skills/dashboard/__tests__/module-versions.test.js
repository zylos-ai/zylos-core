import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));

test('public assets use stable URLs without manual cache versions', () => {
  let checked = 0;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && /\.(js|css|html)$/.test(entry.name)) {
        checked++;
        assert.equal(fs.readFileSync(filename).includes(Buffer.from('?v=')), false,
          `${path.relative(publicRoot, filename)} must not contain a manual cache version`);
      }
    }
  }
  walk(publicRoot);
  assert.ok(checked > 0, 'public assets were checked');
});
