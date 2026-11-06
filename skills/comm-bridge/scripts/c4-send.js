#!/usr/bin/env node
import * as database from './c4-db.js';
import { SKILLS_DIR } from './c4-config.js';
import { parseSendArgs, sendError } from './c4-send-args.js';
import { readAbsorbedReply, recordVoid, sendExternal } from './c4-send-external.js';
import { sendInternal } from './c4-send-internal.js';

async function readStdin() {
  process.stdin.setEncoding('utf8');
  let content = '';
  for await (const chunk of process.stdin) content += chunk;
  return content;
}

async function main() {
  const args = process.argv.slice(2);
  const api = database;
  let internal = args[0] === 'internal';
  let externalChannel;
  let deprecatedArgv = false;
  const warnArgv = () => {
    if (deprecatedArgv) {
      console.error('[c4-send] Deprecated: passing message as CLI argument. Use stdin/heredoc mode instead.');
      deprecatedArgv = false;
    }
  };
  try {
    if (internal) {
      console.log(await sendInternal(args, readStdin));
      return;
    }
    let request = parseSendArgs(args, { isTTY: !!process.stdin.isTTY });
    const message = (request.stdin ? await readStdin() : request.message).trimEnd();
    if (!message) throw sendError('EMPTY_CONTENT', 'Message is required');
    deprecatedArgv = !request.stdin;
    if (request.kind === 'absorbed') {
      request = readAbsorbedReply(request.runId, request.id, api);
      if (request.channel === 'internal') {
        internal = true;
        warnArgv();
        console.log(await sendInternal(['internal', request.endpoint], async () => message));
        return;
      }
    }
    if (request.kind === 'void') {
      warnArgv();
      recordVoid(request, message, { api });
      console.log('[C4] Message recorded on void channel (not dispatched)');
      return;
    }
    externalChannel = request.channel;
    await sendExternal(request, message, { api, skillsDir: SKILLS_DIR });
    warnArgv();
    console.log(`[C4] Message sent via ${request.channel}`);
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('HOOK_')) {
      console.log(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }));
      if (error.code === 'HOOK_ABORTED') console.error(`HOOK_ABORTED ${error.message}`);
      else console.error(`[C4] ${error.code}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    warnArgv();
    if (internal) {
      console.error(`Error: ${error.code || 'INTERNAL_ERROR'}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    if (error.message.startsWith('Usage:')) console.log(error.message);
    if (error.code === 'SEND_FAILED') {
      console.log(`[C4] Failed to send message via ${externalChannel} (exit code: ${error.exitCode})`);
      console.error(`[C4] SEND_FAILED: ${error.message}`);
      process.exitCode = error.exitCode ?? 1;
      return;
    }
    console.error(`[C4] ${error.code || 'INTERNAL_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  } finally { database.close(); }
}

await main();
