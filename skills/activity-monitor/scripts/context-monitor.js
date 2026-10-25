#!/usr/bin/env node
import { loadCoreModule } from './core-modules.js';
/** Publish the native statusLine sample with its producing run identity. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { runDirFromEnv, RUN_FILES, hookErrorLogPath } = await loadCoreModule('session-group-paths.js');

export function publishContextSample(raw, { env = process.env, now = Date.now() } = {}) {
  const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('Invalid statusLine sample');
  const location = runDirFromEnv(env);
  const sample = { ...status, zylos: { v: 1, runId: env.ZYLOS_RUN_ID || null, capturedAt: now } };
  fs.mkdirSync(location.dir, { recursive: true });
  const file = path.join(location.dir, RUN_FILES.STATUSLINE);
  const temporary = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(sample));
  fs.renameSync(temporary, file);
  return sample;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try { if (input.trim()) publishContextSample(input); }
    catch (error) {
      try { fs.appendFileSync(hookErrorLogPath(), `${new Date().toISOString()} statusline: invalid sample or publication failure\n`); } catch {}
    }
  });
}
