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

async function retry(call, input, parse = answer => answer) {
  let lastError, correction = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let answer;
    try { answer = await call(input + correction); }
    catch (error) { lastError = error; continue; }
    try { return parse(answer); }
    catch (error) { lastError = error; correction = `\n\nValidation error: ${error.message}.\n`; }
  }
  throw lastError;
}

function ruleMessage(candidates) {
  const lines = candidates.map(({ text, source, owner_stated, destination }, index) =>
    `${index + 1}. ${text}\nSource: ${source}\nOwner stated: ${owner_stated ? 'yes' : 'no'}\nSuggested destination: ${RULE_DESTINATIONS[destination]}`);
  return `Memory dreaming found rules for your review. Reply with the items you approve or want to revise.\n\n${lines.join('\n\n')}`;
}

export function advanceDreamCheckpoints(db, batches, results) {
  const blocked = new Set();
  for (const [index, batch] of batches.entries()) {
    const result = results[index];
    for (const { group, end } of batch.groups) {
      if (!result) { blocked.add(group); continue; }
      if (blocked.has(group) || end === null || end <= db.getCoverageEnd(group)) continue;
      db.createCheckpoint(group, end, result.groups.find(row => row.group === group).summary);
    }
  }
}

/** One independent run. Opening a model call and publishing effects are separate operations. */
export async function runDreamRound({ root, date, timezone, weekday, tidyWeekday, db, model, directory, token, mutate, notify, signal }) {
  const variables = promptVariables(root, timezone);
  const batches = makeDreamBatches(db.getDreamConversations(), date, timezone);
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
      } catch (error) {
        failedBatches.push({ batch: index + 1, groups: batch.groups.map(({ group }) => group), error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_BATCHES, batches.length) }, worker));
  signal?.throwIfAborted();
  const extracted = results.filter(Boolean);
  if (batches.length && !extracted.length) return { failedBatches, failed: true, warnings };
  let result;
  const failedRepairs = new Set();
  const repair = () => repairPageHeaders(root, options => invoke('repair', options), mutate, failedRepairs);
  if (extracted.length) {
    const input = stageTwoInput(root, date, extracted);
    let answer;
    try { answer = await retry(input => invoke('stage2', { input }), input); }
    catch (error) { return { failedBatches, failed: true, stageTwoError: error.message, warnings }; }
    signal?.throwIfAborted();
    try { result = parseDreamResult('stage2', answer); }
    catch (error) {
      fs.writeFileSync(path.join(directory, 'invalid-stage2-response.txt'), answer, { mode: 0o600 });
      warnings.push(`Memory dreaming returned an invalid second-stage result. Diary and rule candidates were skipped. ${error.message}.`);
    }
    warnings.push(...(await repair()).map(file => `Unparsable reference header: ${file}`));
    if (result?.diary) await mutate(() => {
      const relative = `sessions/${date}.md`;
      const diary = resolveAllowedMemoryPath({ root, path: relative, allowed: candidate => candidate === relative }).target;
      const bytes = Buffer.byteLength(result.diary);
      if (bytes > PAGE_SOFT_LIMIT) console.log(`Dream diary for ${date} exceeds the soft limit: ${bytes} bytes`);
      publishReferenceFile(diary, result.diary);
    });
    if (result?.rule_candidates.length) {
      signal?.throwIfAborted();
      await notify(ruleMessage(result.rule_candidates));
    }
    await mutate(() => advanceDreamCheckpoints(db, batches, results));
  }
  signal?.throwIfAborted();
  if (weekday === tidyWeekday) {
    try {
      warnings.push(...await tidyReference({ root, date, repair, mutate,
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
