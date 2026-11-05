import fs from 'node:fs';
import path from 'node:path';
import { readZylosConfigStrict, SKILLS_DIR } from './config.js';
import { parseServerAlertTarget } from '../../skills/activity-monitor/scripts/supervisor-server-observation.js';
import { green, yellow } from './colors.js';

const changeHint = 'zylos config set alert_target <channel>:<endpoint>';

/** Informational only: this notice never contributes a diagnostic failure. */
export function alertTargetNotice({ read = readZylosConfigStrict, exists = fs.existsSync, skillsDir = SKILLS_DIR } = {}) {
  let config;
  try { config = read(); } catch { config = { state: 'error' }; }
  if (config.state === 'error') return { kind: 'warning', text: 'instance config unreadable; cannot confirm the alert target. Fix the config first; do not overwrite it.' };
  if (config.state === 'missing' || !Object.hasOwn(config.config, 'alert_target')) {
    return { kind: 'warning', text: `not set; system alerts go only to Web Console. The agent will ask the owner in the next private chat, or run: ${changeHint}` };
  }
  const target = parseServerAlertTarget(config.config.alert_target);
  if (!target) return { kind: 'warning', text: 'invalid value (expected channel:endpoint, both non-empty, without newline or NUL); system alerts fall back to Web Console.' };
  if (target.channel === 'web-console' && target.endpoint === 'console') {
    return { kind: 'plain', text: `web-console:console (the owner chose Web Console only). To change: ${changeHint}` };
  }
  if (!exists(path.join(skillsDir, target.channel, 'scripts', 'send.js'))) {
    return { kind: 'warning', text: `skills/${target.channel}/scripts/send.js not found; system alerts fall back to Web Console.` };
  }
  return { kind: 'ready', text: config.config.alert_target };
}

export function formatAlertTargetNotice(notice) {
  const text = `Alert target: ${notice.text}`;
  return notice.kind === 'warning' ? yellow(text) : notice.kind === 'ready' ? green(text) : text;
}
