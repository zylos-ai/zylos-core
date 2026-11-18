import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

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

test('each test belongs to exactly one runner or the slow category', () => {
  const run = (args, slow) => execFileSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ZYLOS_SLOW_TESTS: slow ? '1' : '0' },
  });
  const nodeFiles = slow => new Set(run(['scripts/run-node-tests.js', '--list'], slow).trim().split('\n').filter(Boolean));
  const jestFiles = slow => new Set(JSON.parse(run([
    'node_modules/jest/bin/jest.js', '--listTests', '--json', '--runInBand',
  ], slow)).map(file => path.relative(root, file).split(path.sep).join('/')));
  const node = nodeFiles(false), jest = jestFiles(false);
  const allNode = nodeFiles(true), allJest = jestFiles(true);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.test.js'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  }).split('\0').filter(file => file && fs.existsSync(path.join(root, file)));
  for (const file of new Set(files)) {
    const slow = file.endsWith('.slow.test.js');
    assert.equal(Number(node.has(file)) + Number(jest.has(file)) + Number(slow), 1,
      `Expected one default owner (Node, Jest, slow): ${file}`);
    assert.equal(Number(allNode.has(file)) + Number(allJest.has(file)), 1,
      `Expected one opted-in runner: ${file}`);
    if (slow) {
      const header = fs.readFileSync(path.join(root, file), 'utf8').split('\n', 1)[0];
      const sources = header.match(/^\/\/ covers:\s*(\S.*)$/)?.[1].trim().split(/\s+/);
      assert.ok(sources?.length, `Missing covers header: ${file}`);
      for (const source of sources) {
        assert.ok(!path.isAbsolute(source) && !source.split('/').includes('..') && fs.existsSync(path.join(root, source)),
          `Invalid covers path in ${file}: ${source}`);
      }
    }
  }
});

test('slow selection follows covered source changes and ignores documentation changes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-selection-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 10000 });
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'src/entry.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(directory, 'other.js'), 'export const other = 1;\n');
  fs.writeFileSync(path.join(directory, 'source.slow.test.js'), '// covers: src/\n');
  fs.writeFileSync(path.join(directory, 'entry.slow.test.js'), '// covers: src/entry.js\n');
  fs.writeFileSync(path.join(directory, 'other.slow.test.js'), '// covers: other.js\n');
  git(['add', '.']); git(['commit', '-qm', 'Initial sources']);
  const base = git(['rev-parse', 'HEAD']).trim();
  const select = since => execFileSync(process.execPath, [path.join(root, 'scripts/select-slow-tests.js'), '--since', since], {
    cwd: directory, encoding: 'utf8', timeout: 10000,
  });
  fs.writeFileSync(path.join(directory, 'README.md'), 'Documentation only\n');
  git(['add', '.']); git(['commit', '-qm', 'Document sources']);
  assert.equal(select(base), '');
  const docs = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(directory, 'src/entry.js'), 'export const value = 2;\n');
  git(['add', '.']); git(['commit', '-qm', 'Change covered source']);
  assert.equal(select(docs), 'entry.slow.test.js\nsource.slow.test.js\n');
  assert.equal(select('HEAD'), '');
  fs.unlinkSync(path.join(directory, 'src/entry.js'));
  assert.equal(select('HEAD'), 'entry.slow.test.js\nsource.slow.test.js\n');
  fs.appendFileSync(path.join(directory, 'other.slow.test.js'), '// Updated test body\n');
  assert.equal(select('HEAD'), 'entry.slow.test.js\nother.slow.test.js\nsource.slow.test.js\n');
});
