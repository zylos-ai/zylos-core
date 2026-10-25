#!/usr/bin/env node
import * as database from './c4-db.js';
import { SKILLS_DIR } from './c4-config.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { parseSendArgs, sendError } from './c4-send-args.js';
import { readAbsorbedReply, recordVoid, sendExternal } from './c4-send-external.js';

async function readStdin() {
  process.stdin.setEncoding('utf8');
  let content = '';
  for await (const chunk of process.stdin) content += chunk;
  return content;
}

async function sendInternal(args, readBody) {
  const { sendInternal: handler } = await import('./c4-send-internal.js');
  return handler(args, readBody);
}

async function main() {
  const args = process.argv.slice(2);
  const api = { ...database, validateChannel, validateEndpoint };
  let internal = args[0] === 'internal';
  let externalChannel;
  try {
    if (internal) {
      console.log(await sendInternal(args, readStdin));
      return;
    }
    let request = parseSendArgs(args, { isTTY: !!process.stdin.isTTY });
    const message = (request.stdin ? await readStdin() : request.message).trimEnd();
    if (!message) throw sendError('EMPTY_CONTENT', 'Message is required');
    if (!request.stdin) console.error('[c4-send] Deprecated: passing message as CLI argument. Use stdin/heredoc mode instead.');
    if (request.kind === 'absorbed') {
      request = readAbsorbedReply(request.runId, request.id, api);
      if (request.channel === 'internal') {
        internal = true;
        console.log(await sendInternal(['internal', request.endpoint], async () => message));
        return;
      }
    }
    if (request.kind === 'void') {
      recordVoid(request, message, { api });
      console.log('[C4] Message recorded on void channel (not dispatched)');
      return;
    }
    externalChannel = request.channel;
    await sendExternal(request, message, { api, skillsDir: SKILLS_DIR,
      appendFallback: async (record, groupName) => {
        const { appendOutGroupFallback } = await import('./c4-outbound-events.js');
        await appendOutGroupFallback(record, groupName);
      } });
    console.log(`[C4] Message sent via ${request.channel}`);
  } catch (error) {
    if (internal) {
      console.error(`Error: ${error.code || 'INTERNAL_ERROR'}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    if (error.message.startsWith('Usage:')) console.log(error.message);
    if (error.code === 'SEND_FAILED') {
      console.log(`[C4] Failed to send message via ${externalChannel} (exit code: ${error.exitCode})`);
      process.exitCode = error.exitCode ?? 1;
      return;
    }
    console.error(`[C4] ${error.code || 'INTERNAL_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  } finally { database.close(); }
}

await main();
