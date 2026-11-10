import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SKILLS_DIR } from './c4-config.js';
import { validateGroupName } from './c4-session-group.js';

export { fixedAddressSessionGroup } from './c4-fixed-address.js';

function queryFailure(component, reason, stderr = '') {
  return Object.assign(new Error(`could not ask component "${component}" which thread handles this address (${reason}; stderr: ${stderr})`),
    { code: 'SESSION_GROUP_QUERY_FAILED', reason, stderr });
}

/** Query current component ownership without caching or choosing a failure policy. */
export function queryComponentSessionGroup({ component, endpoint }, { skillsDir = SKILLS_DIR, env = process.env } = {}) {
  if (typeof component !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(component)) {
    throw queryFailure('invalid', 'could not start: invalid component');
  }
  if (endpoint === null) return { groupName: null };
  if (typeof endpoint !== 'string' || endpoint.includes('\0')) throw queryFailure(component, 'could not start: invalid endpoint');
  const componentDir = path.join(skillsDir, component);
  const script = path.join(componentDir, 'scripts', 'session-group.js');
  let exists;
  try { exists = fs.statSync(script, { throwIfNoEntry: false })?.isFile(); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw queryFailure(component, `could not start: ${error.code || 'UNKNOWN'}`);
  }
  if (!exists) return { groupName: null };
  // The bounded child runner keeps stderr truncation independent of stdout's
  // byte limit while exposing a synchronous API to both senders and schedulers.
  const runner = fileURLToPath(new URL('./c4-component-session-group-process.js', import.meta.url));
  let result;
  try {
    result = spawnSync(process.execPath, [runner, script, endpoint], {
      cwd: componentDir, env, input: '', encoding: 'utf8', maxBuffer: 32768, killSignal: 'SIGKILL',
    });
  } catch (error) { throw queryFailure(component, `could not start: ${error.code || 'UNKNOWN'}`); }
  if (result.error || result.status !== 0) throw queryFailure(component, `could not start: ${result.error?.code || result.signal || result.status}`);
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw queryFailure(component, 'could not start: invalid query runner output'); }
  if (response.reason) throw queryFailure(component, response.reason, response.stderr);
  const output = response.output.replace(/\r?\n$/, '');
  if (output === '') return { groupName: null };
  try { validateGroupName(output); }
  catch { throw queryFailure(component, `invalid output ${JSON.stringify(output.slice(0, 64))}`, response.stderr); }
  return { groupName: output };
}
