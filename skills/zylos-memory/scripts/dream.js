#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadCoreModule } from '../../activity-monitor/scripts/core-modules.js';
import { durableJson } from '../../activity-monitor/scripts/runtime-generation.js';
import { notifyOwner } from '../../comm-bridge/scripts/c4-owner-alert.js';
import { dreamLock, dreamRunDirectory, DREAM_HEARTBEAT_MS } from './dream-lock.js';
import { createDreamModel } from './dream-model.js';
import { runDreamRound } from './dream-round.js';
import { isMainModule } from './is-main-module.js';

const ALERT = { scope: '*', kind: 'global', type: 'dream_consecutive_failure' };

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function claimFailureAlert(file, ongoing) {
  try {
    const record = readRecord(file);
    const episode = record?.episodes?.[0];
    if (record && (record.version !== 1 || !Array.isArray(record.episodes) || record.episodes.length > 1 ||
        (record.episodes.length === 1 && (!episode || typeof episode.sent !== 'boolean' ||
          Object.keys(ALERT).some(key => episode.alert?.[key] !== ALERT[key]))))) {
      throw new Error('Invalid dream alert state');
    }
    if (ongoing && !episode?.sent) {
      durableJson(file, { version: 1, episodes: [{ alert: ALERT, sent: true }] });
      return true;
    }
    if (!ongoing && episode) durableJson(file, { version: 1, episodes: [] });
  } catch (error) {
    console.error(`Dream alert state unavailable: ${error.code ?? error.message}`);
  }
  return false;
}

export async function runDream({ root, config, date: runDate, timezone, signal: requestedSignal,
  newModel = createDreamModel, database = () => import('../../comm-bridge/scripts/c4-db.js'),
  send = message => notifyOwner(message, { readConfig: () => config,
    log: error => console.error(`Dream notification failed: ${error.code ?? 'delivery failure'}`) }),
  lock = dreamLock(root),
}) {
  const day = new Date(`${runDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !Number.isFinite(day.valueOf()) || day.toISOString().slice(0, 10) !== runDate) {
    throw new Error('Expected the dream calendar date (YYYY-MM-DD)');
  }
  const weekday = day.getUTCDay();
  // The supervisor supplies the workspace calendar date. Subtract a day without a local DST shift.
  day.setUTCDate(day.getUTCDate() - 1);
  const date = day.toISOString().slice(0, 10);
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
    day.setUTCDate(day.getUTCDate() - 1);
    const previous = readRecord(path.join(dreamRunDirectory(root), day.toISOString().slice(0, 10), 'run.json'));
    const consecutiveFailure = result.failed && previous && previous.status !== 'ok';
    if (claimFailureAlert(path.join(dreamRunDirectory(root), 'alert-episodes.json'), consecutiveFailure)) {
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
  const { readWorkspaceTimezone } = await loadCoreModule('env.js');
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(new Error(`Dream interrupted by ${name}`)));
  const result = await runDream({ root: ZYLOS_DIR, config: readZylosConfigOrThrow(), date: process.argv[2],
    timezone: readWorkspaceTimezone(ZYLOS_DIR), signal: controller.signal });
  console.log(result.skipped ? `Dream skipped: ${result.skipped}` : `Dream finished: ${result.failed ? 'failed' : 'ok'}`);
  if (result.failed) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(`Memory dreaming failed: ${error.code ?? error.message}`); process.exitCode = 1; }
}
