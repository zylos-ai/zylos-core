#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquire, release, guard, memoryScope, requireSyncToken } from './sync-lock.js';
import { cleanup, rotate, list, checkpoint, prepare, commit } from './sync-files.js';
import { parseStateHeader } from './state-format.js';
import { options, inputError, isMain, runCli, readInput, parseJson, helpRequested } from './sync-cli.js';
import { createQueryHandlers } from '../../comm-bridge/scripts/c4-v2-cli.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { readZylosConfigStrict } from '../../comm-bridge/scripts/local-config.js';
import { SKILLS_DIR } from '../../comm-bridge/scripts/c4-config.js';
import { formatUnsummarized } from '../../comm-bridge/scripts/c4-fetch-format.js';
import { createBatchReceipt } from '../../comm-bridge/scripts/c4-sync-batch.js';
import { parseSupervisorConfiguration } from '../../activity-monitor/scripts/supervisor-configuration.js';

const prefix = 'group-sync-';
const directory = (scope, token) => path.join(scope.runDir, prefix + token);
const describe = file => {
  const bytes = fs.readFileSync(file);
  return { path: path.resolve(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
function save(dir, value) {
  const temporary = path.join(dir, 'run.json.tmp');
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, path.join(dir, 'run.json'));
}
function exportFile(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  return describe(file);
}
async function database(deps) {
  if (deps.database) return deps.database;
  const db = await import('../../comm-bridge/scripts/c4-db.js');
  return Object.assign(createStore(db.getDb, { readConfig: readZylosConfigStrict }), { getDb: db.getDb, getConversationsByRange: db.getConversationsByRange });
}
const settingsFor = settings => ({ ...settings, kind: 'group' });

// Called on every terminal path, including failures. Only this token's private
// directory is removed; release itself cannot remove a replacement marker.
export async function closeRun(settings) {
  requireSyncToken(settings.token);
  const scope = await memoryScope(settings.env);
  const warnings = [];
  const dir = directory(scope, settings.token);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true }); }
  catch (error) { warnings.push(`Export cleanup failed: ${error.message}`); }
  let released = false;
  try { await release(settingsFor(settings)); released = true; }
  catch (error) { warnings.push(`Release failed: ${error.message}`); }
  return { released, warnings };
}

export async function startRun(settings = {}, deps = {}) {
  const bound = settingsFor(settings);
  const token = await acquire(bound, deps);
  const active = { ...bound, token };
  try {
    const store = await database(deps), query = createQueryHandlers(store);
    const range = await guard(active, ({ scope }) => query.unsummarizedRange({ group: scope }));
    if (!range.count) return { noInput: true, ...await closeRun(active) };
    const manifest = await guard(active, scope => {
      // Acquisition proved every older group token stale. Remove only owned
      // run directories, under the guard so an old worker cannot remove ours.
      for (const name of fs.readdirSync(scope.runDir)) {
        if (/^group-sync-[0-9a-f]{32}$/.test(name) && name !== prefix + token) {
          fs.rmSync(path.join(scope.runDir, name), { recursive: true });
        }
      }
      const dir = directory(scope, token);
      fs.mkdirSync(dir, { mode: 0o700 });
      let config = {};
      try { config = JSON.parse(fs.readFileSync(path.join(scope.root, '.zylos/config.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const batchLimit = parseSupervisorConfiguration(config, settings.env || process.env).syncBatchLimit;
      const batch = query.unsummarized({ group: scope.scope, upToConversationId: range.safeEnd, limit: batchLimit });
      const receipt = createBatchReceipt(batch.rows, { scope: scope.scope, after: store.getCoverageEnd(scope.scope), end: batch.rows.at(-1)?.id ?? batch.upTo });
      const value = { token, directory: dir, batchLimit, end: receipt.end,
        batch: exportFile(dir, 'batch.txt', formatUnsummarized(batch, { scope: scope.scope, getDatabase: store.getDb,
          sendPath: path.join(SKILLS_DIR, 'comm-bridge/scripts/c4-send.js') })), receipt };
      save(dir, value);
      return value;
    });
    await cleanup(active); await rotate(active);
    return await guard(active, async scope => {
      const inputs = await list(active);
      let state = null;
      try { state = describe(inputs.statePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const header = parseStateHeader(state ? fs.readFileSync(state.path, 'utf8') : '', { scope: scope.scope });
      const summaries = query.checkpoints({ group: scope.scope, after: header.valid && header.coverage >= 0 ? (header.coverage ?? 0) : 0 });
      const result = { ...manifest, inputs, state,
        summaries: exportFile(manifest.directory, 'summaries.json', summaries) };
      save(manifest.directory, result);
      // Receipts stay in run.json; the worker does not copy them into commands.
      const { receipt, ...output } = result;
      return output;
    });
  } catch (error) {
    error.cleanup = await closeRun(active);
    if (error.cleanup.warnings.length) error.message += `; ${error.cleanup.warnings.join('; ')}`;
    throw error;
  }
}

async function loadRun(settings) {
  return guard(settingsFor(settings), scope => {
    const dir = directory(scope, settings.token);
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    if (run.token !== settings.token || run.directory !== dir || !run.inputs) throw inputError('Incomplete Sync run');
    return run;
  });
}
export async function summarizeRun(settings, summary, deps = {}) {
  if (typeof summary !== 'string' || !summary.trim()) throw inputError('Expected a nonempty summary on stdin');
  const active = settingsFor(settings), run = await loadRun(active);
  if (!run.checkpoint) {
    run.checkpoint = await checkpoint({ ...active, summary, end: run.end, batch: run.receipt }, { database: await database(deps) });
    await guard(active, () => save(run.directory, run));
  }
  // A corrected prepare call never replays an already completed checkpoint.
  const result = await prepare(active);
  return { checkpoint: run.checkpoint, end: run.end, ...result };
}
export async function finishRun(settings, input, deps = {}) {
  if (!input || Object.keys(input).some(key => key !== 'followedUpIds') || !Array.isArray(input.followedUpIds)) throw inputError('Expected only {followedUpIds:[]}');
  const active = settingsFor(settings), run = await loadRun(active);
  const result = await commit({ ...active, input: { ...input, batch: run.receipt, inputs: run.inputs } }, { database: await database(deps) });
  return { ...result, ...await closeRun(active) };
}

if (isMain(import.meta.url)) await runCli(async () => {
  if (helpRequested(process.argv.slice(2), ['token'])) {
    console.log('Usage: sync-run.js start | summarize --token T < summary | finish --token T < {"followedUpIds":[]} | abort --token T');
    return;
  }
  const [command, ...args] = process.argv.slice(2), parsed = options(args, ['token']);
  if (parsed.positional.length || !['start', 'summarize', 'finish', 'abort'].includes(command) || (command === 'start' && parsed.token)) throw inputError('Invalid Sync run command');
  const settings = { token: parsed.token };
  if (command !== 'start') requireSyncToken(parsed.token);
  const result = command === 'start' ? await startRun()
    : command === 'summarize' ? await summarizeRun(settings, readInput())
      : command === 'finish' ? await finishRun(settings, parseJson(readInput())) : await closeRun(settings);
  console.log(JSON.stringify(result));
});
