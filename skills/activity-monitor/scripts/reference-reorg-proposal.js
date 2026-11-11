import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Record the question time before the caller queues a proposal. No Sync dependency. */
export function prepareReferenceReorg({ root, now = Date.now(), io = fs }) {
  const memory = path.join(root, 'memory');
  const oldExists = name => {
    try { io.statSync(path.join(memory, 'reference', name)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (!oldExists('projects.md') && !oldExists('decisions.md')) return false;
  const target = path.join(memory, 'reference-reorg-state.json');
  let state;
  try { state = JSON.parse(io.readFileSync(target, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const lastAskedAt = typeof state?.lastAskedAt === 'string' ? Date.parse(state.lastAskedAt) : NaN;
  if (Number.isFinite(lastAskedAt) && now - lastAskedAt < INTERVAL_MS) return false;
  const temporary = path.join(memory, `.reference-reorg-state.${randomBytes(16).toString('hex')}.tmp`);
  try {
    io.writeFileSync(temporary, JSON.stringify({ lastAskedAt: new Date(now).toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    io.renameSync(temporary, target);
  } finally {
    try { io.unlinkSync(temporary); } catch {}
  }
  return true;
}
