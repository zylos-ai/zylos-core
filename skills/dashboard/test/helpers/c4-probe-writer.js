import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Another process writing to C4 the way a channel's receive command does: it opens the database through the
// installed comm-bridge, writes one row, closes its connection and exits.
const [scripts, mode, content] = process.argv.slice(2);
const db = await import(pathToFileURL(path.join(scripts, 'c4-db.js')).href);
try {
  if (mode === 'init') db.getDb();
  else {
    const row = db.insertConversation('out', 'dashboard', 'probe', content, { status: 'delivered' });
    process.stdout.write(JSON.stringify({ id: Number(row?.id ?? row?.lastInsertRowid ?? row) }));
  }
} finally { db.close(); }
