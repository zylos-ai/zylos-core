import { CONTENT_PREFIX } from '/chat-schema.js';
import { renderChatContent } from '/js/wb/chat-blocks.js';
import { applyChatView } from '/js/wb/chat-view.js';

const icons = ['bot', 'monitor', 'server', 'network', 'code', 'terminal', 'layers', 'component', 'tool', 'settings', 'book', 'chart', 'message', 'key', 'lock', 'clock', 'alert', 'check', 'search', 'target', 'user', 'users', 'smartphone', 'glasses', 'database', 'cloud', 'globe', 'file'];
const literal = '<img src=x onerror=alert(1)>';
const definitions = [
  ['minimal', { steps: [{ nodes: [{ label: '输入' }] }, { nodes: [{ label: '输出' }] }] }],
  ['medium', { title: '中等宽度容器', direction: 'horizontal', steps: [
    { nodes: [{ label: '输入' }] }, { nodes: [{ label: '输出' }] },
  ] }],
  ['default', { title: '眼镜架构', steps: [
    { id: 'glasses', nodes: [{ label: '智能眼镜', detail: '语音输入与播报', icon: 'glasses' }] },
    { id: 'phone', nodes: [{ label: '手机', detail: '连接眼镜与云端', icon: 'smartphone', highlight: true }], link: { arrow: 'both', label: '同步' } },
    { id: 'cloud', nodes: [{ label: '云端服务', icon: 'cloud' }], link: { label: 'LAST LINK MUST NOT APPEAR', arrow: 'both' } },
  ], groups: [{ label: '设备', from: 'glasses', to: 'phone' }, { label: '服务', from: 'cloud', to: 'cloud' }], summary: '眼镜经手机连接云端。' }],
  ['horizontal', { title: '消息流程', direction: 'horizontal', steps: [
    { id: 'channels', nodes: [{ label: 'Telegram', icon: 'message' }, { label: 'Lark', icon: 'message' }] },
    { id: 'bridge', nodes: [{ label: '通信桥', icon: 'network', highlight: true }, { label: '调度器', icon: 'clock' }, { label: 'Agent', icon: 'bot' }], link: { arrow: 'both', label: '处理结果' } },
    { id: 'output', nodes: [{ label: 'Dashboard', icon: 'monitor' }] },
  ], groups: [{ label: 'Zylos 主机', from: 'bridge', to: 'output' }] }],
  ['long', { title: '超过五步的横排', direction: 'horizontal', steps: Array.from({ length: 6 }, (_, i) => ({ nodes: [{ label: '步骤 ' + (i + 1), icon: 'check' }], ...(i === 2 ? { link: { arrow: 'none' } } : {}) })) }],
  ['five', { title: '五步横排与长分组名称', direction: 'horizontal',
    steps: Array.from({ length: 5 }, (_, i) => ({ id: 'step-' + i, nodes: [{ label: '步骤 ' + (i + 1), icon: 'check' }] })),
    groups: [{ label: '这是二十四字长度的单步分组名称用于验证布局无重叠', from: 'step-2', to: 'step-2' }] }],
  ['five-long-titles', { title: '五步横排与长节点标题', direction: 'horizontal',
    steps: ['收集用户提交的需求', '检查输入内容和权限', '执行后台处理任务', '汇总任务处理结果', '发送结果并记录状态'].map(label => ({ nodes: [{ label, icon: 'check' }] })),
  }],
  ['long-links', { title: '长连线文字', direction: 'horizontal',
    steps: Array.from({ length: 5 }, () => ({ nodes: [{ label: '处理' }], link: { label: '这是用于验证横排连线文本折行边界的四十字这是用于验证横排连线文本折行边界的四十字' } })),
  }],
  ['literal', { title: literal, steps: [
    { id: 'first', nodes: [{ label: literal, detail: '<script>window.bad=true</script>', icon: 'future-icon' }], link: { label: '<b>literal link</b>' } },
    { id: 'last', nodes: [{ label: '<a href=x>text</a>', icon: 'server' }] },
  ], groups: [{ label: '<b>group</b>', from: 'first', to: 'last' }], summary: '<input autofocus>' }],
];
for (let i = 0; i < icons.length; i += 6) definitions.push(['icons-' + i, {
  title: '图标 ' + (i + 1), steps: [0, 3].map(offset => ({ nodes: icons.slice(i + offset, i + offset + 3).map(icon => ({ label: icon, icon })) })).filter(step => step.nodes.length),
}]);
const root = document.querySelector('main');
for (const [id, data] of definitions) {
  const envelope = { version: 1, kind: 'message', messageId: id, fallbackText: 'Flow in words', blocks: [
    { id: 'flow', type: 'diagram', schemaVersion: 1, fallbackText: 'Flow in words', data },
  ] };
  const article = document.createElement('article'); article.id = id; article.className = 'conversation-message';
  if (id === 'medium') article.style.maxWidth = '480px';
  const body = document.createElement('div'); body.className = 'conversation-message-body'; article.append(body);
  body.append(renderChatContent({ document, row: { id, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope) },
    layout: (target, view, nodes) => applyChatView(document, target, view, nodes) }));
  root.append(article);
}
window.diagramFixture = { ready: true, literal, icons };
