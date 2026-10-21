#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getClaudePid } from './claude-pid.js';
import { readHealthQuota, sanitizeHealthQuota } from './health-quota.js';
import { matchHealthNoticeText } from './health-notice-match.js';
import { sanitizeNoticeMatch } from './health-notice-classification.js';
import { durableJson, readRuntimeGeneration, readProcessStart, runtimeRoot, syncDirectory } from './runtime-generation.js';

const EVENTS = { SessionStart: 'session_start', UserPromptSubmit: 'prompt_submit', StopFailure: 'stop_failure', Stop: 'stop' };
export const HEALTH_INBOX_SOFT_LIMIT = 1000;
const ERRORS = new Set(['rate_limit', 'authentication_failed', 'billing_error', 'overloaded', 'server_error', 'model_not_found']);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
function recoverInterruptedWrites(directory, limit) {
  const names=fs.readdirSync(directory);
  let count=names.filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)).length;
  const keys=new Set(['schema_version','event_id','source','runtime','runtime_generation','session_id','prompt_id','event','error','received_at','claude_pid','process_start','notice_match','quota']);
  for(const name of names) {
    const match=name.match(/^([0-9a-f-]{36})(?:\.json\.[0-9a-f-]{36}\.tmp|\.[0-9a-f-]{36}\.staged(?:\.[0-9a-f-]{36}\.tmp)?)$/);
    if(!match)continue;
    const orphan=path.join(directory,name);
    let valid=false;
    try {
      const stat=fs.lstatSync(orphan);
      if(stat.isFile()&&stat.size<=8192) {
        const value=JSON.parse(fs.readFileSync(orphan,'utf8'));
        valid=value?.schema_version===1&&value.event_id===match[1]&&value.source==='hook'&&value.runtime==='claude'&&Object.keys(value).every(key=>keys.has(key));
        if(valid&&value.notice_match!==undefined)valid=JSON.stringify(value.notice_match)===JSON.stringify(sanitizeNoticeMatch(value.notice_match));
        if(valid&&value.quota!==undefined)valid=JSON.stringify(value.quota)===JSON.stringify(sanitizeHealthQuota(value.quota,{identity:value,nowMs:value.received_at}));
      }
    } catch { /* An incomplete writer-owned temporary is not an event. */ }
    const final=path.join(directory,`${match[1]}.json`);
    if(valid&&!fs.existsSync(final)) {
      if(count>=limit) { count++; continue; }
      const fd=fs.openSync(orphan,'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(orphan,final);
      count++;
    } else fs.unlinkSync(orphan);
    syncDirectory(directory);
  }
  return count;
}
export function collectHealthHook(payload, {
  zylosDir = runtimeRoot(), env = process.env, nowMs = Date.now(),
  pid = getClaudePid(), processStart = readProcessStart(pid), inboxLimit = HEALTH_INBOX_SOFT_LIMIT,
} = {}) {
  if (!payload || payload.agent_id || !EVENTS[payload.hook_event_name]) return null;
  const identity = readRuntimeGeneration(zylosDir);
  if (!identity || identity.runtime !== 'claude' || env.ZYLOS_RUNTIME_ID !== 'claude' || env.ZYLOS_RUNTIME_GENERATION !== identity.runtime_generation) return null;
  const session = identifier(payload.session_id);
  if (!session || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (payload.hook_event_name === 'StopFailure' && !identifier(payload.error)) return null;
  const error = payload.hook_event_name === 'StopFailure' ? (ERRORS.has(payload.error) ? payload.error : 'unknown') : null;
  const event = {
    schema_version: 1, event_id: randomUUID(), source: 'hook', runtime: 'claude',
    runtime_generation: identity.runtime_generation, session_id: session,
    prompt_id: identifier(payload.prompt_id), event: EVENTS[payload.hook_event_name],
    error, received_at: nowMs, claude_pid: pid, process_start: processStart,
  };
  if (event.event === 'stop_failure') {
    const match = matchHealthNoticeText(payload);
    if (match) event.notice_match = match;
    const quota = readHealthQuota({ identity:event, zylosDir, nowMs });
    if (quota) event.quota = quota;
  }
  const directory = path.join(zylosDir, 'activity-monitor', 'health-inbox');
  if(fs.mkdirSync(directory, { recursive: true, mode: 0o700 }))syncDirectory(path.dirname(directory));
  // Equal terminal identities coalesce without replacing an earlier pending copy.
  if (event.prompt_id) {
    const hash = createHash('sha256').update(JSON.stringify([event.runtime_generation,event.session_id,event.prompt_id,event.event,event.error,event.process_start])).digest('hex');
    event.event_id = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
  }
  const file = path.join(directory, `${event.event_id}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const lock = path.join(directory, '.admission');
  const lockFd = fs.openSync(lock, 'a', 0o600);
  try {
    // flock locks the shared open-file description. The parent retains it after
    // this bounded helper exits; closing/crashing releases it in the kernel.
    execFileSync('flock', ['-n', '3'], {stdio:['ignore','ignore','pipe',lockFd],timeout:1000});
  } catch {
    fs.closeSync(lockFd);
    durableJson(path.join(zylosDir,'activity-monitor','health-inbox-overflow.json'), {schema_version:1,observed_at:nowMs,reason:'health_inbox_admission_busy',event_lost:true});
    throw new Error('Health inbox admission busy; event not persisted');
  }
  try {
    const pendingCount=recoverInterruptedWrites(directory,inboxLimit);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pendingCount >= inboxLimit) {
      durableJson(path.join(zylosDir, 'activity-monitor', 'health-inbox-overflow.json'), { schema_version:1, observed_at:nowMs, reason:'health_inbox_capacity', event_lost:true });
      throw new Error('Health inbox capacity reached; event not persisted');
    }
    durableJson(file, event);
  } finally {
    fs.closeSync(lockFd);
  }
  return event;
}
export function readHealthInbox({ zylosDir = runtimeRoot(), limit = 100 } = {}) {
  const directory = path.join(zylosDir, 'activity-monitor', 'health-inbox');
  let names;
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).slice(0, Math.max(1, Math.min(1000, limit))).map((name) => {
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 8192) return { file, event: null, error: 'invalid_spool' };
      return { file, event: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch { return { file, event: null, error: 'invalid_spool' }; }
  });
}
export function acknowledgeHealthEvent(file, { zylosDir = runtimeRoot() } = {}) {
  const directory = path.join(zylosDir, 'activity-monitor', 'health-inbox');
  if (path.dirname(file) !== directory || !/^[0-9a-f-]{36}\.json$/.test(path.basename(file))) throw new Error('Invalid spool path');
  fs.unlinkSync(file);
  syncDirectory(directory);
}
export function wakeHealthMonitor({ zylosDir = runtimeRoot(), timeoutMs = 150 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection(path.join(zylosDir, 'activity-monitor', 'am.sock'));
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('connect', () => socket.end(`${JSON.stringify({ version: 1, type: 'health_events_ready', requestId: randomUUID() })}\n`));
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.resume();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Prompt bodies can be large. Bound stdin without ever persisting its contents.
  let input = '', bytes = 0, oversized = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4 * 1024 * 1024) { oversized = true; input = ''; } else if (!oversized) input += chunk;
  });
  process.stdin.on('end', async () => {
    try {
      if (oversized) throw new Error('oversized');
      const event = collectHealthHook(JSON.parse(input || '{}'));
      if (event) await wakeHealthMonitor();
    } catch {
      // Fail open for Claude, but never claim a failed write was delivered.
      process.stderr.write('Zylos health hook: event could not be persisted; health evidence is incomplete, screen fallback remains available.\n');
    }
  });
}
