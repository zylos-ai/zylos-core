#!/usr/bin/env node

// Read-only health probe: can the C4 message database still list session
// groups? It runs the existing C4 read command and reports only a count or an
// error code with a fixed reason. Message content, group names and the read
// command's own output are never printed.

import { spawnSync } from 'node:child_process';
import { constants as fsConstants, accessSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DB_PATH } from '../../comm-bridge/scripts/c4-config.js';

const C4_DB_CLI = fileURLToPath(new URL('../../comm-bridge/scripts/c4-db.js', import.meta.url));
const READ_TIMEOUT_MS = 30_000;
const READ_MAX_BUFFER = 64 * 1024 * 1024;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

const REASONS = {
  DB_MISSING: 'C4 message database file not found',
  DB_UNREADABLE: 'C4 message database file is not readable',
  DB_EMPTY: 'C4 message database file is empty',
  SPAWN_FAILED: 'Could not start the C4 read command',
  TIMEOUT: `C4 session group read did not finish within ${READ_TIMEOUT_MS / 1000} s`,
  INVALID_OUTPUT: 'C4 read command returned an unexpected response',
  C4_ERROR: 'C4 could not read the session group list',
};

export class C4GroupsCheckError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = 'C4GroupsCheckError';
    this.code = code;
  }
}

const fail = (code, reason = REASONS[code]) => { throw new C4GroupsCheckError(code, reason); };

// C4 creates and initializes a database when the file is missing or empty, so
// those cases, and an unreadable file, are reported before the read command runs.
function assertDatabaseReadable(dbPath = DB_PATH) {
  let stat;
  try { stat = statSync(dbPath); }
  catch (error) { fail(error?.code === 'ENOENT' ? 'DB_MISSING' : 'DB_UNREADABLE'); }
  if (!stat.isFile()) fail('DB_UNREADABLE');
  if (stat.size === 0) fail('DB_EMPTY');
  try { accessSync(dbPath, fsConstants.R_OK); }
  catch { fail('DB_UNREADABLE'); }
}

export function interpretGroupsResult(result) {
  if (result?.error?.code === 'ETIMEDOUT') fail('TIMEOUT');
  if (result?.error?.code === 'ENOBUFS') fail('INVALID_OUTPUT');
  if (result?.error) fail('SPAWN_FAILED');
  let envelope;
  try { envelope = JSON.parse(result?.stdout ?? ''); }
  catch { envelope = undefined; }
  if (result?.status === 0 && envelope?.ok === true && Array.isArray(envelope.data)) {
    return { groups: envelope.data.length };
  }
  if (envelope?.ok === false) {
    const code = envelope.error?.code;
    fail(typeof code === 'string' && CODE_PATTERN.test(code) ? code : 'READ_FAILED', REASONS.C4_ERROR);
  }
  // Startup failures (for example a missing driver) exit non-zero without the
  // JSON envelope; report them as a read failure without echoing stderr.
  if (result?.status !== 0) fail('READ_FAILED', REASONS.C4_ERROR);
  fail('INVALID_OUTPUT');
}

export function checkC4Groups({ run = spawnSync } = {}) {
  assertDatabaseReadable();
  const result = run(process.execPath, [C4_DB_CLI, 'groups', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: READ_TIMEOUT_MS,
    maxBuffer: READ_MAX_BUFFER,
  });
  return interpretGroupsResult(result);
}

function main() {
  try {
    const { groups } = checkC4Groups();
    process.stdout.write(`C4 session groups OK: ${groups} ${groups === 1 ? 'group' : 'groups'} listed\n`);
  } catch (error) {
    const known = error instanceof C4GroupsCheckError;
    const code = known ? error.code : 'CHECK_FAILED';
    const reason = known ? error.message : 'Unexpected error in the C4 session group check';
    process.stderr.write(`C4 session groups FAILED [${code}]: ${reason}\n`);
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
