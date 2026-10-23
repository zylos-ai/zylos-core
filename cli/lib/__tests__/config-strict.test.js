import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root;
let configFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-config-strict-'));
  configFile = path.join(root, 'config.json');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const { readConfigStrict, evaluateConfigUpdate } = await import('../config-store.js');

describe('strict config reads', () => {
  it('distinguishes a missing file from malformed and non-object JSON', () => {
    assert.deepEqual(readConfigStrict(configFile), { state: 'missing' });
    for (const source of ['{', 'null', '[]', 'false']) {
      fs.writeFileSync(configFile, source);
      const result = readConfigStrict(configFile);
      assert.equal(result.state, 'error');
      assert.ok(result.error instanceof Error);
    }
  });

  it('returns an object without narrowing unrelated values', () => {
    const config = { runtime: 'codex', nested: { value: 1 }, zero: 0 };
    fs.writeFileSync(configFile, JSON.stringify(config));
    assert.deepEqual(readConfigStrict(configFile), { state: 'ok', config });
  });

  it('keeps non-ENOENT read failures visible', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const result = readConfigStrict(configFile, { readFileSync: () => { throw denied; } });
    assert.equal(result.state, 'error');
    assert.equal(result.error, denied);
  });
});
describe('update intent evaluation', () => {
  it('uses own-key semantics for falsey values and preserves unknown keys', () => {
    const result = evaluateConfigUpdate(
      { zero: 0, disabled: false, nullable: null, unknown: { keep: true } },
      { set: { runtime: 'codex' }, setIfAbsent: { zero: 1, disabled: true, nullable: 'x', threshold: 30 } },
    );
    assert.deepEqual(result.written, ['runtime', 'threshold']);
    assert.deepEqual(result.skipped, ['zero', 'disabled', 'nullable']);
    assert.deepEqual(result.previous, { zero: 0, disabled: false, nullable: null });
    assert.deepEqual(result.config.unknown, { keep: true });
  });

  it('does not report or write unchanged set values', () => {
    assert.deepEqual(evaluateConfigUpdate({ runtime: 'codex' }, { set: { runtime: 'codex' } }), {
      changed: false,
      written: [],
      skipped: [],
      previous: { runtime: 'codex' },
      config: { runtime: 'codex' },
    });
  });

  it('preserves __proto__ as an own JSON key in set, setIfAbsent, and previous', () => {
    const setResult = evaluateConfigUpdate({}, JSON.parse('{"set":{"__proto__":{"set":true}}}'));
    assert.equal(Object.hasOwn(setResult.config, '__proto__'), true);
    assert.deepEqual(setResult.config.__proto__, { set: true });

    const absentResult = evaluateConfigUpdate({}, JSON.parse('{"setIfAbsent":{"__proto__":{"absent":true}}}'));
    assert.equal(Object.hasOwn(absentResult.config, '__proto__'), true);
    assert.deepEqual(absentResult.config.__proto__, { absent: true });

    const current = JSON.parse('{"__proto__":{"old":true}}');
    const previousResult = evaluateConfigUpdate(current, JSON.parse('{"set":{"__proto__":{"next":true}}}'));
    assert.equal(Object.hasOwn(previousResult.previous, '__proto__'), true);
    assert.deepEqual(previousResult.previous.__proto__, { old: true });
    assert.equal(Object.hasOwn(previousResult.config, '__proto__'), true);
    assert.deepEqual(previousResult.config.__proto__, { next: true });
  });
});
