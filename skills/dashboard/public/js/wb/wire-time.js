/** Absolute time conversion is a wire concern; storage, caches and cursors keep their source units. */
export function isoTimestamp(value, unit = 'ms') {
  if (value == null || value === '') return null;
  let milliseconds;
  if (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    if (Number(value) === 0) return null;
    milliseconds = unit === 'julian' ? Math.round((Number(value) - 2440587.5) * 86400000) : Number(value) * (unit === 's' ? 1000 : 1);
  } else if (typeof value === 'string') {
    // SQLite's datetime() values are UTC, although they omit the timezone marker.
    const text = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    milliseconds = Date.parse(text);
  } else return value;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return null;
  return new Date(milliseconds).toISOString();
}

// Paths are the public field catalogue, rather than a recursive *At-name or
// numeric-magnitude heuristic. Wildcards enumerate a documented array or map.
const fields = (unit, names) => names.map(name => [name, unit]);
const ms = (...names) => fields('ms', names);
const seconds = (...names) => fields('s', names);
const beneath = (prefix, schema) => schema.map(([name, unit]) => [prefix ? `${prefix}.${name}` : name, unit]);

const WORKING = ms('since', 'main.since', 'main.lastActivityAt', 'subagents.since', 'subagents.lastActivityAt');
const GROUP = [
  ...ms('readAt', 'lastActivityAt', 'state.since', 'state.sampledAt', 'live.status.sampledAt', 'c4.lastActivityAt',
    'preview.timestamp', 'queue.pending.oldestAt', 'noResponse.since', 'tools.*.startedAt', 'currentAction.receivedAt',
    'flags.queued.oldestAt', 'flags.blocked.recoveryAt', 'flags.startFailed.lastAt', 'flags.noResponse.since', 'wait.lastAt',
    'name.updatedAt', 'name.updated_at', 'run.createdAt'),
  ...seconds('createdAt', 'fence.createdAt', 'queue.fence.createdAt', 'wait.since', 'wait.cooldownUntil'),
  ...beneath('working', WORKING),
];
const INSTANCE = [
  ...ms('startedAt', 'resources.sampledAt', 'accounts.*.recordedAt',
    'session_mode.blocked.since', 'session_mode.lastEvents.*.ts', 'runtimeHealth.*.updatedAt'),
  ...seconds('accounts.*.resets_at', 'accounts.*.resetsAt', 'runtimeHealth.*.cooldownUntil',
    'session_mode.transition.createdAt', 'session_mode.transition.updatedAt', 'session_mode.lastCompleted.updatedAt'),
];
const TASK = [
  ...seconds('nextRunAt', 'lastRunAt', 'updatedAt', 'recent.*.executedAt', 'recent.*.completedAt', 'nextRuns.runs.*', 'nextRuns.in24h.*'),
];
const SCHEDULE = [
  ...ms('readAt', 'iso'), ...seconds('nextRunAt', 'runs.*', 'rows.*.executedAt', 'rows.*.completedAt'),
  ...beneath('tasks.*', TASK), ...beneath('timelineTasks.*', TASK), ...beneath('task', TASK),
  // Scheduler CLI writes return its complete task row, whose time columns use seconds.
  ...seconds('data.task.next_run_at', 'data.task.last_run_at', 'data.task.created_at', 'data.task.updated_at',
    'data.task.failed_at', 'data.task.completed_at', 'data.task.running_at'),
];
const CHAT = [
  ...ms('createdAt', 'updatedAt', 'expiresAt', 'conversation.createdAt', 'conversation.updatedAt',
    'answer.createdAt', 'answer.updatedAt', 'items.*.createdAt', 'items.*.updatedAt', 'items.*.timestamp',
    'items.*.quote.timestamp', 'items.*.lastActivityAt', 'items.*.lastMessageAt', 'items.*.answer.createdAt', 'messages.*.timestamp',
    'statuses.*.createdAt', 'statuses.*.updatedAt', 'statuses.*.timestamp', 'delivery.createdAt'),
  ...fields('julian', ['items.*.stamp']),
];
const ACTIVITY = [
  ...ms('now', 'from', 'header.readAt', 'steps.*.start', 'steps.*.end', 'steps.*.at',
    'subtasks.*.start', 'subtasks.*.end', 'subtask.start', 'subtask.end', 'awaiting.since', 'awaiting.delivered'),
  ...beneath('header', GROUP), ...beneath('presence', GROUP),
  ...beneath('header.presence', GROUP), ...beneath('working', WORKING),
];
const FLEET_RECORD = [
  ...ms('rate_limit_7d_recorded_at', 'updated_at', 'link.sampled_at', 'link.samples.*.at'),
  ...seconds('group_summary.problems.*.createdAt'),
  ...beneath('instance', INSTANCE), ...ms('system_metrics.sampledAt'), ...beneath('groups', ms('readAt')),
  ...beneath('group_summary.rows.*', GROUP),
];
const FLEET = [...beneath('self', FLEET_RECORD), ...beneath('agents.*', FLEET_RECORD)];
const EVENTS = ms('events.*.timestamp', 'gaps.*.timestamp', 'events.*.metadata.pasted_at');
const MEMORY = ms('firstAt', 'groups.*.firstAt', 'originSync.firstAt', 'commit.author_date', 'mtime');

function mapPath(value, segments, unit, convert = isoTimestamp) {
  if (!segments.length) return convert(value, unit);
  if (!value || typeof value !== 'object') return value;
  const [key, ...remaining] = segments;
  if (key === '*') {
    if (Array.isArray(value)) return value.map(item => mapPath(item, remaining, unit, convert));
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapPath(item, remaining, unit, convert)]));
  }
  if (!Object.hasOwn(value, key)) return value;
  return { ...value, [key]: mapPath(value[key], remaining, unit, convert) };
}

function project(value, schema, convert) {
  return schema.reduce((result, [name, unit]) => mapPath(result, name.split('.'), unit, convert), value);
}

/** Endpoint-specific catalogue. Opaque continuation fields and transcript payloads are excluded. */
export function projectApiTimestamps(pathname, value) {
  if (typeof pathname !== 'string' || !value) return value;
  if (pathname === '/api/instance') return project(value, INSTANCE);
  if (pathname === '/api/health') return project(value, ms('startedAt', 'source.*.*.updated_at'));
  if (pathname === '/api/groups/activity') return project(value, ms('start', 'groups.*.inbound.*'));
  if (pathname.startsWith('/api/groups/')) {
    return project(value, [...GROUP, ...beneath('rows.*', GROUP), ...beneath('group', GROUP), ...EVENTS,
      ...ms('messages.*.timestamp', 'runs.*.startAt', 'runs.*.endAt', 'firstAt', 'data.updatedAt')]);
  }
  if (pathname === '/api/schedules' || pathname.startsWith('/api/schedules/')) return project(value, SCHEDULE);
  if (pathname.startsWith('/api/memory/')) return project(value, MEMORY);
  if (pathname.startsWith('/api/usage/') || pathname === '/api/instance/resources') {
    return project(value, ms('since', 'until', 'messagesSampledAt', 'buckets.*', 'costByRuntime.*.at', 'tokensByRuntime.*.at',
      'messages.*.at', 'rotations.*.at', 'cache.*.at', 'series.*.at', 'current.at', 'cpuPeak.at', 'pm2.at'));
  }
  if (pathname === '/api/auth/token') return project(value, ms('expires_at'));
  if (pathname === '/api/keys' || pathname.startsWith('/api/keys/')) return project(value,
    ms('created_at', 'last_used_at', 'revoked_at', 'key.created_at', 'key.last_used_at', 'key.revoked_at',
      'keys.*.created_at', 'keys.*.last_used_at', 'keys.*.revoked_at'));
  if (pathname.startsWith('/api/chat/')) return project(value, [...CHAT, ...ACTIVITY]);
  if (pathname.startsWith('/api/observer/')) return project(value, ms('expiresAt', 'current.startedAt', 'sessions.*.startedAt',
    'sessions.*.updatedAt', 'session.startedAt', 'session.updatedAt', 'entries.*.ts', 'entry.ts'));
  if (pathname === '/api/fleet') return project(value, FLEET);
  if (pathname.startsWith('/api/fleet/')) return project(value, [...FLEET_RECORD, ...FLEET]);
  return value;
}

export function projectEventTimestamps(event, value) {
  if (event === 'instance') return project(value, INSTANCE);
  if (event === 'groups') return project(value, ms('readAt'));
  if (event === 'fleet') return project(value, FLEET);
  if (event === 'metric_update') return project(value, [...ms('timestamp', 'point.timestamp', 'point.at', 'data.timestamp'),
    ...seconds('dimensions.resets_at', 'dimensions.rate_limit_7d_resets_at', 'dimensions.rate_limit_5h_resets_at')]);
  if (event.startsWith('chat_')) return project(value, [...CHAT, ...ACTIVITY]);
  return value;
}

// Frontend calculations reverse only this same catalogue; opaque content and
// cursor fields remain untouched, and numeric internal models retain their units.
function sourceTimestamp(value, unit) {
  if (typeof value !== 'string') return value;
  const milliseconds = Date.parse(value);
  return unit === 's' ? milliseconds / 1000 : unit === 'julian' ? milliseconds / 86400000 + 2440587.5 : milliseconds;
}
export const scheduleTimes = value => project(value, SCHEDULE, sourceTimestamp);
export const activityTimes = value => project(value, ACTIVITY, sourceTimestamp);
