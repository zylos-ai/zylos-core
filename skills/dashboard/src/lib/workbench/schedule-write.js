import { execFile } from 'node:child_process';
import path from 'node:path';
import { localToOffsetIso } from './schedule-tz.js';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED = new Set(['result', 'code', 'message']);

const formError = (code, message) => Object.assign(new Error(message), { formCode: code });

function runChild(execute, file, argv, options) {
  return new Promise(resolve => {
    execute(file, argv, options, (error, stdout) => resolve({ error, stdout: String(stdout ?? '') }));
  });
}

function envelope(stdout) {
  const lines = stdout.trim().split('\n');
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0]);
    return value && typeof value === 'object' && typeof value.ok === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/** Every scheduler write goes through its CLI; the result comes only from the JSON envelope. */
export function createSchedulerCli({ zylosDir, execute = execFile, env = process.env } = {}) {
  const cliPath = path.join(zylosDir, '.claude', 'skills', 'scheduler', 'scripts', 'cli.js');
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  return async function schedulerCli(args) {
    const { stdout } = await runChild(execute, process.execPath, [cliPath, ...args, '--json'], {
      env: childEnv, cwd: zylosDir, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    const value = envelope(stdout);
    if (value?.ok === true) return { result: 'done', data: value.data };
    if (value?.ok === false && typeof value.error?.code === 'string') {
      const extra = Object.fromEntries(Object.entries(value.error).filter(([key]) => !RESERVED.has(key)));
      return { result: 'rejected', code: value.error.code, message: String(value.error.message ?? ''), ...extra };
    }
    return { result: 'unknown', reason: 'scheduler_cli_failed' };
  };
}

const text = (value, field) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw formError('invalid_form', `${field} must be text`);
  return value;
};

/**
 * Builds scheduler CLI arguments from the shared create/edit form. The form has
 * no delivery fields, so routing options never appear in the argument list.
 */
export function formToArgs(form, { id = null, tz = null } = {}) {
  if (!form || typeof form !== 'object' || Array.isArray(form)) throw formError('invalid_form', 'Form must be an object');
  const name = text(form.name, 'name');
  const prompt = text(form.prompt, 'prompt');
  // `add` takes the content as a positional argument, which the CLI reads as an
  // option when it starts with "--". Values after a flag are always values.
  if (id === null && prompt.startsWith('--')) throw formError('prompt_starts_with_dashes', 'New task content cannot start with "--"');
  const args = id === null ? ['add', prompt] : ['update', id];
  if (name) args.push('--name', name);
  if (id !== null && prompt) args.push('--prompt', prompt);
  const schedule = form.schedule;
  if (schedule !== undefined && schedule !== null) {
    const value = text(schedule.value, 'schedule');
    if (schedule.kind === 'cron') args.push('--cron', value);
    else if (schedule.kind === 'every') args.push('--every', value);
    else if (schedule.kind === 'at') {
      if (!tz) throw formError('tz_unavailable', 'Time zone is unknown');
      const parsed = localToOffsetIso(value, tz);
      if (!parsed) throw formError('invalid_time', 'Time must be YYYY-MM-DDTHH:MM');
      args.push('--at', parsed.iso);
    } else throw formError('invalid_form', 'Unknown schedule kind');
  } else if (id === null) throw formError('invalid_form', 'Schedule is required');
  for (const [field, flag] of [['priority', '--priority'], ['missThreshold', '--miss-threshold']]) {
    const value = form[field];
    if (value === undefined || value === null || value === '') continue;
    if (!/^-?\d{1,9}$/.test(String(value))) throw formError('invalid_form', `${field} must be a whole number`);
    args.push(flag, String(value));
  }
  if (form.requireIdle === true) args.push('--block-queue-until-idle');
  else if (id !== null && form.requireIdle === false) args.push('--no-block-queue-until-idle');
  return args;
}

export function createScheduleWrite({ zylosDir, scheduleTz, schedulerCli = createSchedulerCli({ zylosDir }) } = {}) {
  async function write(method, pathname, readBody) {
    const route = pathname.match(/^\/api\/workbench\/schedule(?:\/([^/]+)(?:\/(pause|resume))?)?$/);
    if (!route) return null;
    let id = null;
    if (route[1] !== undefined) {
      try {
        id = decodeURIComponent(route[1]);
      } catch {
        id = '';
      }
      if (!TASK_ID.test(id)) return { status: 400, body: { result: 'rejected', code: 'invalid_task', message: 'Invalid task id' } };
    }
    let args;
    if (method === 'POST' && id === null) args = 'add';
    else if (method === 'PUT' && id !== null && !route[2]) args = 'update';
    else if (method === 'DELETE' && id !== null && !route[2]) args = ['remove', id];
    else if (method === 'POST' && id !== null && route[2]) args = [route[2], id];
    else return null;
    if (!Array.isArray(args)) {
      const form = await readBody();
      try {
        const needsTz = form?.schedule?.kind === 'at';
        const tz = needsTz ? (await scheduleTz()).tz : null;
        args = formToArgs(form, { id: args === 'add' ? null : id, tz });
      } catch (error) {
        if (!error.formCode) throw error;
        return { status: 400, body: { result: 'rejected', code: error.formCode, message: error.message } };
      }
    }
    const outcome = await schedulerCli(args);
    const status = outcome.result === 'done' ? 200 : outcome.result === 'rejected' ? 400 : 502;
    return { status, body: outcome };
  }
  return { write };
}
