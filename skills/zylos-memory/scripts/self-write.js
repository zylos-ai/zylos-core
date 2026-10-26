#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { memoryError } from './sync-lock.js';
import { inputError } from './sync-cli.js';

export const isSelfPath = relative => relative === 'identity.md' || relative === 'references.md' || /^(reference|users)\/.+/.test(relative);
const inside = (base, target) => target === base || target.startsWith(base + path.sep);
function actualPath(target) {
  const missing = [];
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw memoryError('PATH_NOT_ALLOWED', 'Path has no existing ancestor');
    // A dangling symlink must not be interpreted as a nonexistent regular file.
    try { if (fs.lstatSync(existing).isSymbolicLink()) throw memoryError('PATH_NOT_ALLOWED', 'Dangling symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    missing.unshift(path.basename(existing)); existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

/** Check both lexical and resolved destinations, including every existing parent. */
export function resolveAllowedMemoryPath({ root, path: requested, allowed = isSelfPath }) {
  if (typeof requested !== 'string' || !requested || requested.includes('\0') || path.isAbsolute(requested)) throw memoryError('PATH_NOT_ALLOWED', 'Expected a relative memory path');
  const base = path.resolve(root, 'memory'), target = path.resolve(base, requested);
  const relative = path.relative(base, target).split(path.sep).join('/');
  const permits = typeof allowed === 'function' ? allowed : candidate => allowed.includes(candidate);
  if (!inside(base, target) || !permits(relative)) throw memoryError('PATH_NOT_ALLOWED', 'Memory path is not allowed');
  const actualBase = actualPath(base), actual = actualPath(target);
  const actualRelative = path.relative(actualBase, actual).split(path.sep).join('/');
  if (!inside(actualBase, actual) || !permits(actualRelative)) throw memoryError('PATH_NOT_ALLOWED', 'Resolved memory path is not allowed');
  return { target: actual, path: relative };
}

/** Caller owns F8 and authorization. Only this fragment is changed. */
export function applyFragmentLocked({ target, expected, replacement }) {
  if (!(expected === null || typeof expected === 'string') || typeof replacement !== 'string') throw inputError('Expected a string replacement and string/null expected fragment');
  let old = null;
  try { old = fs.readFileSync(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let next;
  if (expected === null) {
    if (old !== null) throw memoryError('EXISTS', 'Target already exists');
    next = replacement;
  } else {
    if (old === null || (expected === '' && old !== '')) throw memoryError('FRAGMENT_CONFLICT', 'Expected fragment does not match the target');
    if (expected === '') next = replacement;
    else {
      const first = old.indexOf(expected);
      if (first < 0 || old.indexOf(expected, first + 1) >= 0) throw memoryError('FRAGMENT_CONFLICT', 'Expected fragment must match exactly once');
      next = old.slice(0, first) + replacement + old.slice(first + expected.length);
    }
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(16).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, next, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (expected === null) {
      try { fs.linkSync(temporary, target); }
      catch (error) { if (error.code === 'EEXIST') throw memoryError('EXISTS', 'Target already exists'); throw error; }
    } else fs.renameSync(temporary, target);
  } catch (error) {
    if (error.code === 'EXISTS') throw error;
    throw memoryError('WRITE_FAILED', 'Memory write failed');
  } finally {
    // Publication is final: cleanup must neither turn success into failure nor mask a write error.
    try { fs.unlinkSync(temporary); } catch {}
  }
  return { bytes: Buffer.byteLength(next) };
}
