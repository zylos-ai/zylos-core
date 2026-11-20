import { readZylosConfigOrThrow } from './local-config.js';
import { notifyOwner } from './c4-owner-alert.js';

export function notifySessionHostAttached({ source, target, moved, requester }) {
  const detach = `zylos host detach ${source}`;
  const followedZh = moved.length ? `\n随迁到 ${target} 的会话组：${moved.join('、')}。` : '';
  const followedEn = moved.length ? `\nGroups moved to ${target}: ${moved.join(', ')}.` : '';
  const detachMovedZh = moved.length ? ' 随迁的会话组可分别解除。' : '';
  const detachMovedEn = moved.length ? ' Detach any moved group separately.' : '';
  return send([
    `会话托管已生效：${source} → ${target}。发起方：${requester}。${followedZh}\n如需解除，在 Dashboard 点“解除”，或在任意对话让助手执行 ${detach}。${detachMovedZh}`,
    `Session hosting is active: ${source} → ${target}. Started by ${requester}.${followedEn}\nTo detach, select Detach in Dashboard or ask the agent in any conversation to run ${detach}.${detachMovedEn}`,
  ]);
}

export function notifySessionHostAllowlist(channel, allowed) {
  return send(allowed
    ? [`托管免通知白名单已加入 ${channel}。`, `${channel} was added to the session hosting notification allowlist.`]
    : [`托管免通知白名单已移除 ${channel}。`, `${channel} was removed from the session hosting notification allowlist.`]);
}

function send(translations) {
  return notifyOwner(translations.join('\n\n'), {
    readConfig: readZylosConfigOrThrow,
    log: error => console.error(`Session hosting notification attempt failed: ${error.code ?? 'SEND_FAILED'}`),
  });
}
