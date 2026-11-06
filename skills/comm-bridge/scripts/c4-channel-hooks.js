import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolveCoreConfigModule } from './core-config-loader.js';
import { sendError } from './c4-send-args.js';
import { runHookProcess } from './c4-hook-process.js';

// Resolve Core's declared YAML dependency in both repository and installed layouts.
const yaml = createRequire(resolveCoreConfigModule())('js-yaml');
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read only the actual target channel's current frontmatter, without registering it. */
export function readChannelHookMetadata(channel, { skillsDir } = {}) {
  if (['internal', 'void', 'system'].includes(channel)) return null;
  if (typeof channel !== 'string' || !channel || channel.includes('..') || /[/\\]/.test(channel)) {
    throw sendError('INVALID_ARGS', 'Invalid channel name');
  }
  const directory = path.join(skillsDir, channel);
  try {
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Missing channel');
  } catch {
    throw sendError('INVALID_ARGS', 'Invalid channel: component unavailable');
  }
  let source;
  try { source = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw sendError('HOOK_INVALID_OUTPUT', 'Cannot read channel hook declaration');
  }
  const lines = source.split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0])) return null;
  const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
  if (end === -1) throw sendError('HOOK_INVALID_OUTPUT', 'Unterminated channel frontmatter');
  let metadata;
  try { metadata = yaml.load(lines.slice(1, end).join('\n'), { schema: yaml.JSON_SCHEMA }); }
  catch { throw sendError('HOOK_INVALID_OUTPUT', 'Invalid channel frontmatter YAML'); }
  if (metadata === undefined || metadata === null) return null;
  if (!mapping(metadata)) throw sendError('HOOK_INVALID_OUTPUT', 'Channel frontmatter must be a mapping');
  if (!Object.hasOwn(metadata, 'c4')) return null;
  if (!mapping(metadata.c4)) throw sendError('HOOK_INVALID_OUTPUT', 'Channel c4 declaration must be a mapping');
  return metadata.c4;
}

/** Validate the sole synchronous script declared by this installed channel. */
export function readBeforeSendHook(channel, { skillsDir } = {}) {
  const metadata = readChannelHookMetadata(channel, { skillsDir });
  if (metadata === null) return null;
  const invalid = message => { throw sendError('HOOK_INVALID_OUTPUT', message); };
  if (Object.keys(metadata).some(key => !['before_send', 'delivery'].includes(key))) {
    invalid('Unsupported channel hook event or declaration');
  }
  if (Object.hasOwn(metadata, 'delivery') && metadata.delivery !== 'stdin') invalid('Unsupported channel delivery declaration');
  if (!Object.hasOwn(metadata, 'before_send')) return null;
  const hook = metadata.before_send;
  if (!mapping(hook) || Object.keys(hook).some(key => !['hook_id', 'entry', 'timeout_ms', 'async'].includes(key))) {
    invalid('BeforeSend must declare one script hook');
  }
  if (typeof hook.hook_id !== 'string' || !hook.hook_id.trim() ||
      typeof hook.entry !== 'string' || !hook.entry || hook.entry.includes('\0') ||
      !Number.isFinite(hook.timeout_ms) || hook.timeout_ms <= 0 ||
      (Object.hasOwn(hook, 'async') && hook.async !== false)) {
    invalid('BeforeSend requires hook_id, script entry and a finite positive timeout_ms; async is unsupported');
  }
  if (path.isAbsolute(hook.entry)) invalid('BeforeSend entry must be relative to the channel');
  let directory, entry;
  try {
    directory = fs.realpathSync(path.join(skillsDir, channel));
    const candidate = path.resolve(directory, hook.entry);
    const contained = target => {
      const relative = path.relative(directory, target);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    if (!contained(candidate)) invalid('BeforeSend entry escapes its channel');
    entry = fs.realpathSync(candidate);
    if (!contained(entry) || !fs.statSync(entry).isFile()) invalid('BeforeSend entry must be a file inside its channel');
  } catch (error) {
    if (error.code === 'HOOK_INVALID_OUTPUT') throw error;
    invalid('BeforeSend entry must be a readable file inside its channel');
  }
  return { hookId: hook.hook_id, entry, timeoutMs: hook.timeout_ms, directory };
}

/** Process failures take precedence over any apparently valid hook wire output. */
export function assertHookProcessSucceeded(result) {
  if (result.timedOut) throw sendError('HOOK_TIMEOUT', 'BeforeSend hook timed out');
  if (result.outputTooLarge) throw sendError('HOOK_INVALID_OUTPUT', 'BeforeSend hook output exceeds 1 MiB');
  if (result.error || result.exitCode !== 0 || result.signal) {
    throw sendError('HOOK_EXEC_FAILED', 'BeforeSend hook execution failed');
  }
}

/** The accepted wire normalizes human messages without changing the reason. */
export function normalizeHookMessage(message) {
  return Array.from(message.replace(/[\r\n\u2028\u2029]/gu, ' ')).slice(0, 500).join('');
}

export function parseBeforeSendOutput(stdout) {
  const invalid = () => { throw sendError('HOOK_INVALID_OUTPUT', 'BeforeSend hook returned invalid output'); };
  let output;
  try { output = JSON.parse(stdout); } catch { invalid(); }
  if (!mapping(output) || output.version !== 1) invalid();
  const keys = Object.keys(output);
  if (output.decision === 'continue') {
    if (keys.length !== 2 || keys.some(key => !['version', 'decision'].includes(key))) invalid();
    return output;
  }
  if (output.decision !== 'abort' || typeof output.message !== 'string' || keys.length !== 3 ||
      keys.some(key => !['version', 'decision', 'message'].includes(key))) invalid();
  return { version: 1, decision: 'abort', message: normalizeHookMessage(output.message) };
}

function available(value) { return typeof value === 'string' && value.trim() !== ''; }

function existingContext(channel, env) {
  const context = { component: channel };
  if (available(env.ZYLOS_SESSION_GROUP)) context.session_group = env.ZYLOS_SESSION_GROUP;
  if (available(env.ZYLOS_RUN_ID)) context.run_id = env.ZYLOS_RUN_ID;
  try {
    const runtime = JSON.parse(env.ZYLOS_MODEL_CONFIG).runtime;
    if (available(runtime)) context.runtime = runtime;
  } catch { /* Optional launch context is unavailable outside a managed run. */ }
  const candidates = context.runtime === 'codex' ? [env.CODEX_SESSION_ID]
    : context.runtime === 'claude' ? [env.CLAUDE_SESSION_ID]
      : [env.CODEX_SESSION_ID, env.CLAUDE_SESSION_ID].filter(available);
  if (candidates.length === 1 && available(candidates[0])) context.session_id = candidates[0];
  return context;
}

/** Gate this channel's original request without reading or creating C4 state. */
export async function runBeforeSendHook(request, content, { skillsDir, env = process.env, run = runHookProcess } = {}) {
  const declaration = readBeforeSendHook(request.channel, { skillsDir });
  if (declaration === null) return null;
  if ((request.endpoint !== null && typeof request.endpoint !== 'string') || typeof content !== 'string' || (request.groupName !== undefined && typeof request.groupName !== 'string') ||
      (request.wholeGroup !== undefined && typeof request.wholeGroup !== 'boolean')) {
    throw sendError('INVALID_ARGS', 'Invalid BeforeSend request content or options');
  }
  const options = {};
  if (request.groupName !== undefined) options.groupName = request.groupName;
  if (request.wholeGroup !== undefined) options.wholeGroup = request.wholeGroup;
  const input = {
    version: 1, hook_event_name: 'BeforeSend', hook_id: declaration.hookId,
    request_id: randomUUID(), invocation_id: randomUUID(),
    request: { channel: request.channel, endpoint: request.endpoint, content, options },
    context: existingContext(request.channel, env),
  };
  let result;
  try {
    result = await run({ command: 'node', args: [declaration.entry], input: JSON.stringify(input),
      timeoutMs: declaration.timeoutMs, cwd: declaration.directory, env });
  } catch { throw sendError('HOOK_EXEC_FAILED', 'BeforeSend hook execution failed'); }
  assertHookProcessSucceeded(result);
  const output = parseBeforeSendOutput(result.stdout);
  if (output.decision === 'abort') throw sendError('HOOK_ABORTED', output.message);
  return output;
}
