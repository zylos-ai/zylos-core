const KEY='zylos-dashboard-detail-level';
export const technicalKeys=new Set('groupKey runId errorCode queue context modelColumn evidence toolRawCommand cronText taskId taskPriority syncProgress fileBudget commitHash tokens autoRotate toolCalls projects hostCurves remoteAddress versionLatency observerNav observerSettings'.split(' '));
export const techOnly=key=>technicalKeys.has(key);
export function createViewMode({storage=globalThis.localStorage,document=globalThis.document}={}) { let value='plain';try{value=storage.getItem(KEY)==='technical'?'technical':'plain';}catch{} const listeners=new Set(); const apply=()=>{if(document)document.documentElement.dataset.detail=value;};apply();return {detailLevel:()=>value,setDetailLevel(next){value=next==='technical'?'technical':'plain';try{storage.setItem(KEY,value);}catch{}apply();listeners.forEach(fn=>fn(value));},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}}; }
const terms={origin:'系统助手',pool:'同时运行','7d':'本周额度',runtime:'AI 引擎',effort:'思考强度',inherit:'用默认设置',pool_wait:'排队中',unsummarized:'待存入'};
export const term=(key,level='plain',t)=>level==='plain'?(t ? t('wb.term.'+key) : terms[key]??key):key;
const tools={Bash:'运行命令',Read:'读文件',Edit:'改文件',Write:'写文件',MultiEdit:'改文件',apply_patch:'改文件',Grep:'搜索文件',Glob:'找文件',WebSearch:'搜索网页',WebFetch:'打开网页',Task:'交给子代理',Agent:'交给子代理'};
export const toolLabel=(name,level='plain',t)=>level==='plain'?(t ? t('wb.tool.'+(name in tools?name:'unknown')) : tools[name]??'使用工具'):name;
export function resolveTheme(stored,matchMedia=globalThis.matchMedia){return stored==='system'?(matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light'):['light','dark'].includes(stored)?stored:'light';}
export function observeTheme(stored,apply,matchMedia=globalThis.matchMedia){const media=matchMedia?.('(prefers-color-scheme: dark)');const update=()=>apply(resolveTheme(stored,()=>media));update();if(stored==='system')media?.addEventListener('change',update);return()=>media?.removeEventListener('change',update);}
export function observerNavEntry(status, level, t) {
  if (level !== 'technical') return null;
  const installed = status?.installed ?? status?.state === 'installed';
  const enabled = status?.enabled ?? status?.desired?.enabled;
  const key = installed ? (enabled ? 'wb.observer' : 'wb.observerDisabled') : 'wb.observerInstall';
  const fallback = { 'wb.observer': '终端观察', 'wb.observerDisabled': '终端观察（已停用）', 'wb.observerInstall': '终端观察 · 去设置安装' };
  return { label: t ? t(key) : fallback[key], target: installed && enabled ? 'observer' : 'settings' };
}
export const wbWritable = remoteIsReadOnly => !remoteIsReadOnly();
export function waitText(wait, level = 'plain', t) {
  if (!wait) return '';
  const reason = wait.kind ?? wait.reason ?? 'unknown';
  const until = wait.cooldownUntil == null ? '' : new Date(wait.cooldownUntil * 1000).toLocaleTimeString();
  if (level === 'technical') return [reason, wait.reasonCode ?? wait.reason, until].filter(Boolean).join(' · ');
  if (t) return t('wb.wait.' + (['rate_wait', 'auth_wait', 'queued', 'starting', 'fenced', 'start_failed'].includes(reason) ? reason : 'unknown'), { time: until, count: wait.pendingCount ?? '—' });
  return reason === 'rate_wait' ? `额度已用完，${until || '额度恢复后'}恢复。消息会自动处理，不需要操作。` : reason === 'queued' ? '正在排队，空出位置后自动处理，不需要操作。' : '正在等待，条件满足后自动继续。';
}
