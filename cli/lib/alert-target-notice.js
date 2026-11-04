import fs from 'node:fs';
import path from 'node:path';
import { readZylosConfigStrict, SKILLS_DIR } from './config.js';
import { parseServerAlertTarget } from '../../skills/activity-monitor/scripts/supervisor-server-observation.js';
import { green, yellow } from './colors.js';

const changeHint = 'zylos config set alert_target <渠道>:<地址>';

/** Informational only: this notice never contributes a diagnostic failure. */
export function alertTargetNotice({ read = readZylosConfigStrict, exists = fs.existsSync, skillsDir = SKILLS_DIR } = {}) {
  let config;
  try { config = read(); } catch { config = { state: 'error' }; }
  if (config.state === 'error') return { kind: 'warning', text: '实例配置无法读取：无法确认告警目的地；请先修复配置，不要覆盖。' };
  if (config.state === 'missing' || !Object.hasOwn(config.config, 'alert_target')) {
    return { kind: 'warning', text: `未设置：系统告警只发到 Web Console。agent 会在主人下次私聊时询问，也可以运行 ${changeHint}` };
  }
  const target = parseServerAlertTarget(config.config.alert_target);
  if (!target) return { kind: 'warning', text: '值不合法：需要“渠道:地址”，两边非空且不含换行或 NUL；系统告警退回 Web Console。' };
  if (target.channel === 'web-console' && target.endpoint === 'console') {
    return { kind: 'plain', text: `主人选了只发 Web Console；要改：${changeHint}` };
  }
  if (!exists(path.join(skillsDir, target.channel, 'scripts', 'send.js'))) {
    return { kind: 'warning', text: `渠道 ${target.channel} 的 scripts/send.js 不存在：系统告警发送失败时退回 Web Console。` };
  }
  return { kind: 'ready', text: config.config.alert_target };
}

export function formatAlertTargetNotice(notice) {
  const text = `Alert target: ${notice.text}`;
  return notice.kind === 'warning' ? yellow(text) : notice.kind === 'ready' ? green(text) : text;
}
