import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOwnerName } from '../../comm-bridge/scripts/dashboard-source.js';
import { durableJson } from '../../activity-monitor/scripts/runtime-generation.js';
import { makeDreamBatches } from './dream-history.js';
import { repairPageHeaders, stageTwoInput, tidyReference, PAGE_SOFT_LIMIT } from './dream-pages.js';
import { DREAM_RESULT_SCHEMAS, parseDreamResult } from './dream-results.js';
import { publishReferenceFile } from './reference-index.js';
import { resolveAllowedMemoryPath } from './self-write.js';

const TEMPLATE = new URL('../templates/dreaming/', import.meta.url);
const PARALLEL_BATCHES = 3;
const MAX_ATTEMPTS = 3;
const RULE_DESTINATIONS = {
  rules: 'ZYLOS.md or the group rules.md',
  preferences: 'preferences.md',
  skill: 'Create or update a skill',
};

function promptVariables(root, timezone) {
  const memory = path.join(root, 'memory');
  const identity = path.join(memory, 'identity.md');
  const name = fs.existsSync(identity) ? /^I am (.+?)(?: \(named by|[.!?](?:\s|$)|$)/m.exec(fs.readFileSync(identity, 'utf8'))?.[1] : null;
  return {
    AGENT_NAME: name || 'the agent',
    OWNER_NAME: readOwnerName(path.join(memory, 'references.md')),
    TZ: timezone,
  };
}

function prompt(stage, variables) {
  return fs.readFileSync(fileURLToPath(new URL(`${stage}-system-final.md`, TEMPLATE)), 'utf8')
    .replace(/\{\{(AGENT_NAME|OWNER_NAME|TZ)\}\}/g, (_, key) => variables[key]);
}

async function retry(call, input, parse) {
  let lastError, correction = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let invocation;
    try { invocation = await call(input + correction); }
    catch (error) { lastError = error; continue; }
    if (!parse) return invocation;
    try { return parse(invocation.answer); }
    catch (error) {
      invocation.fail(error);
      lastError = error;
      correction = `\n\nValidation error: ${error.message}.\n`;
    }
  }
  throw lastError;
}

function ruleMessage(candidates) {
  const lines = candidates.map(({ text, source, owner_stated, destination }, index) =>
    `${index + 1}. ${text}\nSource: ${source}\nOwner stated: ${owner_stated ? 'yes' : 'no'}\nSuggested destination: ${RULE_DESTINATIONS[destination]}`);
  return `Memory dreaming found rules for your review. Reply with the items you approve or want to revise.\n\n${lines.join('\n\n')}`;
}

function completedExtractions(batches, results) {
  const blocked = new Set();
  const incomplete = new Map();
  const completed = [];
  for (const [index, batch] of batches.entries()) {
    const result = results[index];
    for (const { group, end } of batch.groups) {
      if (blocked.has(group)) continue;
      if (!result) {
        blocked.add(group);
        incomplete.delete(group);
        continue;
      }
      const entries = incomplete.get(group) ?? [];
      entries.push(result.groups.find(row => row.group === group));
      if (end === null) {
        // Include earlier fragments only once the complete message can be covered.
        incomplete.set(group, entries);
      } else {
        completed.push({ group, end, entries });
        incomplete.delete(group);
      }
    }
  }
  return completed;
}

function advanceDreamCheckpoints(db, completed) {
  for (const { group, end, entries } of completed) {
    if (end <= db.getCoverageEnd(group)) continue;
    if (entries) db.createCheckpoint(group, end, entries.at(-1).summary);
    else db.createCheckpoint(group, end, null, { noContent: true });
  }
}

function publishDiary(root, date, text) {
  const relative = `sessions/${date}.md`;
  const diary = resolveAllowedMemoryPath({ root, path: relative, allowed: candidate => candidate === relative }).target;
  let previous;
  try { previous = fs.readFileSync(diary); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const separator = previous?.at(-1) === 10 ? '\n' : '\n\n';
  const content = previous?.length ? Buffer.concat([previous, Buffer.from(separator + text)]) : Buffer.from(text);
  if (content.length > PAGE_SOFT_LIMIT) console.log(`Dream diary for ${date} exceeds the soft limit: ${content.length} bytes`);
  publishReferenceFile(diary, content);
}

/** One independent run. Opening a model call and publishing effects are separate operations. */
export async function runDreamRound({ root, date, timezone, weekday, tidyWeekday, db, model, directory, token, mutate, notify, signal, stats }) {
  const variables = promptVariables(root, timezone);
  const { batches, noticeOnly } = makeDreamBatches(db.getDreamConversations(), date, timezone);
  stats.stage1.batches = batches.length;
  const results = new Array(batches.length);
  const failedBatches = [];
  const warnings = [];
  const invoke = (stage, options) => {
    const tools = stage !== 'stage1' && stage !== 'condense';
    const permissions = tools
      ? `\nIn this run use read_memory, grep_memory and glob_memory for the read tools and edit_memory for writes. Paths are relative to shared memory. Supply this exact token on every edit_memory call: ${token}.\n`
      : '';
    return model({ stage, tools, token, signal, schema: DREAM_RESULT_SCHEMAS[stage], ...options,
      instructions: (options.instructions ?? prompt(stage, variables)) + permissions });
  };
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      signal?.throwIfAborted();
      const index = next++;
      const batch = batches[index];
      try {
        const result = await retry(input => invoke('stage1', { input }), batch.input,
          answer => parseDreamResult('stage1', answer, batch.groups.map(({ group }) => group)));
        durableJson(path.join(directory, `batch-${index + 1}.json`), result);
        results[index] = result;
        stats.stage1.extracted += result.groups.reduce((count, group) => count + group.items.length, 0);
      } catch (error) {
        stats.stage1.failedBatches++;
        failedBatches.push({ batch: index + 1, groups: batch.groups.map(({ group }) => group), error: error.message });
      }
    }
  }
  if (noticeOnly.length) await mutate(() => advanceDreamCheckpoints(db, noticeOnly));
  await Promise.all(Array.from({ length: Math.min(PARALLEL_BATCHES, batches.length) }, worker));
  signal?.throwIfAborted();
  const completed = completedExtractions(batches, results);
  const extracted = completed.flatMap(({ entries }) => entries);
  if (batches.length && !extracted.length) return { failedBatches, failed: true, warnings };
  let result;
  const failedRepairs = new Set();
  const repair = () => repairPageHeaders(root, options => invoke('repair', options), mutate, failedRepairs);
  if (extracted.length) {
    const input = stageTwoInput(root, date, extracted);
    let invocation;
    try { invocation = await retry(input => invoke('stage2', { input }), input); }
    catch (error) { return { failedBatches, failed: true, stageTwoError: error.message, warnings }; }
    signal?.throwIfAborted();
    const { answer, fail } = invocation;
    try {
      result = parseDreamResult('stage2', answer);
      for (const key of Object.keys(stats.stage2)) stats.stage2[key] = result[key].length;
    } catch (error) {
      fail(error);
      fs.writeFileSync(path.join(directory, 'invalid-stage2-response.txt'), answer, { mode: 0o600 });
      warnings.push(`Memory dreaming returned an invalid second-stage result. Diary and rule candidates were skipped. ${error.message}.`);
    }
    warnings.push(...(await repair()).map(file => `Unparsable reference header: ${file}`));
    if (result?.diary) await mutate(() => publishDiary(root, date, result.diary));
    if (result?.rule_candidates.length) {
      signal?.throwIfAborted();
      await notify(ruleMessage(result.rule_candidates));
    }
    await mutate(() => advanceDreamCheckpoints(db, completed));
  }
  signal?.throwIfAborted();
  if (weekday === tidyWeekday) {
    try {
      warnings.push(...await tidyReference({ root, date, repair, mutate, stats: stats.tidy,
        call: input => retry(input => invoke('tidy', { input }), input, answer => parseDreamResult('tidy', answer)),
        condense: (input, check) => retry(input => invoke('condense', { input }), input,
          answer => check(parseDreamResult('condense', answer).body)),
      }));
    } catch (error) {
      warnings.push(`Weekly memory tidy could not finish: ${error.message}`);
    }
  }
  return { failedBatches, failed: failedBatches.length > 0, warnings };
}
