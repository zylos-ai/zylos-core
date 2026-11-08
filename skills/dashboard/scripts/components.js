#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as installedCatalog from '../../comm-bridge/scripts/c4-content-schema.js';

/** Include only referenced definitions, with both source documents in one local namespace. */
function parameterSchema(parameters, catalog) {
  const definitions = {};
  function copy(value, document = 'block') {
    if (Array.isArray(value)) return value.map(item => copy(item, document));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key !== '$ref') return [key, copy(item, document)];
      const match = /^(?:(action)\.schema\.json)?#\/\$defs\/([^/]+)$/.exec(item);
      if (!match) throw Error(`Unsupported parameter reference: ${item}`);
      const source = match[1] || document, name = match[2], local = `${source}__${name}`;
      if (!(local in definitions)) {
        const schema = (source === 'action' ? catalog.ACTION_SCHEMA : catalog.BLOCK_SCHEMA).$defs[name];
        if (!schema) throw Error(`Missing parameter definition: ${item}`);
        definitions[local] = null;
        definitions[local] = copy(schema, source);
      }
      return [key, `#/$defs/${local}`];
    }));
  }
  const schema = copy(parameters);
  return Object.keys(definitions).length ? { ...schema, $defs: definitions } : schema;
}

/** Read the static capabilities shipped by this Core; no remote-page inference. */
export function runComponents(argv, { stdout = process.stdout, stderr = process.stderr, catalog = installedCatalog } = {}) {
  const { CONTENT_PREFIX, COMPONENT_DEFINITIONS, REGISTERED_COMPONENT_KEYS, MODEL_INSTRUCTIONS, CATALOG_SOURCE } = catalog;
  try {
    const json = argv.includes('--json');
    if (argv.filter(arg => arg === '--json').length > 1) throw Error('Use --json once');
    const [command, key, ...extra] = argv.filter(arg => arg !== '--json');
    if (extra.length || !['list', 'describe', 'example'].includes(command) ||
        (command === 'list' ? key !== undefined : key === undefined)) {
      throw Error('Usage: components.js list | describe <type@version> | example <type@version> [--json]');
    }
    const definition = key && COMPONENT_DEFINITIONS.find(item => item.key === key);
    if (key && !definition) throw Error(`Component is not implemented in this Core: ${key}`);
    const data = command === 'list' ? { source: CATALOG_SOURCE, keys: REGISTERED_COMPONENT_KEYS,
      components: COMPONENT_DEFINITIONS.map(({ key, type, schemaVersion, description, useWhen }) => ({ key, type, schemaVersion, description, useWhen })) }
      : command === 'describe' ? { source: CATALOG_SOURCE, ...definition, parameters: parameterSchema(definition.parameters, catalog),
        instructions: MODEL_INSTRUCTIONS + '\n\nThis description includes every referenced parameter definition in parameters.$defs; all parameter references resolve within that object.' }
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
