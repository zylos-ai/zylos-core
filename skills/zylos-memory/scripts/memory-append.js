import fs from 'node:fs';
import path from 'node:path';
import { loadTimezoneFromEnv } from './shared.js';
import { isMain, readInput, runCli } from './sync-cli.js';
import { memoryScope, memoryError, withMemoryLock } from './sync-lock.js';

function timeParts(root, env, now) {
  const timezone = loadTimezoneFromEnv(root, { ...env });
  const parts = new Intl.DateTimeFormat('en-CA', { ...(timezone ? { timeZone: timezone } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// Accept the shell's single trailing line ending, never two physical records.
function inboxText(text) {
  if (typeof text !== 'string') throw memoryError('INVALID_INPUT', 'Inbox body must be text');
  const body = text.replace(/\r?\n$/, '');
  if (!body.trim() || /[\r\n\u0085\u2028\u2029]/u.test(body)) throw memoryError('INVALID_INPUT', 'Inbox body must be one nonempty line');
  return body;
}

function appendRollback(file, build, io, tailOnly = false) {
  const fd = io.openSync(file, 'a+', 0o600);
  let original;
  try {
    original = io.fstatSync(fd).size;
    const tail = Buffer.alloc(1);
    const old = tailOnly
      ? (original && io.readSync(fd, tail, 0, 1, original - 1) ? tail.toString() : '')
      : io.readFileSync(fd, 'utf8');
    const bytes = Buffer.from(build(old));
    let offset = 0;
    while (offset < bytes.length) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw memoryError('IO_ERROR', 'Append made no progress');
      offset += written;
    }
    return bytes.length;
  } catch (error) {
    if (original !== undefined) {
      try { io.ftruncateSync(fd, original); }
      catch (rollback) {
        const failed = memoryError('IO_ERROR', `Append failed and rollback failed: ${rollback.message}`);
        failed.cause = error; throw failed;
      }
    }
    throw error;
  } finally { io.closeSync(fd); }
}

export async function appendInbox({ kind, content, env = process.env, waitMs }, { now = () => new Date(), io = fs } = {}) {
  if (!['commitment', 'decision', 'fact'].includes(kind)) throw memoryError('INVALID_INPUT', 'Invalid inbox kind');
  const body = inboxText(content);
  const scope = await memoryScope(env);
  return withMemoryLock(scope.runDir, () => {
    io.mkdirSync(scope.memoryDir, { recursive: true, mode: 0o700 });
    const { date, time } = timeParts(scope.root, env, now());
    const file = path.join(scope.memoryDir, 'inbox.md');
    const bytes = appendRollback(file, old => {
      const titles = [...old.matchAll(/^### (\d{4}-\d{2}-\d{2})$/gm)];
      const heading = titles.at(-1)?.[1] === date ? '' : `### ${date}\n`;
      return `${old && !old.endsWith('\n') ? '\n' : ''}${heading}- ${time} ${kind}: ${body}\n`;
    }, io);
    return { path: file, bytes };
  }, { waitMs });
}

export async function appendSession({ content, env = process.env, waitMs }, { now = () => new Date(), io = fs } = {}) {
  if (typeof content !== 'string' || !content.trim()) throw memoryError('INVALID_INPUT', 'Session body must be nonempty text');
  const scope = await memoryScope(env);
  return withMemoryLock(scope.runDir, () => {
    const { date } = timeParts(scope.root, env, now());
    const directory = path.join(scope.memoryDir, 'sessions');
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${date}.md`);
    const bytes = appendRollback(file, old => `${old && !old.endsWith('\n') ? '\n' : ''}${content}${content.endsWith('\n') ? '' : '\n'}`, io, true);
    return { path: file, bytes };
  }, { waitMs });
}

if (isMain(import.meta.url)) await runCli(async () => {
  const [command, ...args] = process.argv.slice(2);
  const content = readInput();
  let result;
  if (command === 'inbox' && args.length === 2 && args[0] === '--kind') result = await appendInbox({ kind: args[1], content });
  else if (command === 'session' && args.length === 0) result = await appendSession({ content });
  else throw memoryError('INVALID_INPUT', 'Invalid memory append command');
  process.stdout.write(JSON.stringify(result) + '\n');
});
