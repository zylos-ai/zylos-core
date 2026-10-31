#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/lib/store.js';
import { generateApiKey, hashApiKey } from '../src/lib/auth.js';

const DATA_DIR = process.env.ZYLOS_DATA_DIR
  || path.join(process.env.HOME, 'zylos/components/dashboard');
const DB_PATH = path.join(DATA_DIR, 'dashboard.db');

function openStore() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    process.exit(1);
  }
  return new Store(DB_PATH);
}

const USAGE = `Usage: api-key.js <command> [args]

Commands:
  generate <name> [read|admin]  Create a new API key
  rotate <name>                 Rotate an active key (new secret, sessions invalidated)
  revoke <name>                 Revoke an active key
  delete <name>                 Permanently remove revoked key(s) by name
  purge-revoked                 Remove all revoked keys
  list                          List all API keys`;

const [,, command, ...args] = process.argv;

if (command === 'generate') {
  const name = args[0];
  const scope = args[1] || 'read';
  if (!name) {
    console.error('Usage: api-key.js generate <name> [read|admin]');
    process.exit(1);
  }
  if (scope !== 'read' && scope !== 'admin') {
    console.error('Scope must be "read" or "admin"');
    process.exit(1);
  }
  const store = openStore();
  const key = generateApiKey();
  try {
    store.insertApiKey({ name, keyHash: hashApiKey(key), scope });
  } catch (err) {
    if (/UNIQUE constraint failed/.test(String(err?.message || ''))) {
      console.error(`An active API key named "${name}" already exists. Revoke it first, or use rotate.`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`API key created: ${name} (scope: ${scope})`);
  console.log(`Key: ${key}`);
  console.log('Store this key securely — it cannot be retrieved later.');

} else if (command === 'rotate') {
  const name = args[0];
  if (!name) {
    console.error('Usage: api-key.js rotate <name>');
    process.exit(1);
  }
  const store = openStore();
  const key = generateApiKey();
  const rotated = store.rotateApiKey(name, hashApiKey(key));
  if (!rotated) {
    console.error(`No active API key found: "${name}"`);
    process.exit(1);
  }
  console.log(`API key rotated: ${name} (scope: ${rotated.scope})`);
  console.log(`New key: ${key}`);
  console.log('Previous key and its sessions have been invalidated.');
  console.log('Store this key securely — it cannot be retrieved later.');

} else if (command === 'revoke') {
  const name = args[0];
  if (!name) {
    console.error('Usage: api-key.js revoke <name>');
    process.exit(1);
  }
  const store = openStore();
  const result = store.revokeApiKey(name);
  if (result.changes === 0) {
    console.error(`No active API key found: "${name}"`);
    process.exit(1);
  }
  console.log(`API key revoked: ${name}`);

} else if (command === 'delete') {
  const name = args[0];
  if (!name) {
    console.error('Usage: api-key.js delete <name>');
    process.exit(1);
  }
  const store = openStore();
  const result = store.hardDeleteApiKey(name);
  if (result.deleted === 0) {
    if (result.active) {
      console.error(`"${name}" is still active. Revoke it first.`);
    } else {
      console.error(`No revoked API key found: "${name}"`);
    }
    process.exit(1);
  }
  console.log(`Deleted ${result.deleted} revoked key(s) named "${name}".`);

} else if (command === 'purge-revoked') {
  const store = openStore();
  const purged = store.purgeRevokedApiKeys();
  if (purged === 0) {
    console.log('No revoked keys to purge.');
  } else {
    console.log(`Purged ${purged} revoked key(s) and their sessions.`);
  }

} else if (command === 'list') {
  const store = openStore();
  const keys = store.listApiKeys();
  if (keys.length === 0) {
    console.log('No API keys.');
  } else {
    for (const k of keys) {
      const status = k.revoked_at ? `revoked ${k.revoked_at}` : 'active';
      const lastUsed = k.last_used_at || 'never';
      console.log(`  ${k.name}  scope=${k.scope}  status=${status}  last_used=${lastUsed}  created=${k.created_at}`);
    }
  }

} else {
  console.log(USAGE);
}
