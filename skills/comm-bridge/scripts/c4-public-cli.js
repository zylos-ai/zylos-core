import path from 'node:path';
import { SKILLS_DIR } from './c4-config.js';
import * as db from './c4-db.js';
import { createStore } from './c4-v2-store.js';
import { createQueryHandlers } from './c4-v2-cli.js';
import { dataError, requireGroup } from './c4-session-group.js';
import { formatQueryError, replyVia } from './c4-query-format.js';

const query = createQueryHandlers(createStore(db.getDb));
const sendPath = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-send.js');
const invalid = message => { throw dataError('INVALID_ARGS', message); };
const number = (raw, name, min = 0) => {
  if (!/^(0|[1-9][0-9]*)$/.test(raw ?? '') || !Number.isSafeInteger(Number(raw)) || Number(raw) < min) invalid(`${name} must be an integer >= ${min}`);
  return Number(raw);
};
function options(args, values = [], flags = []) {
  const result = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(result, key)) invalid(`Duplicate option ${arg}`);
    if (flags.includes(key)) result[key] = true;
    else if (values.includes(key)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) invalid(`Missing value for ${arg}`);
      result[key] = args[++i];
    } else invalid(`Unknown option ${arg}`);
  }
  return { ...result, positional };
}
const noPositionals = o => { if (o.positional.length) invalid('Unexpected positional arguments'); };
const group = (o, global = false) => o.group === undefined ? '*' : requireGroup(o.group, { global });
const json = data => JSON.stringify({ ok: true, data }) + '\n';
const display = (data, o) => o.json ? json(data) : JSON.stringify(data, null, 2) + '\n';
function conversations(rows) {
  return rows.map(row => {
    const route = row.direction === 'in' && row.endpoint_id !== null ? '\n' + replyVia(row, sendPath) : '';
    return `[${row.timestamp}] ${row.direction === 'in' ? 'IN' : 'OUT'} (${row.channel}${row.endpoint_id ? ':' + row.endpoint_id : ''}):\n${row.content}${route}\n`;
  }).join('\n');
}
function checkpoint(args, positionalSummary = false) {
  const o = options(args, ['group', 'summary'], ['no-content', 'json']);
  if (o.positional.length < 1 || o.positional.length > (positionalSummary ? 2 : 1)) invalid('Checkpoint requires an end id');
  const end = number(o.positional[0], 'end');
  if (o.positional.length === 2) {
    if (o.summary !== undefined) invalid('Summary specified twice');
    o.summary = o.positional[1];
  }
  if ((o.summary !== undefined) === Boolean(o['no-content'])) throw dataError('SUMMARY_INVALID', 'Choose exactly one of --summary or --no-content');
  const row = db.createCheckpoint(group(o, true), end, o.summary ?? null, { noContent: Boolean(o['no-content']) });
  return o.json ? json(row) : 'Checkpoint created: ' + JSON.stringify(row) + '\n';
}
export function databaseCli(args) {
  const [command, ...rest] = args;
  if (command === 'checkpoint') return checkpoint(rest, true);
  if (command === 'insert') {
    const o = options(rest, ['session-group'], ['json']);
    if (o.positional.length !== 4) invalid('insert requires direction, channel, endpoint and content');
    const [direction, channel, endpoint, content] = o.positional;
    const input = o['session-group'] === undefined ? {} : { groupName: o['session-group'] };
    const row = db.insertConversation(direction, channel, endpoint === 'null' ? null : endpoint, content, input);
    return o.json ? json(row) : 'Inserted: ' + JSON.stringify(row) + '\n';
  }
  if (command === 'namespace') {
    const [action, ...args] = rest;
    const o = options(args, [], ['json']);
    if (!['get','ensure','register'].includes(action) || o.positional.length !== (action === 'register' ? 2 : 1)) invalid('namespace get|ensure <component> | register <component> <namespace>');
    return display(({ get: db.getChannelNamespace, ensure: db.ensureChannelNamespace, register: db.registerChannelNamespace })[action](...o.positional), o);
  }
  if (command === 'session-group') {
    const o = options(rest, ['session-group'], ['json']);
    if (o.positional.length !== 1) invalid('session-group requires a component');
    const binding = db.getChannelNamespace(o.positional[0]);
    if (!binding) throw dataError('SESSION_GROUP_NOT_FOUND', 'Component has no namespace');
    const value = db.composeSessionGroup(binding.namespace, o['session-group']);
    return o.json ? json(value) : value + '\n';
  }
  if (command === 'unsummarized') {
    const o = options(rest, ['group'], ['json']); noPositionals(o);
    return display(query.unsummarizedRange({ group: o.group }), o);
  }
  if (command === 'groups') {
    const o = options(rest, ['match', 'limit'], ['json']); noPositionals(o);
    return display(query.groups({ match: o.match, limit: o.limit === undefined ? undefined : number(o.limit, 'limit', 1) }), o);
  }
  if (command === 'origin-sync' && rest[0] === 'backlog') {
    const o = options(rest.slice(1), [], ['json']); noPositionals(o); return display(query.originBacklog(), o);
  }
  if (command === 'mode-transition' && rest[0] === 'show') {
    const o = options(rest.slice(1), ['run-id'], ['json']); noPositionals(o);
    if (o['run-id'] !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(o['run-id'])) invalid('run-id must be a UUID');
    return display(query.modeTransition({ runId: o['run-id'] }), o);
  }
  if (command === 'recent') {
    const o = options(rest, [], ['json']); if (o.positional.length > 1) invalid('Too many limits');
    return display(db.getRecentConversations(o.positional.length ? number(o.positional[0], 'limit', 1) : 20), o);
  }
  if (command === 'checkpoints') { const o = options(rest, [], ['json']); noPositionals(o); return display(db.getCheckpoints(), o); }
  if (command === 'init') { const o = options(rest); noPositionals(o); db.getDb(); return 'Database initialized\n'; }
  if (!command || ['--help','-h'].includes(command)) return 'c4-db.js: init | insert <in|out> <channel> <endpoint> <content> [--session-group G] | checkpoint <end> (--summary TEXT|--no-content) | unsummarized [--group G] | groups | origin-sync backlog | mode-transition show | recent | checkpoints\n';
  invalid(`Unknown command ${command}`);
}
export function checkpointCli(args) {
  const [command, ...rest] = args;
  if (command === 'create') return checkpoint(rest);
  if (command === 'latest' || command === 'list') {
    const o = options(rest, command === 'list' ? ['group','limit'] : ['group'], ['json']); noPositionals(o);
    const scope = group(o, true);
    if (command === 'latest') return display(db.getLatestContentCheckpoint(scope), o);
    let rows = db.getCheckpoints().filter(row => row.session_group === scope).sort((a, b) => b.id - a.id);
    if (o.limit !== undefined) rows = rows.slice(0, number(o.limit, 'limit', 1));
    return display(rows, o);
  }
  if (!command) invalid('Usage: c4-checkpoint.js requires a command');
  if (['--help','-h'].includes(command)) return 'Usage: c4-checkpoint.js create <end> [--group G] (--summary TEXT|--no-content) | list [--group G] [--limit N] | latest [--group G]\n';
  invalid(`Unknown checkpoint command ${command}`);
}
export function fetchCli(args) {
  if (!args.length) invalid('Usage: c4-fetch.js requires a query');
  if (args.length === 1 && ['--help','-h'].includes(args[0])) return 'c4-fetch.js --unsummarized [--group G] [--up-to ID] [--limit N] | --begin ID --end ID | --checkpoints --after ID | --origin-sync --group G (--summaries-only|--raw-only --after ID) | --absorbed --run-id UUID [--summary|--id ID|--after ID]\n';
  const modes = ['unsummarized','checkpoints','origin-sync','absorbed'];
  const selected = modes.filter(key => args.includes('--' + key));
  if (selected.length > 1) invalid('Fetch modes are mutually exclusive');
  const mode = selected[0] ?? 'range';
  const allowed = {
    unsummarized: [['group','up-to','limit'], ['unsummarized','json']],
    checkpoints: [['group','after'], ['checkpoints','json']],
    'origin-sync': [['group','after','limit'], ['origin-sync','summaries-only','raw-only','json']],
    absorbed: [['run-id','group','scope-after','after','limit','id','field','offset','max-bytes'], ['absorbed','summary','json']],
    range: [['begin','end'], ['json']],
  };
  const o = options(args, ...allowed[mode]); noPositionals(o);
  if (mode === 'absorbed') {
    const request = {};
    for (const [key, value] of Object.entries(o)) {
      if (['positional','absorbed'].includes(key)) continue;
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      request[camel] = ['after','limit','id','offset','max-bytes'].includes(key) ? number(value, key, ['limit','id'].includes(key) ? 1 : 0) : value;
    }
    return query.absorbed(request);
  }
  if (mode === 'unsummarized') {
    const result = query.unsummarized({ group: o.group, upToConversationId: o['up-to'] === undefined ? undefined : number(o['up-to'], 'up-to'), limit: o.limit === undefined ? undefined : number(o.limit, 'limit', 1) });
    return o.json ? json(result) : `unsummarized scope=${group(o)} checkpointEnd=${result.checkpointEnd}\n${result.checkpointSummary === null ? '' : '[Last Checkpoint Summary] ' + result.checkpointSummary + '\n'}${conversations(result.rows)}\ncount=${result.rows.length} upTo=${result.upTo} safeEnd=${result.safeEnd}\n`;
  }
  if (mode === 'checkpoints') return display(query.checkpoints({ group: o.group, after: number(o.after, 'after') }), o);
  if (mode === 'origin-sync') {
    if (o['summaries-only'] && o['raw-only']) invalid('Summary and raw modes are mutually exclusive');
    if (!o['summaries-only'] && !o['raw-only']) {
      if (o.after !== undefined) invalid('after requires --raw-only');
      return display(query.originCombined({ group: o.group, limit: o.limit === undefined ? undefined : number(o.limit, 'limit', 1) }), o);
    }
    if (o['summaries-only']) {
      if (o.after !== undefined || o.limit !== undefined) invalid('Summary read does not accept after or limit');
      return display(query.originSummaries({ group: o.group }), o);
    }
    const rows = query.originRaw({ group: o.group, after: number(o.after, 'after'), limit: o.limit === undefined ? undefined : number(o.limit, 'limit', 1) });
    return o.json ? json(rows) : conversations(rows) + '\n';
  }
  const begin = number(o.begin, 'begin'), end = number(o.end, 'end');
  if (begin > end) invalid('begin must not exceed end');
  const checkpoint = db.getLatestContentCheckpoint('*');
  const rows = db.getConversationsByRange(begin, end);
  return o.json ? json({ checkpoint, rows }) : `${checkpoint?.summary ? '[Last Checkpoint Summary] ' + checkpoint.summary + '\n\n' : ''}[Conversations] (id ${begin} ~ ${end})\n${conversations(rows) || 'No conversations in this range.\n'}`;
}
export function runCli(kind, args) {
  try { process.stdout.write(({ database: databaseCli, checkpoint: checkpointCli, fetch: fetchCli })[kind](args)); }
  catch (error) {
    const maxIndex = args.indexOf('--max-bytes');
    const encoded = formatQueryError(error, { json: args.includes('--json'), maxBytes: maxIndex < 0 ? undefined : Number(args[maxIndex + 1]) });
    (args.includes('--json') ? process.stdout : process.stderr).write(encoded);
    process.exitCode = 1;
  } finally { db.close(); }
}
