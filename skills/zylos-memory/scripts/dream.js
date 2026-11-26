#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCoreModule } from '../../activity-monitor/scripts/core-modules.js';
import { durableJson } from '../../activity-monitor/scripts/runtime-generation.js';
import { DEFAULT_ALERT_DESTINATION } from '../../activity-monitor/scripts/supervisor-server-health.js';
import { parseServerAlertTarget } from '../../activity-monitor/scripts/supervisor-server-observation.js';
import { SyncAlertEpisodes } from '../../activity-monitor/scripts/sync-alert-episodes.js';
import { systemSendEnvironment } from '../../comm-bridge/scripts/c4-system-send-env.js';
import { loadTimezone } from '../../scheduler/scripts/tz.js';
import { dreamLock, dreamRunDirectory, DREAM_HEARTBEAT_MS } from './dream-lock.js';
import { createDreamModel } from './dream-model.js';
import { runDreamRound } from './dream-round.js';
import { isMainModule } from './is-main-module.js';

const ALERT = { scope: '*', kind: 'global', type: 'dream_consecutive_failure' };

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function notify(config, message) {
  const selected = parseServerAlertTarget(config.alert_target);
  const target = selected?.default || !selected ? DEFAULT_ALERT_DESTINATION : selected;
  const script = fileURLToPath(new URL('../../comm-bridge/scripts/c4-send.js', import.meta.url));
  return new Promise(resolve => {
    const child = execFile(process.execPath, [script, target.channel, target.endpoint], {
      timeout: 30_000, env: systemSendEnvironment(process.env, { notice: true }),
    }, error => {
      if (error) console.error(`Dream notification failed: ${error.code ?? 'delivery failure'}`);
      resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(message + '\n');
  });
}

export async function runDream({ root, config, date, timezone, signal: requestedSignal,
  newModel = createDreamModel, database = () => import('../../comm-bridge/scripts/c4-db.js'),
  send = message => notify(config, message), lock = dreamLock(root),
}) {
  const day = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day.valueOf()) || day.toISOString().slice(0, 10) !== date) {
    throw new Error('Expected the dream calendar date (YYYY-MM-DD)');
  }
  if (requestedSignal?.aborted) requestedSignal.throwIfAborted();
  const token = await lock.acquire();
  if (!token) return { skipped: 'already running' };
  const controller = new AbortController();
  const signal = requestedSignal ? AbortSignal.any([requestedSignal, controller.signal]) : controller.signal;
  const mutate = action => {
    signal.throwIfAborted();
    return lock.guard(token, action);
  };
  const directory = path.join(dreamRunDirectory(root), date);
  const record = path.join(directory, 'run.json');
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing || signal.aborted) return;
    renewing = true;
    try { await lock.heartbeat(token); }
    catch (error) { controller.abort(error); }
    finally { renewing = false; }
  }, DREAM_HEARTBEAT_MS);
  try {
    if (readRecord(record)) return { skipped: 'already attempted' };
    await mutate(() => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      durableJson(record, { status: 'started', date });
    });
    const weekday = day.getUTCDay();
    const tidyWeekday = Number(config.memory_tidy_weekday ?? 0);
    let result;
    try {
      let model;
      const call = async options => {
        model ??= newModel(root, config);
        return (await model)(options);
      };
      result = await runDreamRound({ root, date, timezone, weekday, tidyWeekday, db: await database(),
        model: call, directory, token, mutate, notify: send, signal });
    } catch (error) {
      result = { failed: true, warnings: [], error: error.message };
      if (controller.signal.aborted) throw error;
    }
    await lock.guard(token, () => durableJson(record, { status: result.failed ? 'failed' : 'ok', date, ...result }));
    const episodes = new SyncAlertEpisodes({ file: path.join(dreamRunDirectory(root), 'alert-episodes.json') });
    const yesterday = new Date(day.getTime() - 86400_000).toISOString().slice(0, 10);
    const previous = readRecord(path.join(dreamRunDirectory(root), yesterday, 'run.json'));
    if (!result.failed || !previous || previous.status === 'ok') episodes.reconcile({ resolved: [ALERT] });
    if (result.failed && previous && previous.status !== 'ok' && episodes.claim(ALERT)) {
      result.warnings.push('Memory dreaming had failures on two consecutive days. Unprocessed conversations remain available for the next run.');
    }
    if (result.warnings.length) await send(result.warnings.join('\n'));
    return result;
  } finally {
    clearInterval(timer);
    await lock.release(token);
  }
}

async function main() {
  const { ZYLOS_DIR, readZylosConfigOrThrow } = await loadCoreModule('config.js');
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(new Error(`Dream interrupted by ${name}`)));
  const result = await runDream({ root: ZYLOS_DIR, config: readZylosConfigOrThrow(), date: process.argv[2],
    timezone: loadTimezone(ZYLOS_DIR), signal: controller.signal });
  console.log(result.skipped ? `Dream skipped: ${result.skipped}` : `Dream finished: ${result.failed ? 'failed' : 'ok'}`);
  if (result.failed) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(`Memory dreaming failed: ${error.code ?? error.message}`); process.exitCode = 1; }
}
