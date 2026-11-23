import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
// Baseline fails: the two monolithic templates exist. Checking the entire tree
// also rejects empty INDEX/sample replacements, which upgrades would copy out.
test('new-install memory templates omit legacy records and replacement pages', () => {
  const reference = path.join(repo, 'templates/memory/reference');
  const files = fs.readdirSync(reference, { recursive: true }).map(String);
  assert.equal(files.some(file => /^(projects|decisions)(\.md|[\\/]|$)/.test(file)), false);
});
