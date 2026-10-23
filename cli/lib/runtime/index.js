/** Runtime selection is explicit: use the observed runtime or IB-58 result. */
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
const REGISTRY = { claude: ClaudeAdapter, codex: CodexAdapter };
export const SUPPORTED_RUNTIMES = Object.freeze(Object.keys(REGISTRY));
export function getSessionAdapter(runtime, options = {}) {
  const Adapter = REGISTRY[runtime];
  if (!Adapter) throw Object.assign(new Error(`Unsupported runtime: ${runtime}`), {code:'RUNTIME_UNSUPPORTED'});
  return new Adapter(options);
}
