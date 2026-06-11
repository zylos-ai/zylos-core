#!/usr/bin/env node
/**
 * Multi-Session CLI
 * Registry CRUD + team adapter commands for the delegation lifecycle.
 */

import {
  REGISTRY_PATH,
  MAX_ACTIVE_WORKERS,
  addWorker,
  getWorker,
  updateWorker,
  listWorkers,
  activeWorkers,
} from './registry.js';
import {
  delegatePrep,
  harvest,
  accept,
  fail,
  writeGuardrails,
  checkGuardrails,
  denyRules,
} from './adapter.js';

const HELP = `
Multi-Session CLI - Worker registry + team adapter (phase 1)

Usage: ~/zylos/.claude/skills/multi-session/scripts/cli.js <command> [options]

Registry commands:
  list [--status <s,s>]        List workers (optionally filtered by status)
  get <worker-id>              Show one worker as JSON
  active                       List workers counting against the cap (max ${MAX_ACTIVE_WORKERS})
  add <task> [options]         Add a raw registry entry (prefer delegate-prep)
  update <worker-id> [options] Update fields of a worker
  done <worker-id> [--summary "<text>"]    Mark worker done (awaiting acceptance)

Adapter commands:
  delegate-prep <task-slug> [--task "<desc>"] [--team <name>] [--teammate <name>] [--project-dir <dir>]
                               Create delivery dir, register worker, print teammate prompt.
                               Refuses when ${MAX_ACTIVE_WORKERS} workers are already active.
  accept <worker-id> [--summary "<text>"]   Accept a worker's delivery
  fail <worker-id> [--reassign] [--summary "<text>"]
                               Mark failed; --reassign creates a successor entry
                               linked to the same delivery dir
  harvest                      List in-flight (pending/running/unaccepted) workers.
                               Exit code 1 if any exist — run before molt.
  check-guardrails [--project-dir <dir>]    Verify the teammate deny block in
                               <dir>/.claude/settings.json (default: cwd)
  write-guardrails [--project-dir <dir>]    Install/merge the deny block

Options:
  --team "<name>"        Agent team name
  --teammate "<name>"    Teammate name
  --task "<desc>"        Full zylos task description
  --status <status>      pending|running|done|accepted|failed|reassigned
  --summary "<text>"     Result summary
  --usage "<text>"       Usage notes (token/window consumption)
  --delivery-dir <dir>   Delivery directory path

Registry: ${REGISTRY_PATH}
`;

function parseArgs(argv) {
  const result = { command: argv[0] || null, args: [], options: {} };
  const BOOLEAN_FLAGS = new Set(['reassign']);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        result.options[key] = true;
      } else {
        result.options[key] = argv[++i];
      }
    } else {
      result.args.push(arg);
    }
  }
  return result;
}

function fmtTs(ts) {
  return ts ? new Date(ts * 1000).toISOString() : '-';
}

function printWorker(w) {
  console.log(`${w.id}  [${w.status}]  ${w.task}`);
  console.log(`  team=${w.team || '-'} teammate=${w.teammate || '-'}`);
  console.log(`  delivery=${w.deliveryDir || '-'}`);
  console.log(`  created=${fmtTs(w.createdAt)} updated=${fmtTs(w.updatedAt)}`);
  if (w.predecessorId) console.log(`  predecessor=${w.predecessorId}`);
  if (w.usage) console.log(`  usage=${w.usage}`);
  if (w.resultSummary) console.log(`  result=${w.resultSummary}`);
}

function main() {
  const { command, args, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'list': {
      const statuses = options.status ? options.status.split(',') : undefined;
      const workers = listWorkers({ statuses });
      if (workers.length === 0) {
        console.log('No workers.');
        return;
      }
      workers.forEach(printWorker);
      return;
    }
    case 'get': {
      if (!args[0]) throw new Error('Usage: get <worker-id>');
      const worker = getWorker(args[0]);
      if (!worker) {
        console.error(`Worker not found: ${args[0]}`);
        process.exit(1);
      }
      console.log(JSON.stringify(worker, null, 2));
      return;
    }
    case 'active': {
      const workers = activeWorkers();
      console.log(`${workers.length}/${MAX_ACTIVE_WORKERS} active workers`);
      workers.forEach(printWorker);
      return;
    }
    case 'add': {
      if (!args[0]) throw new Error('Usage: add <task> [options]');
      const worker = addWorker({
        task: args[0],
        team: options.team,
        teammate: options.teammate,
        deliveryDir: options['delivery-dir'],
        status: options.status,
        usage: options.usage,
      });
      console.log(`Added ${worker.id}`);
      return;
    }
    case 'update': {
      if (!args[0]) throw new Error('Usage: update <worker-id> [options]');
      const fields = {};
      if (options.team) fields.team = options.team;
      if (options.teammate) fields.teammate = options.teammate;
      if (options.task) fields.task = options.task;
      if (options.status) fields.status = options.status;
      if (options.usage) fields.usage = options.usage;
      if (options.summary) fields.resultSummary = options.summary;
      if (options['delivery-dir']) fields.deliveryDir = options['delivery-dir'];
      if (Object.keys(fields).length === 0) throw new Error('No fields to update');
      const worker = updateWorker(args[0], fields);
      console.log(`Updated ${worker.id} [${worker.status}]`);
      return;
    }
    case 'done': {
      if (!args[0]) throw new Error('Usage: done <worker-id> [--summary "<text>"]');
      const fields = { status: 'done' };
      if (options.summary) fields.resultSummary = options.summary;
      const worker = updateWorker(args[0], fields);
      console.log(`Worker ${worker.id} marked done (awaiting acceptance).`);
      return;
    }
    case 'delegate-prep': {
      if (!args[0]) throw new Error('Usage: delegate-prep <task-slug> [options]');
      const { worker, prompt } = delegatePrep(args[0], {
        task: options.task,
        team: options.team,
        teammate: options.teammate,
        projectDir: options['project-dir'],
      });
      console.log(`Registered ${worker.id}`);
      console.log(`Delivery dir: ${worker.deliveryDir}`);
      console.log('');
      console.log(prompt);
      return;
    }
    case 'accept': {
      if (!args[0]) throw new Error('Usage: accept <worker-id> [--summary "<text>"]');
      const worker = accept(args[0], { resultSummary: options.summary });
      console.log(`Worker ${worker.id} accepted.`);
      return;
    }
    case 'fail': {
      if (!args[0]) throw new Error('Usage: fail <worker-id> [--reassign] [--summary "<text>"]');
      const { failed, successor } = fail(args[0], {
        reassign: !!options.reassign,
        resultSummary: options.summary,
      });
      console.log(`Worker ${failed.id} marked ${failed.status}.`);
      if (successor) {
        console.log(`Successor ${successor.id} created (same delivery dir: ${successor.deliveryDir}).`);
      }
      return;
    }
    case 'harvest': {
      const { clean, workers } = harvest();
      if (clean) {
        console.log('Harvest clean: no in-flight workers. Safe to molt.');
        return;
      }
      console.log(`${workers.length} in-flight worker(s) — harvest before molt:`);
      workers.forEach(printWorker);
      process.exit(1);
      return;
    }
    case 'check-guardrails': {
      const dir = options['project-dir'] || process.cwd();
      const { ok, problems } = checkGuardrails(dir);
      if (ok) {
        console.log(`Guardrails OK in ${dir}/.claude/settings.json`);
        return;
      }
      console.error(`Guardrails check FAILED for ${dir}:`);
      problems.forEach((p) => console.error(`  - ${p}`));
      console.error('Fix with: cli.js write-guardrails --project-dir ' + dir);
      process.exit(1);
      return;
    }
    case 'write-guardrails': {
      const dir = options['project-dir'] || process.cwd();
      const settingsPath = writeGuardrails(dir);
      console.log(`Deny block written to ${settingsPath}:`);
      denyRules().forEach((r) => console.log(`  - ${r}`));
      return;
    }
    case 'help':
    case '--help':
    case undefined:
    case null:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(err.code === 'CAP_REACHED' ? 2 : 1);
}
