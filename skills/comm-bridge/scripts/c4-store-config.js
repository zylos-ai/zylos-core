import { dataError, requireGroup } from './c4-session-group.js';

export function configFunctions({ read, write, snapshot, get, all, run, knownGroup, dependencies }) {
  function runtime(value) {
    if (typeof value !== 'string' || !value) throw dataError('INVALID_ARGS', 'runtime is required');
    const supported = dependencies.supportedRuntimes ?? ['claude', 'codex'];
    if (!supported.includes(value)) throw dataError('RUNTIME_UNSUPPORTED', `Unsupported runtime: ${value}`);
    return value;
  }
  function baseline() {
    let result;
    try { result = dependencies.readConfig(); }
    catch (cause) { throw dataError('CONFIG_UNREADABLE', 'Cannot read instance configuration', { cause }); }
    if (!result || !['missing', 'ok'].includes(result.state)) throw dataError('CONFIG_UNREADABLE', 'Cannot read instance configuration', { cause: result?.error });
    const config = result.state === 'missing' ? {} : result.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw dataError('CONFIG_UNREADABLE', 'Invalid instance configuration');
    const selected = config.runtime ?? 'claude';
    try { runtime(selected); } catch (cause) { throw dataError('CONFIG_UNREADABLE', 'Invalid baseline runtime', { cause }); }
    if (config.session_mode !== undefined && !['single', 'multi'].includes(config.session_mode)) throw dataError('CONFIG_UNREADABLE', 'Invalid baseline session mode');
    return { runtime: selected, sessionMode: config.session_mode ?? 'single' };
  }
  const modelValue = (c, group, rt) => {
    const row = get(c, 'SELECT model,effort FROM group_model_overrides WHERE session_group=? AND runtime=?', group, rt);
    return row ? { runtime: rt, mode: 'override', ...row } : { runtime: rt, mode: 'default' };
  };
  const runtimeValue = (c, group) => {
    const row = get(c, 'SELECT runtime FROM group_runtime_overrides WHERE session_group=?', group);
    return row ? { mode: 'override', runtime: row.runtime } : { mode: 'inherit' };
  };
  function configWrite(operation) {
    try { return write(operation); }
    catch (error) {
      if (['DB_BUSY', 'DB_WRITE_FAILED'].includes(error.code)) throw dataError('CONFIG_STORE_FAILED', error.message, { cause: error });
      throw error;
    }
  }
  const api = {
    getSessionModelConfig: ({ sessionGroup, runtime: rt }) => read(c => { knownGroup(c, sessionGroup); runtime(rt); return modelValue(c, sessionGroup, rt); }),
    setSessionModelConfig: ({ sessionGroup, runtime: rt, model, effort }) => {
      runtime(rt);
      if ([model, effort].some(value => typeof value !== 'string' || !value.trim())) throw dataError('MODEL_PAIR_REQUIRED', 'Provide both nonempty model and effort');
      if (typeof dependencies.validateModel !== 'function') throw dataError('MODEL_CONFIG_INVALID', 'Runtime adapter validation is unavailable');
      const validation = dependencies.validateModel(rt, { model, effort });
      if (validation === false || validation?.valid === false) throw dataError('MODEL_CONFIG_INVALID', validation?.message ?? 'Invalid model/effort pair');
      return configWrite(c => {
        knownGroup(c, sessionGroup);
        const old = modelValue(c, sessionGroup, rt);
        const changed = old.mode !== 'override' || old.model !== model || old.effort !== effort;
        if (changed) run(c, 'INSERT INTO group_model_overrides(session_group,runtime,model,effort) VALUES(?,?,?,?) ON CONFLICT(session_group,runtime) DO UPDATE SET model=excluded.model,effort=excluded.effort', sessionGroup, rt, model, effort);
        return { changed, desired: { runtime: rt, mode: 'override', model, effort } };
      });
    },
    resetSessionModelConfig: ({ sessionGroup, runtime: rt }) => { runtime(rt); return configWrite(c => {
      knownGroup(c, sessionGroup);
      const changed = run(c, 'DELETE FROM group_model_overrides WHERE session_group=? AND runtime=?', sessionGroup, rt).changes > 0;
      return { changed, desired: { runtime: rt, mode: 'default' } };
    }); },
    getSessionRuntimeConfig: ({ sessionGroup }) => read(c => { knownGroup(c, sessionGroup); return runtimeValue(c, sessionGroup); }),
    setSessionRuntimeConfig: ({ sessionGroup, runtime: rt }) => { runtime(rt); return configWrite(c => {
      knownGroup(c, sessionGroup);
      const changed = runtimeValue(c, sessionGroup).runtime !== rt;
      if (changed) run(c, 'INSERT INTO group_runtime_overrides(session_group,runtime) VALUES(?,?) ON CONFLICT(session_group) DO UPDATE SET runtime=excluded.runtime', sessionGroup, rt);
      return { changed, desired: { mode: 'override', runtime: rt } };
    }); },
    resetSessionRuntimeConfig: ({ sessionGroup }) => configWrite(c => {
      knownGroup(c, sessionGroup);
      const changed = run(c, 'DELETE FROM group_runtime_overrides WHERE session_group=?', sessionGroup).changes > 0;
      return { changed, desired: { mode: 'inherit' } };
    }),
    resolveSessionLaunchConfig: ({ sessionGroup, sessionMode }) => {
      const base = baseline();
      if (sessionMode === 'single') return { runtime: base.runtime, mode: 'default' };
      if (sessionMode !== 'multi') throw dataError('SESSION_GROUP_INVALID', 'Invalid session mode');
      requireGroup(sessionGroup);
      return snapshot(c => modelValue(c, sessionGroup, runtimeValue(c, sessionGroup).runtime ?? base.runtime));
    },
    listGroupRuntimeOverrides: () => snapshot(c => all(c, 'SELECT session_group AS sessionGroup,runtime FROM group_runtime_overrides ORDER BY session_group COLLATE BINARY')),
  };
  return { api, baseline };
}
