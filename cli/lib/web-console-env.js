import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PASSWORD_KEYS = new Set(['ZYLOS_WEB_PASSWORD', 'WEB_CONSOLE_PASSWORD']);
const OLD_UPLOAD = 'WEB_CONSOLE_MAX_UPLOAD_MB';
const NEW_UPLOAD = 'DASHBOARD_MAX_UPLOAD_MB';
const INVOLVED = new Set([...PASSWORD_KEYS, OLD_UPLOAD, NEW_UPLOAD]);
const hasClosingQuote = (value, quote) => {
  for (let index = 1; index < value.length; index++) {
    if (value[index] === quote && value[index - 1] !== '\\') return true;
  }
  return false;
};

// Keep each terminator attached to its line so untouched bytes survive exactly.
export function planWebConsoleEnvCleanup(content) {
  const lines = content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  const assignments = [];
  let continuedQuote = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/(?:\r\n|\n|\r)$/, '');
    if (continuedQuote) {
      if (hasClosingQuote(continuedQuote + line, continuedQuote)) continuedQuote = null;
      continue;
    }
    const match = line.match(/^(\s*(?:export\s+)?)([\w.-]+)(\s*=\s*|:\s+)(.*)$/);
    if (!match) continue;
    const [, prefix, key, , value] = match;
    const quote = ['"', "'", '`'].includes(value[0]) ? value[0] : null;
    const multiline = quote && !hasClosingQuote(value, quote);
    if (multiline) continuedQuote = quote;
    if (INVOLVED.has(key)) assignments.push({index, key, prefix, multiline});
  }
  if (continuedQuote || assignments.some(row => row.multiline)) return {state:'manual'};
  const passwords = assignments.filter(row => PASSWORD_KEYS.has(row.key));
  const old = assignments.filter(row => row.key === OLD_UPLOAD);
  const hasNew = assignments.some(row => row.key === NEW_UPLOAD);
  const removed = new Set([...passwords, ...old].map(row => row.index));
  if (old.length && !hasNew) {
    const last = old.at(-1);
    removed.delete(last.index);
    lines[last.index] = lines[last.index].slice(0, last.prefix.length) + NEW_UPLOAD +
      lines[last.index].slice(last.prefix.length + OLD_UPLOAD.length);
  }
  const next = lines.filter((_, index) => !removed.has(index)).join('');
  const messages = [];
  if (passwords.length) messages.push(`Removed Web Console passwords from .env (${passwords.length} lines).`);
  if (old.length) messages.push(hasNew
    ? `Kept DASHBOARD_MAX_UPLOAD_MB and removed WEB_CONSOLE_MAX_UPLOAD_MB (${old.length} lines).`
    : 'Renamed WEB_CONSOLE_MAX_UPLOAD_MB to DASHBOARD_MAX_UPLOAD_MB.');
  return {state:next === content ? 'skipped' : 'changed', content:next, messages};
}

export function atomicReplace(file, content, {beforeRename = () => {}} = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Expected a regular file');
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', stat.mode & 0o7777);
    fs.fchownSync(fd, stat.uid, stat.gid);
    fs.fchmodSync(fd, stat.mode & 0o7777);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    beforeRename(temp);
    const current = fs.lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.size !== stat.size) throw Error('File changed during cleanup');
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function cleanupWebConsoleEnv(zylosDir) {
  const file = path.join(zylosDir, '.env');
  const manual = {state:'manual', messages:[
    'Review .env manually: remove ZYLOS_WEB_PASSWORD and WEB_CONSOLE_PASSWORD assignments and rename WEB_CONSOLE_MAX_UPLOAD_MB to DASHBOARD_MAX_UPLOAD_MB; the file was left unchanged.',
  ]};
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return manual;
    const plan = planWebConsoleEnvCleanup(fs.readFileSync(file, 'utf8'));
    if (plan.state === 'manual') return manual;
    if (plan.state === 'changed') atomicReplace(file, plan.content);
    return {state:plan.state, messages:plan.messages};
  } catch (error) {
    if (error.code === 'ENOENT') return {state:'skipped', messages:[]};
    // Filesystem/parser errors must never include dotenv values.
    return manual;
  }
}
