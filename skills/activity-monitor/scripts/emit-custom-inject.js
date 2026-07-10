/**
 * Custom-inject shard emitter (chain position 2, right after identity).
 *
 * Injects deployment/user-provided standing directives at session start.
 * The content source is a plain directory the user (or an installing
 * platform) edits directly — no config file, no registration, no restart:
 *
 *   ~/zylos/custom-inject/*.md
 *
 * - Files concatenate in lexicographic filename order (conf.d style:
 *   `10-rules.md`, `20-platform.md`, ... to control ordering).
 * - Dotfiles and non-.md entries are ignored.
 * - A missing directory, no .md files, or all-empty content emits nothing
 *   — the shard's [k/N] header still goes out, so the chain and numbering
 *   are unaffected (same empty semantics as the other content shards).
 * - Content is injected as-is (it is user-authored instruction text); the
 *   orchestrator adds the numbered shard header and enforces the budget
 *   (tail-trim + full-text spill) like any other shard.
 *
 * Security boundary: users supply CONTENT, never code — this emitter is
 * fixed core code and only ever reads markdown text from the directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function customInjectDir(env = process.env) {
  const zylosDir = path.resolve(env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  return path.join(zylosDir, 'custom-inject');
}

export function emitCustomInject({ env = process.env } = {}) {
  const dir = customInjectDir(env);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // Directory absent (fresh installs have none) — nothing to inject.
    return '';
  }

  const files = entries
    .filter(name => name.endsWith('.md') && !name.startsWith('.'))
    .sort();

  const parts = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      // Unreadable file: skip it — a bad file must not break session start.
      continue;
    }
    const trimmed = content.trim();
    if (trimmed) parts.push(trimmed);
  }

  return parts.join('\n\n');
}
