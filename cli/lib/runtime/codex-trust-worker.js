// Run synchronous trust operations in a child with the effective launch environment.
import { ensureCodexHooksTrusted } from '../codex-hooks.js';

try {
  ensureCodexHooksTrusted(JSON.parse(process.argv[2]));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
