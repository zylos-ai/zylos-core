import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sendError } from './c4-send-args.js';
import { validateGroupName } from './c4-session-group.js';

export async function queryComponentSessionGroup(channel, endpoint, { skillsDir, env = process.env } = {}) {
  if (endpoint === null) return undefined;
  const componentDir = path.join(skillsDir, channel);
  const script = path.join(componentDir, 'scripts', 'session-group.js');
  let exists;
  try { exists = fs.statSync(script, { throwIfNoEntry: false })?.isFile(); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw queryFailure(`could not start: ${error.code || 'UNKNOWN'}`);
  }
  if (!exists) return undefined;
  function queryFailure(reason, stderr = '') {
    return sendError('SESSION_GROUP_QUERY_FAILED',
      `could not ask component "${channel}" which thread handles this address (${reason}; stderr: ${stderr}). Nothing was sent or recorded. This is a component bug or an environment problem: tell your user the message was not sent and report the error. Do not retry through another thread.`);
  }
  return new Promise((resolve, reject) => {
    let child;
    let reason;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timer;
    try {
      child = spawn('node', [script, endpoint], { cwd: componentDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { reject(queryFailure(`could not start: ${error.code || 'UNKNOWN'}`)); return; }
    const stop = failure => {
      reason ??= failure;
      child.kill('SIGKILL');
      // Descendants may retain these pipes after the direct child has exited.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    timer = setTimeout(() => stop('timed out after 5 s'), 5000);
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.stdout.on('data', chunk => {
      if (reason) return;
      if (stdout.length + chunk.length > 4096) { stop('stdout exceeded 4096 bytes'); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 800) stderr = Buffer.concat([stderr, chunk.subarray(0, 800 - stderr.length)]);
    });
    child.once('error', error => { reason ??= `could not start: ${error.code || 'UNKNOWN'}`; });
    child.once('close', code => {
      clearTimeout(timer);
      const diagnostic = [...stderr.toString('utf8')].slice(0, 200).join('');
      if (reason || code !== 0) { reject(queryFailure(reason || `exit code ${code}`, diagnostic)); return; }
      const output = stdout.toString('utf8').replace(/\r?\n$/, '');
      if (output === '') { resolve(undefined); return; }
      try { validateGroupName(output); }
      catch { reject(queryFailure(`invalid output ${JSON.stringify(output.slice(0, 64))}`, diagnostic)); return; }
      resolve(output);
    });
  });
}
