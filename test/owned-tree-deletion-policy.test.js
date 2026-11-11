import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const implementation = 'skills/comm-bridge/scripts/remove-owned-tree.js';
const exclusions = /(?:^|\/)(?:__tests__|test|tests|fixtures|docs|documentation|node_modules)(?:\/|$)|\.(?:md|markdown|rst)$/i;
// These existing legacy test harnesses own disposable fixtures. This exact list
// does not exempt new files placed in scripts/e2e or other source directories.
const legacyTestHarnesses = new Set([
  'scripts/e2e/issue-443-pm2-restart-semantics.sh',
  'scripts/e2e/issue-452-claude-default-model.sh',
  'scripts/e2e/issue-454-control-supersede.sh',
]);
const permittedBuildLines = new Map([
  // These exact commands run only while building the container image, never on an installed user instance.
  ['    && rm -rf /var/lib/apt/lists/*', 'Remove image-layer package metadata after apt installation.'],
  ['    && rm -rf /tmp/zylos-core \\', 'Remove the temporary source copied into the image after global npm installation.'],
]);
const forbidden = [
  /\brmSync\b/g,
  /\.\s*rm\b/g,
  /\[\s*(['"`])rm\1\s*\]/g,
  /\brm(?:Sync)?\s*\(/g,
  /\[\s*(['"`])rm(?:Sync)?\1\s*\]\s*\(/g,
  /\brimraf\b/g,
  /\brm(?:\s|\\\r?\n)+(?:(?:--?[a-zA-Z-]+)(?:\s|\\\r?\n)+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/g,
  // Literal rm programs are forbidden too; an options variable must not hide recursive flags.
  /\b(?:execFile(?:Sync)?|spawn(?:Sync)?|execa(?:Sync)?)\s*\(\s*(['"`])(?:[^'"`\r\n]*\/)?rm\1\s*(?:,|\))/g,
  /\bshutil\s*\.\s*rmtree\b/g,
  /(['"`])(?:[^'"`\r\n]*\/)?rm\1\s*,\s*\[/g,
  /\bfind(?:\s|\\\r?\n)+[^\n;]*?-delete\b/g,
  /(['"`])(?:[^'"`\r\n]*\/)?find\1\s*,\s*\[[^;]*?['"`]-delete['"`]/g,
];
const directoryRemoval = /\brmdir(?:Sync)?\s*\(|\[\s*(['"`])rmdir(?:Sync)?\1\s*\]\s*\(/g;

// Find a call's actual argument boundary, so a later unrelated recursive mkdir
// cannot make an ordinary empty-directory rmdir appear recursive. This is a
// source-syntax gate, not data-flow analysis of dynamically constructed calls.
function callArguments(source, opening) {
  let depth = 0, quote, start = opening + 1;
  const arguments_ = [];
  for (let index = opening; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      if (end < 0) return [];
      index = end;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return [];
      index = end + 1;
    } else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) {
      if (--depth === 0) return [...arguments_, source.slice(start, index).trim()].filter(Boolean);
    } else if (char === ',' && depth === 1) {
      arguments_.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  return [];
}

function firstViolation(filename, source) {
  const lines = source.split('\n');
  const violationAt = index => {
    const line = source.slice(0, index).split('\n').length;
    const text = lines[line - 1];
    if (filename === 'Dockerfile' && permittedBuildLines.has(text)) return null;
    return { filename, line, text };
  };
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    for (let match; (match = pattern.exec(source));) {
      const violation = violationAt(match.index);
      if (violation) return violation;
    }
  }
  directoryRemoval.lastIndex = 0;
  for (let match; (match = directoryRemoval.exec(source));) {
    const arguments_ = callArguments(source, source.indexOf('(', match.index));
    // Sync calls accept no options at all. Async calls may take only an obvious
    // callback: inline function/arrow, or a callback/cb/done binding. Unknown
    // bindings are conservatively rejected rather than trusting option values.
    if (arguments_.length < 2) continue;
    const callback = /^(?:(?:callback|cb|done)$|(?:async\s+)?function\b|(?:async\s+)?(?:\([^]*?\)|[A-Za-z_$][\w$]*)\s*=>)/.test(arguments_[1]);
    if (/rmdirSync/.test(match[0]) || arguments_.length > 2 || !callback) return violationAt(match.index);
  }
  return null;
}

test('tracked product files use only the shared owned-tree deletion function', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repository, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.includes('cli/lib/group-delete.js'), 'The tracked product-file inventory must not be empty');
  for (const filename of files) {
    if (filename === implementation || legacyTestHarnesses.has(filename) || exclusions.test(filename)) continue;
    const contents = fs.readFileSync(path.join(repository, filename));
    if (contents.includes(0)) continue;
    const violation = firstViolation(filename, contents.toString('utf8'));
    assert.equal(violation, null, violation && `${violation.filename}:${violation.line}: direct removal is forbidden: ${violation.text}`);
  }
});

test('the deletion policy detects ordinary fs, directory, shell and child-program removal syntax', () => {
  for (const source of [
    'fs.rmSync(target, options);', 'rmSync(target);', 'fs.rm(target, options);',
    'fs.promises.rm(target);', 'fs . promises . rm (target);', 'fsp.rm(target);',
    "import { rm } from 'fs/promises'; rm(target, options);", 'promises.rm(target);',
    "fs['rmSync'](target, options);", 'fs["rm"](target, options);', 'rimraf(target);',
    'fs.rmdirSync(target, {recursive:true});', 'await fs.promises.rmdir(target, { recursive: true });',
    'fs.rmdirSync(target, opts);', 'fs.rmdirSync(target, {recursive: !0});',
    'fs.rmdirSync(target, {recursive:false});', 'fs.rmdir(target, opts);',
    'fs.rmdirSync(path.join(root, name), opts);', 'fs.rmdirSync(target, callback);',
    'fs.rmSync.call(fs, target, opts);', 'Reflect.apply(fs.rmSync, fs, args);',
    'const del = fs.rmSync;', 'const del = fs.rm;', 'const del = fs["rm"];',
    "execa('rm', args);", 'shutil.rmtree(target)',
    "fs['rmdirSync'](path.join(root, name), { 'recursive': true });", 'rmdir(target, {recursive:true}, callback);',
    'rm -r target', 'rm -rf target', 'rm -fr target', 'rm -R target', 'rm -f -r target',
    'rm --recursive target', 'rm --force --recursive target', 'rm -f \\\n-r target',
    "execFileSync('rm', ['-rf', target]);", "spawnSync('rm', ['-rf', target]);",
    "spawn('/bin/rm', options);", "run('rm', ['-f', '-r', target]);",
    'find target -type f -delete', "execFileSync('find', [target, '-type', 'f', '-delete']);",
  ]) assert.equal(firstViolation('cli/example.js', source)?.line, 1, source);
  assert.equal(firstViolation('cli/example.js', 'const value = 1;\nfs.rmSync(target);')?.line, 2);
});

test('the deletion policy permits empty-directory removal and scopes image exceptions to exact lines', () => {
  for (const source of [
    'fs.rmdirSync(target);', 'await fs.promises.rmdir(target);', 'rmdir(target, callback);',
    'fs.rmdirSync(target)\nfs.mkdirSync(other, {recursive:true});',
    'fs.rmdirSync(path.join(root, name));', 'fs.rmdir(path.join(root, name), cb);',
    'fs.rmdir(target, done);', 'fs.rmdir(target, (error) => handle(error));',
    'fs.rmdir(target, function(error) { handle(error); });',
    'fs.rmdir(target, async error => handle(error));',
  ]) assert.equal(firstViolation('cli/example.js', source), null, source);
  for (const line of permittedBuildLines.keys()) {
    assert.equal(firstViolation('Dockerfile', line), null);
    assert.ok(firstViolation('cli/example.js', line));
    assert.ok(firstViolation('Dockerfile', `${line} && rm -rf /home/user`));
  }
});
