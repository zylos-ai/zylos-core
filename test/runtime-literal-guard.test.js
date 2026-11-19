import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUNTIME, SUPPORTED_RUNTIMES } from '../cli/lib/runtime/descriptors.js';

// Raw lines catch quoted IDs inside SQL templates. The scan cannot see IDs
// assembled at runtime, shorthand keys, property accesses, or non-JS files.
// Import rules cover literal specifiers only. Computed imports are invisible.
const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeRoots = ['cli/lib/runtime', 'skills/dashboard/src/lib/runtime'];
const factories = new Set(runtimeRoots.map(dir => `${dir}/index.js`));
const excludedDirectories = new Set(['node_modules', '__tests__', 'test', 'tests']);
const reasons = [
  'dispatch:upgrade', 'dispatch:auth', 'dispatch:launch', 'dispatch:instructions',
  'dispatch:delivery', 'dispatch:hooks', 'dispatch:context', 'dispatch:usage',
  'dispatch:health', 'dispatch:dashboard', 'else-fallback', 'gap', 'inconsistent',
  'legacy', 'text', 'sql-check', 'tool-use',
];
const ids = SUPPORTED_RUNTIMES.join('|');
const runtimeLiteral = new RegExp("(['\"`])(?:" + ids + ")\\1|(?:^|[^a-zA-Z0-9_$.-])(?:" + ids + ')\\s*:');
const registryFile = 'cli/lib/runtime/descriptors.js';
// The public registry is scanned too. Only the declaration of each ID and
// the declaration of the default are exempt here.
const registryDefinitions = new Set([
  `export const DEFAULT_RUNTIME = '${DEFAULT_RUNTIME}';`,
  ...SUPPORTED_RUNTIMES.map(id => `id: '${id}',`),
]);

function* productFiles(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      yield* productFiles(file);
    } else if (entry.isFile() && /\.[cm]?js$/.test(file) && !file.endsWith('.test.js')) {
      yield file;
    }
  }
}

function runtimeDirectory(file) {
  for (const directory of runtimeRoots) {
    if (!file.startsWith(`${directory}/`)) continue;
    const [id, ...rest] = file.slice(directory.length + 1).split('/');
    if (rest.length && SUPPORTED_RUNTIMES.includes(id)) return `${directory}/${id}`;
  }
  return null;
}

function exemptionKey(file, line) {
  return JSON.stringify([file, line]);
}

test('hard-coded runtime IDs match the exemption inventory', () => {
  const exemptions = JSON.parse(fs.readFileSync(new URL('./runtime-literal-exemptions.json', import.meta.url), 'utf8'));
  const violations = [];
  const pending = new Map();
  const definitions = new Set(registryDefinitions);
  for (const { file, text, reason } of exemptions) {
    if (typeof reason !== 'string' || !reasons.some(prefix => reason === prefix || reason.startsWith(`${prefix}: `))) {
      violations.push(`${file}: invalid exemption reason ${JSON.stringify(reason)} for ${text}`);
    }
    const key = exemptionKey(file, text);
    pending.set(key, (pending.get(key) ?? 0) + 1);
  }

  for (const file of [...productFiles('cli'), ...productFiles('skills')]) {
    if (runtimeDirectory(file)) continue;
    for (const [index, raw] of fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (/^(?:\/\/|\/\*|\*)/.test(line) || !runtimeLiteral.test(line)) continue;
      if (file === registryFile && definitions.delete(line)) continue;

      const key = exemptionKey(file, line);
      const remaining = pending.get(key) ?? 0;
      if (remaining > 1) pending.set(key, remaining - 1);
      else if (remaining === 1) pending.delete(key);
      else violations.push(`${file}:${index + 1}: ${line}\n  Use the runtime registry or justify an exemption in the PR.`);
    }
  }
  for (const [key, count] of pending) {
    const [file, line] = JSON.parse(key);
    violations.push(`${file}: stale exemption (${count}): ${line}`);
  }
  assert.deepEqual(violations, []);
});

const moduleSpecifiers = [
  /\bimport\s*(?:(?:[\w$*{},\s]+)\bfrom\s*)?(['"])([^'"\n]+)\1/g,
  /\bexport\s*(?:\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?)\s*\bfrom\s*(['"])([^'"\n]+)\1/g,
  /(?<![\w$.])(?:import|require)\s*\(\s*(['"`])([^'"`\n]+)\1\s*(?=[,)])/g,
  /(?<![\w$.])loadCoreModule\s*\(\s*(['"`])([^'"`\n]+)\1\s*(?=[,)])/g,
];

test('runtime implementations are referenced only by their factory or own implementation', () => {
  const violations = [];
  for (const file of [...productFiles('cli'), ...productFiles('skills')]) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const sourceDir = runtimeDirectory(file);
    for (const pattern of moduleSpecifiers) {
      for (const match of text.matchAll(pattern)) {
        const [, , module] = match;
        if (module.includes('${')) continue;
        const isCoreRelative = pattern === moduleSpecifiers.at(-1);
        if (!isCoreRelative && !/^\.{1,2}\//.test(module)) continue;
        const destination = path.posix.normalize(path.posix.join(isCoreRelative ? 'cli/lib' : path.posix.dirname(file), module));
        const targetDir = runtimeDirectory(destination);
        if (!targetDir) continue;

        const line = text.slice(0, match.index).split('\n').length;
        const location = `${file}:${line}: ${module}`;
        if (!sourceDir && !factories.has(file)) violations.push(`${location}: rule a: use the runtime factory outside implementations`);
        if (sourceDir && sourceDir !== targetDir) violations.push(`${location}: rule b: runtime implementations cannot reference each other`);
        if (file.startsWith('cli/lib/runtime/shared/')) violations.push(`${location}: rule c: shared runtime code cannot reference implementations`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
