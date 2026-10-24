#!/usr/bin/env node
/**
 * C4 Communication Bridge - Control Queue Interface
 *
 * Commands:
 *   enqueue --content "<text>" [--priority 3] [--block-queue-until-idle] [--bypass-state] [--ack-deadline <seconds>] [--available-in <seconds>] [--no-ack-suffix]
 *   get --id <control_id>
 *   ack --id <control_id>
 */

import { dataError } from './c4-session-group.js';

let insertControl, buildTargetBinding, getControlById, ackControl,
  expireTimedOutControls, expireControlById;
let close = () => {};


function usage() {
  console.error('Usage: c4-control.js <enqueue|get|ack|expire> [options]');
  console.error('  enqueue --content "<text>" [--priority 3] [--block-queue-until-idle] [--bypass-state] [--ack-deadline <seconds>] [--available-in <seconds>] [--no-ack-suffix]');
  console.error('           [--group G] [--target-run ID [--expected-runtime RT] [--expected-session ID]] [--json]');
  console.error('           Legacy alias: --require-idle');
  console.error('  get --id <control_id>');
  console.error('  ack --id <control_id>');
  console.error('  expire --id <control_id>');
}

function errorExit(message) {
  throw dataError('INVALID_ARGS', message);
}

function parseNumberArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const raw = args[idx + 1];
  if (!raw) errorExit(`missing value for ${flag}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    errorExit(`${flag} must be a number`);
  }
  return value;
}

function parseStringArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value) errorExit(`missing value for ${flag}`);
  return value;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function parseId(args) {
  const idRaw = parseNumberArg(args, '--id');
  if (!Number.isInteger(idRaw) || idRaw <= 0) {
    errorExit('--id must be a positive integer');
  }
  return idRaw;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function handleEnqueue(args) {
  const values = new Set(['--content', '--priority', '--ack-deadline', '--available-in', '--group', '--target-run', '--expected-runtime', '--expected-session']);
  const flags = new Set(['--block-queue-until-idle', '--require-idle', '--bypass-state', '--no-ack-suffix', '--json']);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag) || (!values.has(flag) && !flags.has(flag))) errorExit(`invalid or duplicate option: ${flag}`);
    seen.add(flag);
    if (values.has(flag) && (!args[++i] || args[i].startsWith('--'))) errorExit(`missing value for ${flag}`);
  }
  const content = parseStringArg(args, '--content');
  if (!content) {
    errorExit('--content is required');
  }

  const priority = parseNumberArg(args, '--priority');
  if (priority !== null && (!Number.isInteger(priority) || priority < 0)) {
    errorExit('--priority must be an integer >= 0');
  }

  const ackDeadlineSeconds = parseNumberArg(args, '--ack-deadline');
  if (ackDeadlineSeconds !== null && (!Number.isInteger(ackDeadlineSeconds) || ackDeadlineSeconds <= 0)) {
    errorExit('--ack-deadline must be a positive integer (seconds)');
  }

  const availableInSeconds = parseNumberArg(args, '--available-in');
  if (availableInSeconds !== null && (!Number.isInteger(availableInSeconds) || availableInSeconds < 0)) {
    errorExit('--available-in must be an integer >= 0 (seconds)');
  }

  const now = nowSeconds();
  const ackDeadlineAt = ackDeadlineSeconds !== null ? now + ackDeadlineSeconds : null;
  const availableAt = availableInSeconds !== null ? now + availableInSeconds : null;
  const requireIdle = hasFlag(args, '--block-queue-until-idle') || hasFlag(args, '--require-idle');

  const sessionGroup = parseStringArg(args, '--group');
  const expectedRunId = parseStringArg(args, '--target-run');
  const expectedRuntime = parseStringArg(args, '--expected-runtime');
  const expectedSessionId = parseStringArg(args, '--expected-session');
  if (!expectedRunId && (expectedRuntime !== null || expectedSessionId !== null)) errorExit('--expected-runtime/--expected-session require --target-run');
  const targetBinding = expectedRunId === null ? null : await buildTargetBinding({
    sessionGroup, expectedRunId,
    ...(expectedRuntime === null ? {} : { expectedRuntime }),
    ...(expectedSessionId === null ? {} : { expectedSessionId }),
  });
  const record = insertControl(content, {
    sessionGroup, targetBinding,
    priority: priority ?? 3,
    requireIdle,
    bypassState: hasFlag(args, '--bypass-state'),
    appendAckSuffix: !hasFlag(args, '--no-ack-suffix'),
    ackDeadlineAt,
    availableAt
  });

  if (hasFlag(args, '--json')) {
    const data = { id: record.id, supersededCount: record.superseded_count };
    if (record.target_binding !== null) data.targetBinding = JSON.parse(record.target_binding);
    console.log(JSON.stringify({ ok: true, data }));
    return;
  }
  console.log(`OK: enqueued control ${record.id}`);
  if (record.superseded_count > 0) {
    console.log(`OK: superseded ${record.superseded_count} equivalent pending control(s)`);
  }
}

function handleGet(args) {
  const id = parseId(args);
  expireTimedOutControls();
  const row = getControlById(id);
  if (!row) {
    errorExit('not found');
  }
  console.log(`status=${row.status}`);
}

function handleAck(args) {
  const id = parseId(args);
  const result = ackControl(id);
  if (!result?.found) {
    errorExit(`control ${id} not found`);
  }
  if (result.alreadyFinal) {
    console.log(`OK: control ${id} already in final state (${result.status})`);
    return;
  }
  console.log(`OK: control ${id} marked as done`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);

  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }

  try {
    ({ insertControl, buildTargetBinding, getControlById, ackControl,
      expireTimedOutControls, expireControlById, close } = await import('./c4-db.js'));
    switch (command) {
      case 'enqueue':
        await handleEnqueue(commandArgs);
        break;
      case 'get':
        handleGet(commandArgs);
        break;
      case 'expire': {
        if (commandArgs.length !== 2 || commandArgs[0] !== '--id' || !/^[1-9][0-9]*$/.test(commandArgs[1]) || !Number.isSafeInteger(Number(commandArgs[1]))) {
          throw new Error('INVALID_ARGS: expire requires --id <positive integer>');
        }
        const result = expireControlById(Number(commandArgs[1]));
        console.log(JSON.stringify(result));
        break;
      }
      case 'ack':
        handleAck(commandArgs);
        break;
      default:
        usage();
        errorExit(`unknown command: ${command}`);
    }
  } catch (error) {
    if (hasFlag(commandArgs, '--json')) {
      const detail = {
        code: error.code ?? 'INVALID_ARGS', message: error.message,
        persisted: Object.hasOwn(error, 'persisted') ? error.persisted : [],
        ...(Object.hasOwn(error, 'runId') ? { runId: error.runId } : {}),
      };
      console.log(JSON.stringify({ ok: false, error: detail }));
    } else {
      if (Object.hasOwn(error, 'runId')) console.error(`runId=${JSON.stringify(error.runId)}`);
      console.error(`Error [${error.code ?? 'INVALID_ARGS'}]: ${error.message}`);
    }
    process.exitCode = 1;
  } finally {
    close();
  }
}

await main();
