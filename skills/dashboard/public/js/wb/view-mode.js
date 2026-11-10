import { recoveryTime } from './cooldown.js?v=89';
import { formatZoned } from './instance-zone.js?v=100';
const CLOCK_SECONDS = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
const KEY = 'zylos-dashboard-detail-level';

export function createViewMode({ storage = globalThis.localStorage, document = globalThis.document } = {}) {
  let value = 'plain';
  try {
    value = storage.getItem(KEY) === 'technical' ? 'technical' : 'plain';
  } catch {}
  const listeners = new Set();
  const apply = () => {
    if (document) document.documentElement.dataset.detail = value;
  };
  apply();
  return {
    detailLevel: () => value,
    setDetailLevel(next) {
      value = next === 'technical' ? 'technical' : 'plain';
      try { storage.setItem(KEY, value); } catch {}
      apply();
      listeners.forEach(fn => fn(value));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const terms = {
  origin: '系统助手', pool: '同时运行', '7d': '本周额度', runtime: 'AI 引擎',
  effort: '思考强度', inherit: '用默认设置', pool_wait: '排队中', unsummarized: '待存入',
};
export const term = (key, level = 'plain', t) => level === 'plain'
  ? (t ? t('wb.term.' + key) : terms[key] ?? key) : key;

const tools = {
  Bash: '运行命令', Read: '读文件', Edit: '改文件', Write: '写文件', MultiEdit: '改文件',
  apply_patch: '改文件', Grep: '搜索文件', Glob: '找文件', WebSearch: '搜索网页',
  WebFetch: '打开网页', Task: '交给子代理', Agent: '交给子代理',
};
export const toolLabel = (name, level = 'plain', t) => level === 'plain'
  ? (t ? t('wb.tool.' + (name in tools ? name : 'unknown')) : tools[name] ?? '使用工具') : name;

/** The nav button of the page on screen is the current page for assistive technology; no other button is. */
export function markCurrentTab(tabs, name) {
  for (const tab of tabs) {
    if (tab.dataset.tab === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

export function resolveTheme(stored, matchMedia = globalThis.matchMedia) {
  if (stored === 'system') return matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return ['light', 'dark'].includes(stored) ? stored : 'light';
}

export function observeTheme(stored, apply, matchMedia = globalThis.matchMedia) {
  const media = matchMedia?.('(prefers-color-scheme: dark)');
  const update = () => apply(resolveTheme(stored, () => media));
  update();
  if (stored === 'system') media?.addEventListener('change', update);
  return () => media?.removeEventListener('change', update);
}

export function tabForPath(path) {
  if (path.endsWith('/usage') || path.endsWith('/trends')) return 'trends';
  if (path.endsWith('/settings')) return 'settings';
  if (path.endsWith('/memory')) return 'memory';
  if (path.endsWith('/observer')) return 'observer';
  if (path.endsWith('/chat')) return 'chat';
  if (path.endsWith('/schedule')) return 'schedule';
  return 'overview';
}

export function observerNavEntry(status, level, t) {
  if (level !== 'technical' || status == null) return null;
  const installed = status?.installed ?? status?.state === 'installed';
  const enabled = status?.enabled ?? status?.desired?.enabled;
  const key = installed ? (enabled ? 'tab.observer' : 'wb.observerDisabled') : 'wb.observerInstall';
  const fallback = {
    'tab.observer': '终端观察',
    'wb.observerDisabled': '终端观察（已停用）',
    'wb.observerInstall': '终端观察 · 去设置安装',
  };
  return { label: t ? t(key) : fallback[key], target: installed && enabled ? 'observer' : 'settings' };
}
// Every group can open the observer page; sleeping groups offer its history branch.
export const groupObservable = (entry, row) => entry?.target === 'observer' && Boolean(row);
export const wbWritable = remoteIsReadOnly => !remoteIsReadOnly();
const originStates = new Set(['running', 'starting', 'not_running', 'busy', 'idle', 'waiting', 'stopped', 'error']);
export function instanceStatusText(data = {}, level = 'plain', t = key => key) {
  const state = data.origin?.status?.state || data.origin?.presence;
  if (level === 'technical') return t('actions.instance_status', { view: data.view || t('value.unknown'),
    mode: data.sessionMode || t('value.unknown'), origin: state || t('value.unknown') });
  return t('wb.term.origin') + ' · ' + t('wb.state.' + (originStates.has(state) ? state : 'unknown'));
}
export function waitText(wait, level = 'plain', t, now = Date.now()) {
  if (!wait) return '';
  const reason = wait.kind ?? wait.reason ?? 'unknown';
  const at = recoveryTime(wait.cooldownUntil, now);
  const until = at === null ? '' : formatZoned(at, undefined, CLOCK_SECONDS);
  if (reason === 'pool_wait') {
    const position = Number.isSafeInteger(wait.position) && wait.position > 0 ? wait.position : '—';
    if (t) return t('wb.wait.pool_wait', { position }) + (level === 'technical' ? ' · ' + t('wb.wait.poolSnapshot') : '');
    return `等池位 · 第 ${position} 个` + (level === 'technical' ? ' · 按当前快照估计' : '');
  }
  if (level === 'technical') return [reason, wait.reasonCode ?? wait.reason, until].filter(Boolean).join(' · ');
  if (t) {
    const key = ['rate_wait', 'auth_wait', 'queued', 'starting', 'fenced', 'start_failed'].includes(reason) ? reason : 'unknown';
    return t('wb.wait.' + key + (key === 'rate_wait' && !until ? '_unknown' : ''), { time: until, count: wait.pendingCount ?? '—' });
  }
  return reason === 'rate_wait'
    ? `额度已用完，${until ? until + ' 恢复' : '恢复时间未知'}。消息会自动处理，不需要操作。`
    : reason === 'queued'
      ? '正在排队，空出位置后自动处理，不需要操作。'
      : '正在等待，条件满足后自动继续。';
}
