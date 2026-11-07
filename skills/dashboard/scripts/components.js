#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, REGISTERED_COMPONENT_KEYS, MODEL_INSTRUCTIONS,
  CATALOG_SOURCE } from '../../comm-bridge/scripts/c4-content-schema.js';

/** Read the static capabilities shipped by this Core; no remote-page inference. */
export function runComponents(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const json = argv.includes('--json');
    if (argv.filter(arg => arg === '--json').length > 1) throw Error('Use --json once');
    const [command, key, ...extra] = argv.filter(arg => arg !== '--json');
    if (extra.length || !['list', 'describe', 'example'].includes(command) ||
        (command === 'list' ? key !== undefined : key === undefined)) {
      throw Error('Usage: components.js list | describe <type@version> | example <type@version> [--json]');
    }
    const definition = key && COMPONENT_DEFINITIONS.find(item => item.key === key && REGISTERED_COMPONENT_KEYS.includes(item.key));
    if (key && !definition) throw Error(`Component is not implemented in this Core: ${key}`);
    const data = command === 'list' ? { source: CATALOG_SOURCE, keys: REGISTERED_COMPONENT_KEYS,
      components: COMPONENT_DEFINITIONS.filter(item => REGISTERED_COMPONENT_KEYS.includes(item.key))
        .map(({ key, type, schemaVersion, description }) => ({ key, type, schemaVersion, description })) }
      : command === 'describe' ? { source: CATALOG_SOURCE, ...definition, instructions: MODEL_INSTRUCTIONS }
        : definition.example;
    stdout.write(json ? JSON.stringify({ ok: true, data }) + '\n'
      : command === 'example' ? CONTENT_PREFIX + JSON.stringify(data) + '\n' : JSON.stringify(data, null, 2) + '\n');
    return 0;
  } catch (error) {
    stderr.write(error.message + '\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runComponents(process.argv.slice(2));
}
