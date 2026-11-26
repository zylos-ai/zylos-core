import fs from 'node:fs';
import path from 'node:path';
import { resolveAllowedMemoryPath } from './self-write.js';

const string = { type: 'string' };
const positive = { type: 'integer', minimum: 1 };
const tool = (name, description, properties, required) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export const DREAM_READ_TOOLS = [
  tool('read_memory', 'Read up to 200 numbered lines from a file in the memory directory.', {
    path: string, start_line: positive, lines: positive,
  }, ['path']),
  tool('grep_memory', 'Find a literal phrase in memory files and return matching paths and line numbers.', {
    query: string, path: string,
  }, ['query']),
  tool('glob_memory', 'List memory files matching a path glob such as reference/**/*.md.', {
    pattern: string,
  }, ['pattern']),
];

const allowed = relative => relative === '' || relative.split('/').every(part => part && !part.startsWith('.'));
const maxMatches = 100;
const maxLine = 4000;

export function readDreamTool(root, name, input) {
  const resolve = requested => resolveAllowedMemoryPath({ root, path: requested, allowed }).target;
  const base = resolve('.');
  const relative = target => path.relative(base, target).split(path.sep).join('/');
  function* files(target) {
    if (fs.statSync(target).isFile()) { yield target; return; }
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = path.join(target, entry.name);
      if (entry.isFile()) yield child;
      else if (entry.isDirectory()) yield* files(child);
    }
  }
  const numbered = (lines, index) => `${index + 1}: ${lines[index].slice(0, maxLine)}`;
  if (name === 'read_memory') {
    const { path: requested, start_line: start = 1, lines: count = 100 } = input;
    if (![start, count].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid line range');
    const target = resolve(requested);
    if (!fs.statSync(target).isFile()) throw new Error('Expected a regular memory file');
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
    return lines.slice(start - 1, start - 1 + Math.min(count, 200)).map((_, i) => numbered(lines, start - 1 + i)).join('\n');
  }
  if (name === 'glob_memory' && typeof input.pattern !== 'string') throw new Error('A glob pattern is required');
  if (name === 'grep_memory' && (typeof input.query !== 'string' || !input.query)) throw new Error('A search phrase is required');
  const results = [];
  for (const target of files(name === 'glob_memory' ? base : resolve(input.path ?? '.'))) {
    if (name === 'glob_memory') {
      if (path.matchesGlob(relative(target), input.pattern)) results.push(relative(target));
    } else {
      const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxMatches; index++) {
        if (lines[index].toLowerCase().includes(input.query.toLowerCase())) results.push(`${relative(target)}:${numbered(lines, index)}`);
      }
    }
    if (results.length === maxMatches) break;
  }
  return results.join('\n');
}
