#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourcePaths = ['templates/ZYLOS.md', 'templates/CLAUDE.md'];

export function exportInstructionBaselines({
  repoRoot,
  outputPath = path.join(repoRoot, 'data', 'instruction-baselines', 'manifest.json'),
  exec = execFileSync,
} = {}) {
  function git(args, options = {}) {
    return exec('git', args, { cwd: repoRoot, encoding: options.encoding ?? 'utf8' });
  }

  const commits = git(['rev-list', '--all']).trim().split('\n').filter(Boolean);
  let priorEntries = [];
  try { priorEntries = JSON.parse(fs.readFileSync(outputPath, 'utf8')).entries ?? []; } catch {}
  const byBlob = new Map(priorEntries.map(entry => [entry.gitBlob, structuredClone(entry)]));
  for (const commit of commits) {
    for (const sourcePath of sourcePaths) {
      let line;
      try {
        line = git(['ls-tree', commit, '--', sourcePath]).trim();
      } catch {
        continue;
      }
      if (!line) continue;
      const match = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
      if (!match) continue;
      const [, gitBlob, discoveredPath] = match;
      const existing = byBlob.get(gitBlob);
      if (existing) {
        if (!existing.paths.includes(discoveredPath)) existing.paths.push(discoveredPath);
        existing.paths.sort();
        continue;
      }
      const content = exec('git', ['cat-file', 'blob', gitBlob], { cwd: repoRoot });
      const tags = git(['tag', '--points-at', commit]).trim().split('\n').filter(Boolean).sort();
      byBlob.set(gitBlob, {
        gitBlob,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        paths: [discoveredPath],
        sourceCommit: commit,
        sourceTags: tags,
        contentBase64: content.toString('base64'),
      });
    }
  }

  const entries = [...byBlob.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify({ schemaVersion: 1, entries }, null, 2) + '\n');
  return { outputPath, entries };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = exportInstructionBaselines({ repoRoot });
  console.log(`wrote ${result.entries.length} distinct reachable instruction blobs to ${result.outputPath}`);
}
