// Fixed API answers for the workbench browser case: one instance with a few session groups, scheduled tasks,
// a memory tree with a long file, and settings. Shapes follow the dashboard's own routes; values are invented.
// Every answer is computed from `now`, so the page's relative times stay stable within one run.

const iso = ms => new Date(ms).toISOString();
const queue = (pending = 0, running = 0) => ({ pending: { count: pending, oldestAt: null, head: null }, running: { count: running }, fence: null });

export const GROUP = 'telegram:dm-1001';
export const LONG_FILE = 'state.md';
export const GROUP_FILE = `session-groups/${GROUP}/state.md`;

function rows(now) {
  const sec = ms => Math.floor(ms / 1000);
  return [
    { sessionGroup: 'origin', origin: true, presence: 'running', name: null, state: { kind: 'idle' }, duration: 380, tools: [], queue: queue(), contextPct: 23,
      launchConfig: { runtime: 'claude', mode: 'default' }, target: { runtime: 'claude', model: 'default' }, desired: { runtime: 'claude', mode: 'default' },
      createdAt: sec(now - 3600e3), live: { runId: 'run-origin', sessionId: 's0' }, preview: { text: 'Daily health check done' }, c4: null },
    { sessionGroup: GROUP, presence: 'running', name: { displayName: 'Telegram direct chat with a long display name' }, state: { kind: 'busy' }, duration: 252,
      tools: [{ name: 'Bash', detail: 'npm test', startedAt: now - 64e3 }], queue: queue(1, 1), contextPct: 64,
      launchConfig: { runtime: 'claude', mode: 'default' }, target: { runtime: 'claude', model: 'default' }, desired: { runtime: 'claude', mode: 'default' },
      createdAt: sec(now - 30 * 60e3), live: { runId: 'run-tg', sessionId: 's1' }, preview: { text: 'Run the tests again please' }, c4: { componentName: 'telegram', lastActivityAt: now - 60e3 } },
    { sessionGroup: 'lark:oc_product', presence: 'not_running', name: { displayName: 'Product weekly' }, state: { kind: 'not_running' }, duration: null, tools: [], queue: queue(),
      contextPct: null, launchConfig: null, target: { runtime: 'claude', model: 'default' }, desired: { runtime: 'claude', mode: 'default' },
      createdAt: null, live: null, preview: { text: 'Agenda is ready' }, c4: { componentName: 'lark', lastActivityAt: now - 7200e3 } },
  ];
}

function snapshot(now) {
  const list = rows(now);
  const counts = { busy: 0, waiting: 0, error: 0, unknown: 0, idle: 0, not_running: 0 };
  for (const row of list) counts[row.state.kind]++;
  return { readAt: now, mode: 'multi', view: 'multi', rows: list, counts, hasOlder: false, listKnown: true, baselineRuntime: 'claude',
    overrides: { runtime: [], model: [] },
    instance: { runtimeHealth: { claude: { health: 'ok' }, codex: { health: 'ok' } }, accounts: { claude: { used_percentage: 42 }, codex: null },
      pool: { ready: 2, starting: 0, reclaiming: 0, waiting: 0, capacity: 4, used: 2 }, services: { online: 6, total: 6 },
      system: { sampledAt: now - 12000, cpuPct: 23.4, cpuCount: 8, memUsedBytes: 2147483648, memTotalBytes: 17179869184, diskUsedPct: 61.6, diskFreeBytes: 43218108416 } },
    sources: { status: { ok: true, readAt: now }, c4: { ok: true, readAt: now } }, attention: { ok: true, problems: [], reminders: [] } };
}

function schedule(now) {
  const s = Math.floor(now / 1000);
  const recent = Array.from({ length: 10 }, (_, i) => ({ id: i, status: i === 7 ? 'timeout' : 'success', executedAt: s - (10 - i) * 3600, duration: 120e3, error: null }));
  const task = (id, name, fields) => ({ id, name, prompt: `${name} prompt`, type: 'recurring', status: 'pending', cron: '0 8 * * *', intervalSeconds: null,
    nextRunAt: null, lastRunAt: s - 3600, updatedAt: s - 86400, priority: 3, requireIdle: false, missThreshold: 300, showLastError: false, lastError: null,
    recent, nextRuns: { runs: [], in24h: [] }, target: { kind: 'origin' }, reply: null, reenable: false, ...fields });
  // Runs spread across the next day, several close together and one at its very end, so a run marker sits at the
  // right edge of the phone timeline, where it would widen the page if the timeline did not clip it.
  const every = (start, step, count) => Array.from({ length: count }, (_, i) => s + start + i * step);
  const tasks = [
    task('t-hourly', 'health-check', { type: 'interval', cron: null, intervalSeconds: 3600, nextRuns: { runs: every(1500, 3600, 3), in24h: every(1500, 3600, 24) } }),
    task('t-morning', 'morning-briefing', { nextRuns: { runs: every(9000, 86400, 3), in24h: [s + 9000] },
      target: { kind: 'group', sessionGroup: GROUP, componentName: 'telegram', displayName: 'Telegram direct chat' } }),
    task('t-night', 'evening-reflection', { cron: '45 23 * * *', nextRuns: { runs: every(80000, 86400, 2), in24h: [s + 80000, s + 80300, s + 86340] } }),
    task('t-paused', 'weekend-digest', { status: 'paused', cron: '0 10 * * 6,0' }),
  ];
  const days = Array.from({ length: 7 }, (_, i) => ({ date: iso(now - (6 - i) * 86400e3).slice(0, 10), success: 8, timeout: i === 3 ? 1 : 0, failed: 0 }));
  return { available: true, tz: 'UTC', readAt: now, kpi: { enabled: 3, paused: 1, running: 0, next24h: 28, partialPreview: false, runs7d: 57, bad7d: 1, successRate7d: 56 / 57 },
    daily7d: { tz: 'UTC', utcFallback: false, days }, tasks };
}

function memoryTree(now) {
  const file = (path, size) => ({ type: 'file', name: path.split('/').at(-1), path, size_bytes: size, mtime: iso(now - 7200e3), renderable: true });
  const dir = (path, children) => ({ type: 'directory', name: path.split('/').at(-1), path, mtime: iso(now), children });
  // Enough shared files that the list is taller than a phone screen, so opening a file from below the fold is checked.
  const reference = Array.from({ length: 14 }, (_, i) => file(`reference/note-${String(i + 1).padStart(2, '0')}.md`, 2000 + i));
  return { root: dir('', [file('identity.md', 9000), file(LONG_FILE, 12100), file('references.md', 7800), dir('reference', reference),
    dir('session-groups', [dir(`session-groups/${GROUP}`, [file(GROUP_FILE, 2150), file(`session-groups/${GROUP}/handoff.md`, 820)]),
      dir('session-groups/lark:oc_product', [file('session-groups/lark:oc_product/state.md', 1430)])])]),
  sessionGroups: [{ sessionGroup: GROUP, displayName: 'Telegram direct chat' }, { sessionGroup: 'lark:oc_product', displayName: 'Product weekly' }] };
}

// Longer than a phone screen, so the share of the first screen the open file takes is measured on real text.
const longText = '# Current state\n\n## Doing now\n- Second prototype round, settings and memory pages\n- Re-review after the next round\n'
  + Array.from({ length: 10 }, (_, i) => `\n## Week ${i + 1}\n- Monday: merge duplicate memory entries and add missing source links.\n- Wednesday: check the scheduled task history; both timeouts are explained.\n- Friday: file the review notes and wait for the owner to confirm.\n`).join('');

// The busy group's current run: a few events a person can follow, then 600 router `release` diagnostics (one a
// second), then the turn ends. Reads answer like the dashboard's: by run or group, by type, in sequence order.
function runEvents(now) {
  let seq = 0;
  const event = (type, msAgo, category) => ({ id: `e${++seq}`, event_seq: seq, timestamp: iso(now - msAgo), event_type: type, category,
    run_id: 'run-tg', session_group: GROUP, runtime: 'claude', metadata: {} });
  return [event('session_start', 20 * 60e3, 'session'), event('user_prompt_submit', 19 * 60e3, 'turn'), event('pre_tool_use', 18 * 60e3, 'tool'),
    event('post_tool_use', 17 * 60e3, 'tool'), ...Array.from({ length: 600 }, (_, i) => event('release', 16 * 60e3 - i * 1000, 'diagnostic')),
    event('stop', 5 * 60e3, 'turn')];
}
// The stopped group's two earlier runs, newest first, each ended by the supervisor's automatic restart: run A after a
// reminder the main agent never answered, run D after a tool ran too long. Each restart is followed a second later by
// the crash report the exit it caused leaves in the same run.
export const STOPPED_GROUP = 'lark:oc_product';
function restartedRuns(now) {
  let seq = 1000;
  const run = (runId, endReason, endAgo, steps) => {
    const end = now - endAgo, events = steps.map(([type, before, category]) => ({ id: `e${++seq}`, event_seq: seq,
      timestamp: iso(end - before), event_type: type, category, run_id: runId, session_group: STOPPED_GROUP, runtime: 'claude', metadata: {} }));
    return { runId, endReason, startAt: events[0].timestamp, endAt: events.at(-1).timestamp, events };
  };
  const work = (from, count) => Array.from({ length: count }, (_, i) => [i % 2 ? 'post_tool_use' : 'pre_tool_use', from - i * 20e3, 'tool']);
  return [
    run('run-a', 'auto_restart_no_response', 2 * 3600e3, [['session_start', 3600e3, 'session'], ['user_prompt_submit', 3500e3, 'turn'],
      ...work(3400e3, 12), ['stop', 1500e3, 'turn'], ['user_prompt_submit', 1400e3, 'turn'], ['no_response_nudge', 600e3, 'diagnostic'],
      ['no_response_restart', 1100, 'diagnostic'], ['crash_detected', 0, 'session']]),
    run('run-d', 'auto_restart_tool_timeout', 5 * 3600e3, [['session_start', 1800e3, 'session'], ['user_prompt_submit', 1700e3, 'turn'],
      ['pre_tool_use', 1600e3, 'tool'], ['tool_timeout_nudge', 900e3, 'diagnostic'], ['tool_timeout_restart', 1000, 'diagnostic'],
      ['crash_detected', 0, 'session']]),
  ];
}
function timeline(url, now) {
  const params = url.searchParams, types = params.get('types')?.split(',').filter(Boolean);
  const after = Number(params.get('after_seq') ?? 0), limit = Math.min(1000, Number(params.get('limit') ?? 100));
  const restarted = restartedRuns(now).find(run => run.runId === params.get('run_id'));
  if (!restarted && (params.get('run_id') ? params.get('run_id') !== 'run-tg' : params.get('session_group') !== GROUP)) return { events: [] };
  const events = (restarted?.events ?? runEvents(now)).filter(event => (!types || types.includes(event.event_type)) && event.event_seq > after);
  if (params.get('order') === 'desc') events.reverse();
  return { events: events.slice(0, limit) };
}
function runs(url, now) {
  const group = decodeURIComponent(url.pathname.split('/')[4] ?? ''), types = url.searchParams.get('types')?.split(',').filter(Boolean);
  const count = events => events.filter(event => !types || types.includes(event.event_type)).length;
  if (group === STOPPED_GROUP) {
    const list = restartedRuns(now).map(({ events, ...run }) => ({ ...run, n: count(events) }));
    return { runs: list, totalEvents: list.reduce((sum, run) => sum + run.n, 0), totalRuns: list.length, unattributed: 0 };
  }
  if (group !== GROUP) return { runs: [], totalEvents: 0, totalRuns: 0, unattributed: 0 };
  const all = runEvents(now);
  const n = count(all);
  return { runs: [{ runId: 'run-tg', startAt: all[0].timestamp, endAt: all.at(-1).timestamp, n, endReason: 'running' }], totalEvents: n, totalRuns: 1, unattributed: 0 };
}

const meta = { runtime: 'claude', current_model: 'opus', current_effort: 'high', new_session_threshold: 70,
  models: [{ id: 'opus', display_name: 'Opus' }, { id: 'sonnet', display_name: 'Sonnet' }], efforts_by_model: { '*': ['low', 'medium', 'high'] } };

/** The JSON answer for a GET, or undefined when the case does not serve that path. */
export function workbenchAnswer(url, now) {
  const p = url.pathname;
  if (p === '/api/workbench/groups') return snapshot(now);
  if (p === '/api/workbench/groups/search') return { rows: [] };
  if (p === '/api/workbench/activity') return { start: now - 59 * 60e3, cellSeconds: 60, groups: {} };
  if (p === '/api/workbench/schedule') return schedule(now);
  if (p.startsWith('/api/workbench/schedule/') && p.endsWith('/history')) return { rows: [], next: null };
  if (p === '/api/memory/tree') return memoryTree(now);
  if (p === '/api/memory/file') {
    const path = url.searchParams.get('path');
    return { path, name: path.split('/').at(-1), size_bytes: 12100, mtime: iso(now - 7200e3), sha256: '7c1e9a2d'.padEnd(64, '0'), markdown: true,
      text: path === LONG_FILE ? longText : `# ${path}\n\nShort file.\n` };
  }
  if (p === '/api/memory/git') return { commit: null };
  if (p === '/api/workbench/memory/backlog') return { groups: [{ sessionGroup: GROUP, displayName: 'Telegram direct chat', c4: { componentName: 'telegram' },
    count: 12, firstAt: null, aged: false, syncing: false, threshold: 15 }], hasOlder: false, budgets: { limits: {}, warnings: {} } };
  if (p.endsWith('/backlog')) return { count: 12, firstAt: null, syncing: false };
  if (p.endsWith('/runs')) return runs(url, now);
  if (p.endsWith('/messages')) return { messages: [] };
  if (p.endsWith('/config')) {
    const pair = { runtime: 'claude', mode: 'default' };
    return { runtime: { ok: true, data: { desired: { mode: 'inherit' }, resolved: pair, running: { status: 'applied', launchConfig: pair } } },
      model: { ok: true, data: { runtime: 'claude', desired: pair, resolved: pair, running: { status: 'applied', launchConfig: pair } } } };
  }
  if (p === '/api/timeline') return timeline(url, now);
  if (p === '/api/state') return { state: 'IDLE', agent: { name: 'browser-case' }, sessionGroup: 'origin', runId: 'run-origin', sessionId: 's0',
    runtime_info: { runtime: 'claude', zylos_version: '0.9.4', cc_version: '2.1.80' } };
  if (p === '/api/session-mode') return { ok: true, data: { sessionMode: 'multi', transition: null } };
  if (p === '/api/instance-status') return { ok: true, data: { origin: { presence: 'running' }, view: 'multi', sessionMode: 'multi' } };
  if (p === '/api/actions/meta') return meta;
  if (p === '/api/settings') return { active: 'claude', runtimes: { claude: { builtInModels: ['opus'], modelPrices: { opus: { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 } },
    fastMode: { configuredMultiplier: null } },
  codex: { builtInModels: ['gpt-5.5'], modelPrices: { 'gpt-5.5': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 } },
    builtInPriorityModels: [], priorityModelPrices: {} } } };
  if (p === '/api/workbench/pricing') return { models: [], unmatched: [] };
  if (p === '/api/workbench/runtime-overrides') return { runtime: [], runtimeTotal: 0, nextAfter: null };
  if (p === '/api/fleet') return { agents: [{ name: 'browser-case', self: true, access: 'admin' }], updated_at: iso(now) };
  if (p === '/api/fleet/agents') return { self: { name: 'browser-case' }, agents: [] };
  if (p === '/api/keys') return { keys: [] };
  if (p === '/api/chat/settings') return { allowRemote: false };
  if (p === '/api/observer/status') return { state: 'not_installed' };
  if (p === '/api/workbench/usage') return { costSummary: { today: { total: 1.5 }, sevenDay: { total: 9.2 }, daily: [] } };
  if (p === '/api/workbench/host') return { current: {}, pm2: { online: 6, total: 6 }, series: [] };
  if (p === '/api/health') return { status: 'ok' };
  return undefined;
}
