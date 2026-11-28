#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { candidatePages } from '../skills/zylos-memory/scripts/dream-pages.js';
import { readReferenceIndex } from '../skills/zylos-memory/scripts/reference-index.js';
import { removeOwnedTree } from '../skills/comm-bridge/scripts/remove-owned-tree.js';

const KINDS = ['projects', 'decisions'];
const REFERENCE_DIRS = KINDS.map(kind => `reference/${kind}`);
const USAGE = 'Usage: node scripts/measure-dream-candidates.js <memory-repo> [--since YYYY-MM-DD]';

function* addedLines(diff) {
  let relative;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      relative = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      relative = /^\+\+\+ b\/(reference\/(?:projects|decisions)\/(?!INDEX\.md$)[^/]+\.md)$/.exec(line)?.[1];
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (relative && inHunk && line.startsWith('+')) {
      const text = line.slice(1).trim();
      if (text.length >= 30 && !/^(?:#|<!--|-\s+\*\*(?:Status|Updated|Keys|Scope|Created):\*\*)/.test(text)) {
        yield { relative, text };
      }
    }
  }
}

function measure(repo, since) {
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const history = git('log', '--full-history', '--format=%H %P', `--since-as-filter=${since}`, '--', ...REFERENCE_DIRS);
  let commits = 0, items = 0, inTop4 = 0, top1 = 0, none = 0, elapsed = 0;
  for (const entry of history.trim().split('\n')) {
    const [commit, parent] = entry.split(' ');
    if (!parent) continue;
    commits++;
    // Modified files already existed at the same path in the first parent.
    const diff = git('diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=M', parent, commit, '--', ...REFERENCE_DIRS);
    const additions = [...addedLines(diff)];
    if (additions.length === 0) continue;

    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'dream-candidates-'));
    try {
      const archive = path.join(root, 'reference.tar');
      const memory = path.join(root, 'memory');
      fs.mkdirSync(memory);
      git('archive', '--format=tar', `--output=${archive}`, parent, 'reference');
      execFileSync('tar', ['-xf', archive, '-C', memory]);
      const pages = KINDS.flatMap(kind => readReferenceIndex(root, kind).pages.map(({ file }) => {
        const relative = `reference/${kind}/${file}`;
        return { relative, text: fs.readFileSync(path.join(memory, relative), 'utf8') };
      }));
      const findCandidates = candidatePages(pages);
      for (const { relative, text } of additions) {
        if (!fs.lstatSync(path.join(memory, relative), { throwIfNoEntry: false })?.isFile()) continue;
        const item = { topic: '', text, source: '' };
        const start = performance.now();
        const candidates = findCandidates(item);
        elapsed += performance.now() - start;
        const paths = candidates.map(candidate => candidate.split(' (', 1)[0]);
        if (paths.includes(relative)) inTop4++;
        if (paths[0] === relative) top1++;
        if (paths.length === 0) none++;
        items++;
      }
    } finally {
      removeOwnedTree(temporaryRoot, root);
    }
  }

  const average = total => items === 0 ? 0 : Number((total / items).toFixed(3));
  return { commits, items, inTop4: average(inTop4), top1: average(top1), none: average(none), msPerItem: average(elapsed) };
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { since: { type: 'string' } },
  });
  if (positionals.length !== 1) throw new Error(USAGE);
  const date = values.since;
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date)) {
    throw new Error(USAGE);
  }
  const since = date === undefined ? '14 days ago' : `${date}T00:00:00`;
  console.log(JSON.stringify(measure(positionals[0], since)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
