import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateFleetRegistry } from '../src/lib/fleet-registry.js';
import { loadConfig, resolveAgentIdentity } from '../src/lib/config.js';

test('fleet registry accepts absent or empty agent list', () => {
  assert.deepEqual(validateFleetRegistry(undefined), { agents: [], errors: [] });
  assert.deepEqual(validateFleetRegistry([]), { agents: [], errors: [] });
});

test('fleet registry normalizes valid entries', () => {
  const result = validateFleetRegistry([
    { name: ' Jinglever ', base_url: 'https://example.test/dashboard/', read_api_key: ' key ' }
  ]);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.agents, [
    { name: 'Jinglever', base_url: 'https://example.test/dashboard', read_api_key: 'key' }
  ]);
});

test('fleet registry rejects missing fields', () => {
  const result = validateFleetRegistry([
    { name: '', base_url: '', read_api_key: '' }
  ]);

  assert.deepEqual(result.agents, []);
  assert.ok(result.errors.some(e => e.includes('.name')));
  assert.ok(result.errors.some(e => e.includes('.base_url')));
  assert.ok(result.errors.some(e => e.includes('.read_api_key')));
});

test('fleet registry rejects duplicate names case-insensitively', () => {
  const result = validateFleetRegistry([
    { name: 'Jinglever', base_url: 'https://one.example.test', read_api_key: 'key-1' },
    { name: 'jinglever', base_url: 'https://two.example.test', read_api_key: 'key-2' }
  ]);

  assert.deepEqual(result.agents, []);
  assert.ok(result.errors.some(e => e.includes('unique')));
});

test('fleet registry rejects malformed or non-http URLs', () => {
  const result = validateFleetRegistry([
    { name: 'Bad', base_url: 'not a url', read_api_key: 'key-1' },
    { name: 'File', base_url: 'file:///tmp/dashboard', read_api_key: 'key-2' }
  ]);

  assert.deepEqual(result.agents, []);
  assert.equal(result.errors.filter(e => e.includes('base_url')).length, 2);
});

test('loadConfig stores fleet registry in server config and preserves validation errors', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-config-'));
  const previous = process.env.ZYLOS_DIR;
  try {
    const dashboardDir = path.join(zylosDir, 'components', 'dashboard');
    fs.mkdirSync(dashboardDir, { recursive: true });
    fs.writeFileSync(path.join(dashboardDir, 'config.json'), JSON.stringify({
      fleet: {
        agents: [
          { name: 'A', base_url: 'https://a.example.test/dashboard', read_api_key: 'secret-a' }
        ]
      }
    }, null, 2));

    process.env.ZYLOS_DIR = zylosDir;
    const config = loadConfig();
    assert.deepEqual(config.fleet.validation_errors, []);
    assert.deepEqual(config.fleet.agents, [
      { name: 'A', base_url: 'https://a.example.test/dashboard', read_api_key: 'secret-a' }
    ]);
  } finally {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('agent identity uses config values and stable defaults', () => {
  assert.deepEqual(resolveAgentIdentity({ agent: { name: 'Jinglever', id: 'jinglever-main' } }, '/tmp/zylos'), {
    name: 'Jinglever',
    id: 'jinglever-main'
  });

  const fallback = resolveAgentIdentity({}, '/tmp/zylos');
  assert.equal(typeof fallback.name, 'string');
  assert.ok(fallback.name.length > 0);
  assert.equal(typeof fallback.id, 'string');
  assert.ok(fallback.id.length > 0);
});
