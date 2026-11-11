#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { withNamingStore } from '../src/lib/chat/auto-name.js';

/** Agent-only local command; an existing human or Agent name is never replaced. */
export function runConversationName(argv, { env = process.env, stdout = process.stdout } = {}) {
  try {
    const args = argv.filter(arg => arg !== '--json');
    if (args.length !== 2 || argv.length > 3) throw Object.assign(new Error('Expected session group and name'), { code: 'INVALID_ARGS' });
    const data = withNamingStore(env, store => new ChatConversations({ store }).renameIfEmpty(args[0], args[1]));
    stdout.write(JSON.stringify({ ok: true, ...data }) + '\n');
    return data.code === 'NAME_ALREADY_SET' ? 2 : 0;
  } catch (error) {
    stdout.write(JSON.stringify({ ok: false, code: error.code || 'COMMAND_FAILED', message: error.message }) + '\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runConversationName(process.argv.slice(2));
}
