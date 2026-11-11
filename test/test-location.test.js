import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('test files use module or root test directories', () => {
  const invalid = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        const relative = path.relative(root, fullPath).split(path.sep).join('/');
        if (!relative.startsWith('test/') && !`/${relative}`.includes('/__tests__/')) {
          if (invalid.length < 20) invalid.push(relative);
        }
      }
    }
  }
  walk(root);
  assert.equal(invalid.length, 0,
    `Test files must be in __tests__/ or root test/ (up to 20 shown):\n${invalid.join('\n')}`);
});

test('test exclusions use only standard test directories and patterns', () => {
  const allowed = new Set([
    '/test', '/jest.config.js', '**/__tests__', '**/*.test.js',
    '/skills/zylos-memory/scripts/__tests__',
  ]);
  for (const file of ['.npmignore', '.gitattributes']) {
    let inTestSection = false;
    const invalid = [];
    for (const rawLine of fs.readFileSync(path.join(root, file), 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('# Tests ')) inTestSection = true;
      else if (file === '.npmignore' && ['# Logs and databases', '# Environment'].includes(line)) {
        inTestSection = false;
      }
      if (!line || line.startsWith('#')) continue;
      if (!inTestSection && !/(?:test|jest)/.test(line)) continue;
      const rule = line.split(/\s+/)[0].replace(/\/$/, '');
      if (!allowed.has(rule) && invalid.length < 20) invalid.push(line);
    }
    assert.equal(invalid.length, 0,
      `${file} has nonstandard test exclusions (up to 20 shown):\n${invalid.join('\n')}`);
  }
});
