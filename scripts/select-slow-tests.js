#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--since' || !args[1] || args[1].startsWith('-')) {
  console.error('Usage: node scripts/select-slow-tests.js --since <git-ref>');
  process.exit(1);
}

try {
  const git = args => execFileSync('git', args, { encoding: 'utf8' });
  const root = git(['rev-parse', '--show-toplevel']).trim();
  // Resolve refs before diff so a path cannot silently be treated as a ref.
  const since = git(['rev-parse', '--verify', `${args[1]}^{commit}`]).trim();
  const changed = git(['-C', root, 'diff', '--name-only', '--no-renames', '-z', since, '--']).split('\0').filter(Boolean);
  const files = git(['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.slow.test.js']).split('\0').filter(Boolean);
  const selected = [];
  for (const file of [...new Set(files)].sort()) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const header = fs.readFileSync(path.join(root, file), 'utf8').split('\n', 1)[0];
    const covers = header.match(/^\/\/ covers:\s*(\S.*)$/)?.[1].trim().split(/\s+/);
    if (!covers?.length) throw new Error(`Missing covers header: ${file}`);
    if (changed.includes(file) || covers.some(source => changed.some(changedPath => {
      const prefix = source.replace(/\/$/, '');
      return changedPath === prefix || changedPath.startsWith(`${prefix}/`);
    }))) selected.push(file);
  }
  if (selected.length) process.stdout.write(`${selected.join('\n')}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
