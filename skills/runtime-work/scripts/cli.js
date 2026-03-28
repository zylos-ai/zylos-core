#!/usr/bin/env node

import { getWork, getWorkEvents, listWork } from './api.js';

const HELP = `
Runtime Work CLI

Usage: runtime-work cli.js <command> [options]

Commands:
  list [--state <state>] [--limit <n>] [--json]
  show <work-id> [--json]
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = [];
  const options = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }

    const key = token.slice(2);
    if (key === 'json') {
      options.json = true;
      continue;
    }

    const value = rest[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    i += 1;
  }

  return { command, args, options };
}

function fmtTs(ts) {
  if (!ts) {
    return '-';
  }
  return new Date(ts * 1000).toISOString();
}

function printList(rows) {
  if (!rows.length) {
    console.log('No work items found.');
    return;
  }

  console.log('work_id                 state            source        kind              pri  created_at');
  console.log('---------------------------------------------------------------------------------------------');
  for (const row of rows) {
    const workId = row.work_id.slice(0, 22).padEnd(22);
    const state = row.state.padEnd(16);
    const source = row.source_system.padEnd(12);
    const kind = row.kind.padEnd(17);
    const pri = String(row.priority).padEnd(3);
    console.log(`${workId} ${state} ${source} ${kind} ${pri}  ${fmtTs(row.created_at)}`);
  }
}

function findWorkByPrefix(rawId) {
  const rows = listWork({ limit: 200 });
  const exact = rows.find((row) => row.work_id === rawId);
  if (exact) {
    return exact.work_id;
  }

  const matched = rows.filter((row) => row.work_id.startsWith(rawId));
  if (matched.length === 1) {
    return matched[0].work_id;
  }
  if (matched.length > 1) {
    throw new Error(`Ambiguous work id prefix "${rawId}"`);
  }

  return rawId;
}

function cmdList(options) {
  const limit = options.limit ? parseInt(options.limit, 10) : 50;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }

  const rows = listWork({
    state: options.state || null,
    limit
  });

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  printList(rows);
}

function cmdShow(args, options) {
  const rawId = args[0];
  if (!rawId) {
    throw new Error('show requires <work-id>');
  }

  const workId = findWorkByPrefix(rawId);
  const work = getWork(workId);
  if (!work) {
    throw new Error(`Work not found: ${rawId}`);
  }

  const events = getWorkEvents(workId, { limit: 200 });
  const payload = { work, events };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

function main() {
  try {
    const { command, args, options } = parseArgs(process.argv.slice(2));

    if (!command || command === 'help' || command === '--help' || command === '-h') {
      console.log(HELP.trim());
      return;
    }

    if (command === 'list') {
      cmdList(options);
      return;
    }

    if (command === 'show') {
      cmdShow(args, options);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.log(HELP.trim());
    process.exitCode = 1;
  }
}

main();
