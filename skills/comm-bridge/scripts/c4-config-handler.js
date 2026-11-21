import { composeSessionGroup, parseSessionGroup, validNamespace, validateGroupName, dataError } from './c4-session-group.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function validateRequest(kind, request) {
  if (!['runtime', 'model'].includes(kind) || !request || typeof request !== 'object' || Array.isArray(request)) throw dataError('INVALID_ARGS', 'Invalid configuration request');
  const { action } = request;
  if (!['get', 'set', 'reset'].includes(action)) throw dataError('INVALID_ARGS', 'Expected get, set, or reset');
  const allowed = ['action', 'sessionGroup', 'componentName', 'groupName'];
  if (action !== 'get') allowed.push('yes', 'expectedRunId');
  if (own(request, 'yes') && request.yes !== true) throw dataError('INVALID_ARGS', 'Invalid confirmation');
  if (own(request, 'expectedRunId') && (!request.yes || typeof request.expectedRunId !== 'string' || !request.expectedRunId)) {
    throw dataError('INVALID_ARGS', 'A run binding requires --yes');
  }
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
  const flags = { '--group': 'sessionGroup', '--channel': 'componentName', '--session-group': 'groupName', '--runtime': 'runtime', '--model': 'model', '--effort': 'effort', '--expected-run': 'expectedRunId' };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--json') {
      if (json) throw dataError('INVALID_ARGS', 'Duplicate --json');
      json = true; continue;
    }
    if (flag === '--yes') {
      if (own(request, 'yes')) throw dataError('INVALID_ARGS', 'Duplicate --yes');
      request.yes = true;
      continue;
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

// Observation is an explicit runtime-adapter boundary. identityVerified must prove the
// snapshot/current-session files belong to this run; presence alone is insufficient.
// running is null for a pre-migration instance (sessionMode null), for any group
// but origin in native single, and for a model query of a non-current runtime.
function configRunningApplies({ kind, runtime, sessionGroup, sessionMode, resolved }) {
  if (sessionMode !== 'multi' && !(sessionMode === 'single' && sessionGroup === 'origin')) return false;
  return !(kind === 'model' && runtime !== resolved.runtime);
}

export function classifyConfigRunning({ kind, runtime, sessionGroup, sessionMode, resolved, fence, observation }) {
  if (!configRunningApplies({ kind, runtime, sessionGroup, sessionMode, resolved })) return null;
  const running = { runId: typeof observation?.runId === 'string' && observation.runId ? observation.runId : null,
    launchConfig: validLaunch(observation?.launchConfig) ? observation.launchConfig : null, status: 'unknown' };
  if (fence?.reason === 'model_config') running.status = 'pending';
  else if (observation?.hasProcess === false) running.status = 'not_running';
  else if (observation?.hasProcess !== true || observation.identityVerified !== true || typeof observation.ready !== 'boolean' || typeof observation.runId !== 'string' || !observation.runId || !validLaunch(observation.launchConfig)) {
    running.reason = 'Running identity or launch snapshot could not be verified';
  } else if (observation.ready !== true || !sameLaunch(observation.launchConfig, resolved)) running.status = 'pending';
  else running.status = 'applied';
  return running;
}

export function createConfigHandler({ store, validateComponent, readSessionMode, observeRunning, restart }) {
  return async function handle(kind, request) {
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
    let target;
    if (restart && request.action !== 'get') {
      let active = true, observation, observationError;
      try {
        const sessionMode = readSessionMode();
        if (![null, 'single', 'multi'].includes(sessionMode)) throw dataError('CONFIG_UNREADABLE', 'Invalid session mode');
        active = sessionMode === 'multi' || sessionMode === 'single' && sessionGroup === 'origin';
        if (active) observation = await observeRunning({ sessionGroup, sessionMode });
      } catch (error) { observationError = error; }
      if (active) args.beforeRestartingChange = () => {
        if (observation?.hasProcess === false && !request.expectedRunId) return;
        if (!request.yes) {
          const code = observation?.hasProcess === true ? 'CONFIRMATION_REQUIRED' : 'RUNNING_STATE_UNKNOWN';
          const message = observation?.hasProcess === true ? `This change will interrupt ${sessionGroup}.`
            : `Could not verify whether ${sessionGroup} is running.`;
          throw dataError(code, message);
        }
        const runId = request.expectedRunId ?? (observation?.identityVerified ? observation.runId : null);
        target = { sessionGroup, runId, ...(observationError && { error: observationError }) };
      };
    }
    // Store owns group existence recheck and writes atomically; no wrapper retry.
    const saved = store[`${request.action}Session${suffix}Config`](args);
    const data = { sessionGroup, sessionMode: null, resolved: null, ...(kind === 'model' ? { runtime: request.runtime } : {}),
      ...(request.action === 'get' ? { desired: saved } : saved) };
    if (target) data.restart = target.error && !target.runId
      ? { status: 'not_restarted', reason: target.error.code ?? target.error.message }
      : await restart(target);
    try {
      // null = the key is absent: a pre-migration instance keeps its baseline display.
      const sessionMode = readSessionMode();
      if (![null, 'single', 'multi'].includes(sessionMode)) throw dataError('CONFIG_UNREADABLE', 'Invalid session mode');
      data.sessionMode = sessionMode;
      // In native single only Origin runs; other groups show the configuration
      // they will use after switching back to multi.
      const resolveMode = sessionMode === 'single' && sessionGroup !== 'origin' ? 'multi' : sessionMode ?? 'single';
      const resolved = store.resolveSessionLaunchConfig({ sessionGroup, sessionMode: resolveMode });
      if (!validLaunch(resolved)) throw dataError('CONFIG_UNREADABLE', 'Invalid resolved launch configuration');
      data.resolved = resolved;
      const scope = { kind, runtime: request.runtime, sessionGroup, sessionMode, resolved };
      if (!configRunningApplies(scope)) {
        data.running = null;
        return { ok: true, data };
      }
      const observation = await observeRunning({ sessionGroup, sessionMode });
      data.running = classifyConfigRunning({ ...scope, fence: store.getDrainFence(sessionGroup), observation });
    } catch (error) {
      data.running = { runId: null, launchConfig: null, status: 'unknown', reason: error.message, ...(error.code ? { code: error.code } : {}) };
    }
    return { ok: true, data };
  };
}

export function listOverrides({ store, groups, match, after }) {
  if (groups?.length) {
    const base = store.readBaseline();
    const baseline = { runtime: base.runtime, sessionMode: base.sessionMode };
    return { baseline, ...store.listOverridesForGroups(groups) };
  }
  const page = store.listRuntimeOverridesPage({ match, after });
  return { runtimeTotal: page.total, runtime: page.rows, nextAfter: page.nextAfter };
}

export async function runConfigCli(kind, argv, io = process) {
  const json = argv.includes('--json');
  try {
    const { request } = parseConfigArgs(kind, argv);
    const store = await import('./c4-db.js');
    const { validateChannel } = await import('./c4-validate.js');
    const { loadCoreConfig, resolveCoreConfigModule } = await import('./core-config-loader.js');
    const { readSessionMode } = await loadCoreConfig();
    const { observeCoreRunning } = await import('./c4-runtime-observer.js');
    const handler = createConfigHandler({
      store, validateComponent: name => validateChannel(name, true),
      readSessionMode: () => readSessionMode().mode,
      observeRunning: observeCoreRunning,
      restart: async target => {
        try {
          const module = path.join(path.dirname(resolveCoreConfigModule()), 'config-restart.js');
          const { requestConfigRestart } = await import(pathToFileURL(module));
          return await requestConfigRestart(target);
        } catch (error) { return { status: 'not_restarted', reason: error.code ?? error.message }; }
      },
    });
    const result = await handler(kind, request);
    io.stdout.write(json ? `${JSON.stringify(result)}\n` : `OK: ${JSON.stringify(result.data)}\n`);
    return 0;
  } catch (error) {
    const confirmation = ['CONFIRMATION_REQUIRED', 'RUNNING_STATE_UNKNOWN'].includes(error.code);
    const command = confirmation ? [...argv.filter(arg => arg !== '--json'), '--yes'].map(arg =>
      /^[\w:.-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(' ') : null;
    const message = confirmation ? `${error.message} To confirm, run: zylos group ${kind} ${command}` : error.message;
    const result = { ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message, persisted: own(error, 'persisted') ? error.persisted : null } };
    (json ? io.stdout : io.stderr).write(json ? `${JSON.stringify(result)}\n` : `Error [${result.error.code}]: ${message}\n`);
    return 1;
  }
}
