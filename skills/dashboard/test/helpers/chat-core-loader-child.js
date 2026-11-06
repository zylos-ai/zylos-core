import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, installed, packageRoot] = process.argv.slice(2);
const { ChatSender } = await import(pathToFileURL(path.join(packageRoot, 'skills/dashboard/src/lib/chat/send.js')).href);
const sender = new ChatSender({ zylosDir: installed });
if (mode === 'mismatched') {
  await assert.rejects(sender.loadCore(), { code: 'chat_core_path_mismatch', statusCode: 503 });
  assert.equal(fs.existsSync(path.join(installed, 'comm-bridge/c4.db')), false);
  assert.equal(fs.existsSync(path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db')), false);
  process.stdout.write(JSON.stringify({ mode, error: 'chat_core_path_mismatch', statusCode: 503 }));
} else {
  assert.equal(mode, 'matching');
  const scripts = path.join(installed, '.claude/skills/comm-bridge/scripts');
  const core = await sender.loadCore();
  const db = await import(pathToFileURL(path.join(scripts, 'c4-db.js')).href);
  try {
    const receiver = await import(pathToFileURL(path.join(scripts, 'c4-receive.js')).href);
    assert.equal(core.receive, receiver.receive, 'default loader returns the actual installed in-process receive');
    const binding = core.ensureChannelNamespace('dashboard');
    assert.equal(binding.componentName, 'dashboard');
    assert.equal(core.getChannelNamespace('dashboard').namespace, binding.namespace);
    const connection = db.getDb();
    const conversations = connection.prepare('SELECT count(*) AS n FROM conversations').get().n;
    const heads = connection.prepare('SELECT count(*) AS n FROM group_heads').get().n;
    assert.equal(conversations, 0);
    assert.equal(heads, 0);
    process.stdout.write(JSON.stringify({ mode, namespace: binding.namespace, conversations, heads, receiveImported: true }));
  } finally { db.close(); }
}
