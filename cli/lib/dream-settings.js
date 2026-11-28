/**
 * Nightly dreaming model and effort, configured per runtime in the instance configuration:
 * `memory_dream_model` and `memory_dream_effort` each map a runtime id to its value, for example
 * {"claude":"claude-opus-5-5"}. A runtime without a value uses its dream adapter's default, so
 * switching runtimes never hands one runtime's model name to another, and switching back keeps it.
 */
import { UNSUPPORTED } from './runtime/contract.js';
import { runtimeDisplayName } from './runtime/descriptors.js';

export const DREAM_SETTING_KEYS = Object.freeze({ model: 'memory_dream_model', effort: 'memory_dream_effort' });

function stored(config, kind, id) {
  const values = config?.[DREAM_SETTING_KEYS[kind]];
  const value = values !== null && typeof values === 'object' && !Array.isArray(values) ? values[id] : undefined;
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Effort values the runtime accepts, from its launch capability; empty when it has no separate effort. */
export function dreamEfforts(runtime) {
  return runtime.dream.defaultEffort === UNSUPPORTED || !Array.isArray(runtime.launch.efforts) ? [] : [...runtime.launch.efforts];
}

/** The model and effort a dream call uses on this runtime, with what is configured and the adapter defaults. */
export function dreamSettings(config, runtime) {
  const efforts = dreamEfforts(runtime);
  const defaults = { model: runtime.dream.defaultModel, effort: efforts.length ? runtime.dream.defaultEffort : null };
  const configured = { model: stored(config, 'model', runtime.id), effort: efforts.length ? stored(config, 'effort', runtime.id) : null };
  return {
    runtime: runtime.id,
    model: configured.model ?? defaults.model,
    effort: configured.effort ?? defaults.effort,
    configured, defaults, efforts,
  };
}

function invalid(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The configuration update that saves one runtime's dream model or effort; `null` restores the default.
 * Throws `invalid_model` / `invalid_effort` (with `efforts`) for a value the runtime cannot use.
 */
export function dreamSettingUpdate(runtime, kind, value) {
  if (!Object.hasOwn(DREAM_SETTING_KEYS, kind)) throw new TypeError(`unknown dream setting: ${kind}`);
  let next = value;
  if (next !== null) {
    if (typeof next !== 'string' || !next.trim() || next.includes('\0')) {
      throw invalid(`invalid_${kind}`, `${DREAM_SETTING_KEYS[kind]} must be a non-empty value`);
    }
    next = next.trim();
    const efforts = dreamEfforts(runtime);
    if (kind === 'effort' && !efforts.includes(next)) {
      throw Object.assign(invalid('invalid_effort', efforts.length
        ? `${DREAM_SETTING_KEYS.effort} must be one of: ${efforts.join(', ')}`
        : `${runtimeDisplayName(runtime.id)} has no separate dream effort`), { efforts });
    }
  }
  // A leaf merge keeps the other runtimes' values within the same locked write.
  return { merge: { [DREAM_SETTING_KEYS[kind]]: { [runtime.id]: next } } };
}
