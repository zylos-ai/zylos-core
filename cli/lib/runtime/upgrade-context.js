import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Discover recovery without opening C4 or importing any deployed skill.
export function upgradeStartupPrompt(root) {
  const entry = path.join(root, '.zylos', 'upgrade', 'bootstrap.cjs');
  if (!fs.existsSync(entry)) return null;
  const context = require(entry).bootstrap(root);
  return context.active ? context.prompt : null;
}

export function shellArgument(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function applyUpgradePrompt(args, prompt, promptIndex) {
  const next = [...args];
  if (!prompt) return next;
  if (promptIndex !== undefined) {
    if (!Number.isInteger(promptIndex) || promptIndex < 0 || promptIndex >= next.length) {
      throw new Error('invalid runtime startup prompt index');
    }
    next[promptIndex] = prompt;
  } else next.push(prompt);
  return next;
}
