/**
 * Team Adapter (multi-session runtime, phase 1 — v2.1 design)
 *
 * The lead (main interactive session) spawns teammates itself via native
 * agent-teams tools. This adapter is bookkeeping + conventions only:
 *   - delegate-prep: delivery dir + registry entry + ready-to-use task prompt
 *   - guardrails: tool down-scoping deny block for teammate cwd settings
 *   - harvest: pre-molt check for in-flight workers
 *   - accept / fail (--reassign): acceptance flow
 *
 * It never spawns processes and makes no network calls.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ZYLOS_DIR,
  DELIVERIES_DIR,
  MAX_ACTIVE_WORKERS,
  addWorker,
  getWorker,
  updateWorker,
  activeWorkers,
  inFlightWorkers,
  REGISTRY_PATH,
} from './registry.js';

/**
 * Permission deny rules teammates must inherit.
 *
 * IMPORTANT: absolute paths in Claude Code permission rules MUST use the
 * `//` prefix — a single `/` silently fails to match (spike-verified
 * 2026-06-12). `//` anchors the pattern to the filesystem root.
 */
export function denyRules(zylosDir = ZYLOS_DIR) {
  const memoryGlob = `/${path.join(zylosDir, 'memory')}/**`; // zylosDir is absolute => leading `//`
  return [
    `Write(${memoryGlob})`,
    `Edit(${memoryGlob})`,
    'Bash(*c4-send.js*)',
    'Bash(*c4-control.js*)',
  ];
}

/**
 * Where the deny block must live: the project settings of the cwd the
 * teammate runs in. Teammates inherit project settings from their working
 * directory, so this is the enforcement point.
 */
export function settingsPathFor(projectDir) {
  return path.join(projectDir, '.claude', 'settings.json');
}

/** Merge the deny rules into <projectDir>/.claude/settings.json (idempotent). */
export function writeGuardrails(projectDir, zylosDir = ZYLOS_DIR) {
  const settingsPath = settingsPathFor(projectDir);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
  settings.permissions = settings.permissions || {};
  const deny = new Set(settings.permissions.deny || []);
  for (const rule of denyRules(zylosDir)) deny.add(rule);
  settings.permissions.deny = [...deny];
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, settingsPath);
  return settingsPath;
}

/**
 * Verify the deny block exists and is syntactically correct in the project
 * settings of `projectDir`. Returns { ok, problems: [] }.
 */
export function checkGuardrails(projectDir, zylosDir = ZYLOS_DIR) {
  const problems = [];
  const settingsPath = settingsPathFor(projectDir);
  if (!fs.existsSync(settingsPath)) {
    return { ok: false, problems: [`Settings file not found: ${settingsPath}`] };
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`Invalid JSON in ${settingsPath}: ${err.message}`] };
  }
  const deny = settings?.permissions?.deny;
  if (!Array.isArray(deny)) {
    return { ok: false, problems: [`No permissions.deny array in ${settingsPath}`] };
  }
  for (const rule of denyRules(zylosDir)) {
    if (!deny.includes(rule)) {
      problems.push(`Missing deny rule: ${rule}`);
    }
  }
  // Syntactic check: any deny rule embedding an absolute path must use the
  // `//` prefix; a single `/` silently fails to match (spike 2026-06-12).
  for (const rule of deny) {
    const match = /^[A-Za-z]+\((\/[^/].*)\)$/.exec(rule);
    if (match) {
      problems.push(
        `Rule "${rule}" uses a single-slash absolute path; use "//" prefix (single "/" silently fails to match)`
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

function slugify(slug) {
  const clean = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) throw new Error(`Invalid task slug: "${slug}"`);
  return clean;
}

function isoDate(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Render the ready-to-use teammate task prompt block (the task contract). */
export function renderPrompt(worker, { projectDir } = {}) {
  const lines = [
    '--- TEAMMATE TASK PROMPT (copy into the teammate spawn) ---',
    '',
    `# Task: ${worker.task}`,
    '',
    '## Contract',
    `- Goal: ${worker.task}`,
    '- Boundaries: work ONLY within the scope above. Do not write to zylos memory files,',
    '  do not send external messages (C4 send/control scripts are denied), do not modify',
    '  anything outside your task scope.',
    `- Delivery dir: ${worker.deliveryDir}`,
    '- Checkpoint requirement: continuously checkpoint progress into the delivery dir',
    '  (notes, partial results, final artifacts). Teammates are NOT resumable — if you',
    '  die, the delivery dir is the only surviving context for reassignment.',
    '- On completion: write a result summary to <delivery dir>/RESULT.md, then report',
    '  back to the lead.',
    '',
    '## Down-scoping (enforced, do not work around)',
    `- Your working directory's project settings (${settingsPathFor(projectDir || process.cwd())})`,
    '  deny Write/Edit on zylos memory and Bash on C4 send/control scripts.',
    `- Registry entry: ${worker.id} (status updates handled by the lead).`,
    '',
    '--- END TEAMMATE TASK PROMPT ---',
  ];
  return lines.join('\n');
}

/**
 * Prepare a delegation: enforce the cap, create the delivery dir, register
 * the worker, return { worker, prompt }.
 */
export function delegatePrep(taskSlug, { task, team, teammate, projectDir, registryPath = REGISTRY_PATH, deliveriesDir = DELIVERIES_DIR } = {}) {
  const active = activeWorkers(registryPath);
  if (active.length >= MAX_ACTIVE_WORKERS) {
    const err = new Error(
      `Concurrency cap reached (${active.length}/${MAX_ACTIVE_WORKERS} active workers: ` +
        `${active.map((w) => w.id).join(', ')}). Harvest or accept existing workers first.`
    );
    err.code = 'CAP_REACHED';
    throw err;
  }
  const slug = slugify(taskSlug);
  const deliveryDir = path.join(deliveriesDir, `${isoDate()}-${slug}`);
  fs.mkdirSync(deliveryDir, { recursive: true });
  const worker = addWorker(
    {
      task: task || taskSlug,
      team: team || null,
      teammate: teammate || null,
      deliveryDir,
      status: 'pending',
    },
    registryPath
  );
  return { worker, prompt: renderPrompt(worker, { projectDir }) };
}

/**
 * Harvest report: in-flight (pending/running/done-unaccepted) workers.
 * Used by the molt procedure — "harvest before molt".
 */
export function harvest(registryPath = REGISTRY_PATH) {
  const workers = inFlightWorkers(registryPath);
  return { clean: workers.length === 0, workers };
}

/** Accept a completed worker's delivery. */
export function accept(id, { resultSummary } = {}, registryPath = REGISTRY_PATH) {
  const fields = { status: 'accepted' };
  if (resultSummary) fields.resultSummary = resultSummary;
  return updateWorker(id, fields, registryPath);
}

/**
 * Mark a worker failed. With reassign=true, also create a successor entry
 * linked to the same delivery dir (teammates are not resumable; reassignment
 * at task granularity is the recovery path).
 */
export function fail(id, { reassign = false, resultSummary } = {}, registryPath = REGISTRY_PATH) {
  const worker = getWorker(id, registryPath);
  if (!worker) throw new Error(`Worker not found: ${id}`);
  const failed = updateWorker(
    id,
    { status: reassign ? 'reassigned' : 'failed', ...(resultSummary ? { resultSummary } : {}) },
    registryPath
  );
  let successor = null;
  if (reassign) {
    successor = addWorker(
      {
        task: worker.task,
        team: worker.team,
        teammate: null,
        deliveryDir: worker.deliveryDir,
        status: 'pending',
        predecessorId: worker.id,
      },
      registryPath
    );
  }
  return { failed, successor };
}
