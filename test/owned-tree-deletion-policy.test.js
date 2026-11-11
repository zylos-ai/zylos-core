import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const implementation = 'skills/comm-bridge/scripts/remove-owned-tree.js';
// scripts/e2e contains legacy test harnesses, not installed product entry points.
const exclusions = /^scripts\/e2e\/|(?:^|\/)(?:__tests__|test|tests|fixtures|docs|documentation|node_modules)(?:\/|$)|\.(?:md|markdown|rst|txt|pdf|docx?)$/i;
const permittedBuildLines = new Map([
  // These exact commands run only while building the container image, never on an installed user instance.
  ['    && rm -rf /var/lib/apt/lists/*', 'Remove image-layer package metadata after apt installation.'],
  ['    && rm -rf /tmp/zylos-core \\', 'Remove the temporary source copied into the image after global npm installation.'],
]);
const forbidden = /\brmSync\s*\(|\bfs\s*\.\s*(?:promises\s*\.\s*)?rm\s*\(|\brimraf\b|\brm(?:\s|\\\r?\n)+-[a-zA-Z]*[rR][a-zA-Z]*\b/g;

function firstViolation(filename, source) {
  forbidden.lastIndex = 0;
  for (let match; (match = forbidden.exec(source));) {
    const line = source.slice(0, match.index).split('\n').length;
    const text = source.split('\n')[line - 1];
    if (filename === 'Dockerfile' && permittedBuildLines.has(text)) continue;
    return { filename, line, text };
  }
  return null;
}

test('tracked product files use only the shared owned-tree deletion function', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repository, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.includes('cli/lib/group-delete.js'), 'The tracked product-file inventory must not be empty');
  for (const filename of files) {
    if (filename === implementation || exclusions.test(filename)) continue;
    const contents = fs.readFileSync(path.join(repository, filename));
    if (contents.includes(0)) continue;
    const violation = firstViolation(filename, contents.toString('utf8'));
    assert.equal(violation, null, violation && `${violation.filename}:${violation.line}: direct removal is forbidden: ${violation.text}`);
  }
});

test('the deletion policy checks calls regardless of options and scopes image exceptions to exact lines', () => {
  for (const source of [
    'fs.rmSync(target, options);', 'rmSync(target);', 'fs.rm(target, options);',
    'fs.promises.rm(target);', 'fs . promises . rm (target);', 'rimraf(target);',
    'rm -r target', 'rm -rf target', 'rm -fr target', 'rm -R target',
  ]) assert.equal(firstViolation('cli/example.js', source)?.line, 1, source);
  assert.equal(firstViolation('cli/example.js', 'const value = 1;\nfs.rmSync(target);')?.line, 2);
  for (const line of permittedBuildLines.keys()) {
    assert.equal(firstViolation('Dockerfile', line), null);
    assert.ok(firstViolation('cli/example.js', line));
    assert.ok(firstViolation('Dockerfile', `${line} && rm -rf /home/user`));
  }
});
