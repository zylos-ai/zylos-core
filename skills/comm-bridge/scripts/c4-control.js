#!/usr/bin/env node
/**
 * C4 Communication Bridge - Control Queue Interface
 *
 * Commands:
 *   enqueue --content "<text>" [--priority 0] [--require-idle] [--bypass-state] [--ack-deadline <seconds>] [--available-in <seconds>]
 *   get --id <control_id>
 *   ack --id <control_id>
 */

import {
  insertControl,
  getControlById,
  ackControl,
  expireTimedOutControls,
  close
} from './c4-db.js';

function usage() {
  console.error('Usage: c4-control.js <enqueue|get|ack> [options]');
  console.error('  enqueue --content "<text>" [--priority 0] [--require-idle] [--bypass-state] [--ack-deadline <seconds>] [--available-in <seconds>]');
  console.error('  get --id <control_id>');
  console.error('  ack --id <control_id>');
}

function errorExit(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
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

function handleEnqueue(args) {
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

  const record = insertControl(content, {
    priority: priority ?? 0,
    requireIdle: hasFlag(args, '--require-idle'),
    bypassState: hasFlag(args, '--bypass-state'),
    ackDeadlineAt,
    availableAt
  });

  console.log(`OK: enqueued control ${record.id}`);
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

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);

  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }

  try {
    switch (command) {
      case 'enqueue':
        handleEnqueue(commandArgs);
        break;
      case 'get':
        handleGet(commandArgs);
        break;
      case 'ack':
        handleAck(commandArgs);
        break;
      default:
        usage();
        errorExit(`unknown command: ${command}`);
    }
  } finally {
    close();
  }
}

main();
