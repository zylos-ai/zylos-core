// Invoked only while codex-launch-trust holds the shared kernel lock.
import { ensureCodexHooksTrusted } from '../codex-hooks.js';

try {
  ensureCodexHooksTrusted(JSON.parse(process.argv[2]));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
