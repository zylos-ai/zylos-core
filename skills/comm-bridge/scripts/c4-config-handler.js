import { composeSessionGroup, parseSessionGroup, validNamespace, validateGroupName, dataError } from './c4-session-group.js';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function validateRequest(kind, request) {
  if (!['runtime', 'model'].includes(kind) || !request || typeof request !== 'object' || Array.isArray(request)) throw dataError('INVALID_ARGS', 'Invalid configuration request');
  const { action } = request;
  if (!['get', 'set', 'reset'].includes(action)) throw dataError('INVALID_ARGS', 'Expected get, set, or reset');
  const allowed = ['action', 'sessionGroup', 'componentName', 'groupName'];
  if (kind === 'model' || action === 'set') allowed.push('runtime');
  if (kind === 'model' && action === 'set') allowed.push('model', 'effort');
  if (Object.keys(request).some(key => !allowed.includes(key))) throw dataError('INVALID_ARGS', 'Unexpected configuration argument');
  if (own(request, 'sessionGroup') === own(request, 'componentName') || (own(request, 'groupName') && !own(request, 'componentName'))) throw dataError('INVALID_ARGS', 'Provide exactly one group or component selector');
  if ((kind === 'model' || action === 'set') && (typeof request.runtime !== 'string' || !request.runtime)) throw dataError('INVALID_ARGS', 'runtime is required');
}

// Pure argv parsing: never opens a DB, reads environment, or resolves a component.
export function parseConfigArgs(kind, argv) {
  const request = { action: argv[0] };
  let json = false;
  const flags = { '--group': 'sessionGroup', '--channel': 'componentName', '--session-group': 'groupName', '--runtime': 'runtime', '--model': 'model', '--effort': 'effort' };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--json') {
      if (json) throw dataError('INVALID_ARGS', 'Duplicate --json');
      json = true; continue;
    }
    const key = flags[flag];
    if (!key || own(request, key) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw dataError('INVALID_ARGS', `Invalid or duplicate argument: ${flag}`);
    request[key] = argv[++index];
  }
  validateRequest(kind, request);
  return { request, json };
}

function validLaunch(value) {
  return value && typeof value.runtime === 'string' && value.runtime.length > 0 &&
    (value.mode === 'default' || (value.mode === 'override' && typeof value.model === 'string' && !!value.model.trim() && typeof value.effort === 'string' && !!value.effort.trim()));
}
function sameLaunch(left, right) {
  return left.runtime === right.runtime && left.mode === right.mode &&
    (left.mode === 'default' || (left.model === right.model && left.effort === right.effort));
}

// Observation is an explicit P02 adapter boundary. identityVerified must prove the
// snapshot/current-session files belong to this run; presence alone is insufficient.
export function classifyConfigRunning({ kind, runtime, sessionMode, resolved, fence, observation }) {
  const running = { runId: typeof observation?.runId === 'string' && observation.runId ? observation.runId : null,
    launchConfig: validLaunch(observation?.launchConfig) ? observation.launchConfig : null, status: 'unknown' };
  if (sessionMode === 'single') running.status = 'single_native';
  else if (kind === 'model' && runtime !== resolved.runtime) running.status = 'other_runtime';
  else if (fence?.reason === 'model_config') running.status = 'pending';
  else if (observation?.hasProcess === false) running.status = 'not_running';
  else if (observation?.hasProcess !== true || observation.identityVerified !== true || typeof observation.ready !== 'boolean' || typeof observation.runId !== 'string' || !observation.runId || !validLaunch(observation.launchConfig)) {
    running.reason = 'Running identity or launch snapshot could not be verified';
  } else if (observation.ready !== true || !sameLaunch(observation.launchConfig, resolved)) running.status = 'pending';
  else running.status = 'applied';
  return running;
}

export function createConfigHandler({ store, validateComponent, readSessionMode, observeRunning }) {
  return function handle(kind, request) {
    validateRequest(kind, request);
    let sessionGroup;
    if (own(request, 'sessionGroup')) {
      sessionGroup = request.sessionGroup;
      if (!parseSessionGroup(sessionGroup)) {
        if (typeof sessionGroup === 'string' && sessionGroup.includes(':')) {
          const colon = sessionGroup.indexOf(':'), namespace = sessionGroup.slice(0, colon), local = sessionGroup.slice(colon + 1);
          if (!validNamespace(namespace)) throw dataError('SESSION_GROUP_INVALID', 'Invalid namespace');
          validateGroupName(local);
        }
        throw dataError('SESSION_GROUP_INVALID', 'Invalid session group');
      }
    } else {
      const name = request.componentName;
      if (typeof name !== 'string' || !name || name.includes('..') || /[/\\\0]/.test(name)) throw dataError('INVALID_ARGS', 'Invalid installed component name');
      try {
        if (typeof validateComponent !== 'function' || validateComponent(name) === false) throw new Error('Component validation unavailable');
      } catch (cause) { throw dataError('INVALID_ARGS', 'Invalid installed component name', { cause }); }
      const binding = store.getChannelNamespace(name);
      if (!binding) throw dataError('SESSION_GROUP_NOT_FOUND', 'Component has no namespace binding');
      if (own(request, 'groupName') && typeof request.groupName !== 'string') throw dataError('SESSION_GROUP_INVALID', 'Invalid local group name');
      sessionGroup = composeSessionGroup(binding.namespace, request.groupName);
    }
    const suffix = kind === 'model' ? 'Model' : 'Runtime';
    const args = { sessionGroup };
    for (const key of ['runtime', 'model', 'effort']) if (own(request, key)) args[key] = request[key];
    // Store owns group existence recheck and writes atomically; no wrapper retry.
    const saved = store[`${request.action}Session${suffix}Config`](args);
    const data = { sessionGroup, ...(kind === 'model' ? { runtime: request.runtime } : {}),
      ...(request.action === 'get' ? { desired: saved } : saved) };
    try {
      const sessionMode = readSessionMode();
      if (!['single', 'multi'].includes(sessionMode)) throw dataError('CONFIG_UNREADABLE', 'Invalid session mode');
      const resolved = store.resolveSessionLaunchConfig({ sessionGroup, sessionMode });
      if (!validLaunch(resolved)) throw dataError('CONFIG_UNREADABLE', 'Invalid resolved launch configuration');
      if (kind === 'runtime') data.resolved = resolved;
      const fence = store.getDrainFence(sessionMode === 'single' ? '*' : sessionGroup);
      const observation = observeRunning({ sessionGroup: sessionMode === 'single' ? 'origin' : sessionGroup, sessionMode });
      data.running = classifyConfigRunning({ kind, runtime: request.runtime, sessionMode, resolved, fence, observation });
    } catch (error) {
      data.running = { runId: null, launchConfig: null, status: 'unknown', reason: error.message, ...(error.code ? { code: error.code } : {}) };
    }
    return { ok: true, data };
  };
}

export async function runConfigCli(kind, argv, io = process) {
  const json = argv.includes('--json');
  try {
    const { request } = parseConfigArgs(kind, argv);
    const store = await import('./c4-db.js');
    const { validateChannel } = await import('./c4-validate.js');
    const handler = createConfigHandler({
      store, validateComponent: name => validateChannel(name, true),
      readSessionMode: () => {
        throw dataError('CONFIG_UNREADABLE', 'Strict F1 reader has not been connected (P03)');
      },
      observeRunning: () => { throw new Error('Running observation adapter has not been connected (P02)'); },
    });
    const result = handler(kind, request);
    io.stdout.write(json ? `${JSON.stringify(result)}\n` : `OK: ${JSON.stringify(result.data)}\n`);
    return 0;
  } catch (error) {
    const result = { ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message, persisted: own(error, 'persisted') ? error.persisted : null } };
    (json ? io.stdout : io.stderr).write(json ? `${JSON.stringify(result)}\n` : `Error [${result.error.code}]: ${error.message}\n`);
    return 1;
  }
}
