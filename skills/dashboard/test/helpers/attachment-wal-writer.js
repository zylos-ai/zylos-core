import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { C4Reader } from '../../src/lib/c4-reader.js';
import { ChatAttachments } from '../../src/lib/chat/attachments.js';

// The parent kills this writer after the committed record reaches WAL. Normal
// connection teardown must not checkpoint the crash fixture before the hook.
const { root, conversation, source } = JSON.parse(fs.readFileSync(0, 'utf8'));
const file = path.join(root, 'components/dashboard/dashboard.db');
console.log(JSON.stringify({ sqliteWriter: file, zylosDir: root }));
const db = new Database(file, { fileMustExist: true });
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 0');
const attachments = new ChatAttachments({ db, c4Reader: new C4Reader(root), zylosDir: root });
const registered = await attachments.register(conversation, { kind: 'file', path: source });
console.log('ATTACHMENT_WAL_COMMITTED ' + JSON.stringify(registered));
setInterval(() => {}, 1000);
