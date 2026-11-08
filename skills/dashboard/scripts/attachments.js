#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatAttachments } from '../src/lib/chat/attachments.js';
import { inspectDatabase, TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { resolveUploadRoot } from './attachment-utils.js';
import { isMainModule } from '../../comm-bridge/scripts/is-main-module.js';

const invalid = () => Object.assign(new Error('Use register --conversation <id> --kind <image|file> --path <absolute-path>, or resolve --conversation <id> --id <attachment-id>.'), { code: 'invalid_attachment_arguments' });

function argumentsFor(argv) {
  const [command, ...args] = argv;
  const keys = command === 'register' ? ['conversation', 'kind', 'path'] : command === 'resolve' ? ['conversation', 'id'] : [];
  if (!keys.length || args.length !== keys.length * 2) throw invalid();
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !keys.includes(key) || Object.hasOwn(options, key) || !args[i + 1]) throw invalid();
    options[key] = args[i + 1];
  }
  if (keys.some(key => !Object.hasOwn(options, key))) throw invalid();
  if (command === 'register' && (!['image', 'file'].includes(options.kind) || !path.isAbsolute(options.path))) throw invalid();
  return { command, options };
}

export async function runAttachments({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout } = {}) {
  let store, reader, attachments;
  try {
    const { command, options } = argumentsFor(argv);
    const zylosDir = resolveUploadRoot(env);
    const file = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    if (!fs.existsSync(file)) throw Object.assign(new Error('Dashboard attachment storage is unavailable.'), { code: 'attachment_storage_unavailable' });
    const check = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (inspectDatabase(check).currentVersion !== TARGET_SCHEMA_VERSION) throw new Error('Dashboard requires an upgrade.');
    } finally { check.close(); }
    store = new Store(file);
    reader = new C4Reader(zylosDir);
    const conversations = new ChatConversations({ store });
    const conversation = conversations.get(options.conversation);
    attachments = new ChatAttachments({ store, c4Reader: reader, zylosDir });
    if (command === 'register') {
      const registered = await attachments.register(conversation, { kind: options.kind, path: options.path });
      stdout.write(JSON.stringify({ ok: true, attachmentId: registered.attachmentId ?? registered.id,
        name: registered.name, kind: registered.kind, expiresAt: registered.expiresAt }) + '\n');
    } else {
      stdout.write(JSON.stringify({ ok: true, path: attachments.resolve(conversation.localId, options.id) }) + '\n');
    }
    return 0;
  } catch (error) {
    const code = /^[a-zA-Z0-9_]+$/.test(error.code || '') ? error.code : 'attachment_command_failed';
    stdout.write(JSON.stringify({ ok: false, error: { code, message: code === 'invalid_attachment_arguments'
      ? invalid().message : 'Attachment operation failed; check the conversation, source file and Dashboard storage.' } }) + '\n');
    return 1;
  } finally {
    await attachments?.close();
    reader?.close();
    store?.close();
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await runAttachments();
