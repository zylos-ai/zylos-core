import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-tmux-env-'));
process.env.HOME = tmpRoot;
process.env.ZYLOS_DIR = path.join(tmpRoot, 'zylos');
fs.mkdirSync(process.env.ZYLOS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.ZYLOS_DIR, '.env'), '', 'utf8');

const { _parseEnvValue, _readManifestEnvVars } = await import('../runtime/claude.js');

describe('ZYLOS_TMUX_ENV manifest', () => {
  test('_readManifestEnvVars returns empty array when ZYLOS_TMUX_ENV is absent', () => {
    const result = _readManifestEnvVars('FOO=bar\nBAZ=qux\n');
    assert.deepEqual(result, []);
  });

  test('_readManifestEnvVars resolves declared variables from .env content', () => {
    const env = [
      'ZYLOS_TMUX_ENV=OTEL_ENDPOINT,CLAUDE_CODE_ENABLE_TELEMETRY,MY_VAR',
      'OTEL_ENDPOINT=http://localhost:4318',
      'CLAUDE_CODE_ENABLE_TELEMETRY=1',
      'MY_VAR=hello world',
    ].join('\n');

    const result = _readManifestEnvVars(env);
    assert.deepEqual(result, [
      { key: 'OTEL_ENDPOINT', value: 'http://localhost:4318' },
      { key: 'CLAUDE_CODE_ENABLE_TELEMETRY', value: '1' },
      { key: 'MY_VAR', value: 'hello world' },
    ]);
  });

  test('_readManifestEnvVars skips variables not defined in .env', () => {
    const env = [
      'ZYLOS_TMUX_ENV=DEFINED_VAR,MISSING_VAR',
      'DEFINED_VAR=present',
    ].join('\n');

    const result = _readManifestEnvVars(env);
    assert.deepEqual(result, [
      { key: 'DEFINED_VAR', value: 'present' },
    ]);
  });

  test('_readManifestEnvVars handles spaces around commas', () => {
    const env = [
      'ZYLOS_TMUX_ENV=A , B , C',
      'A=1',
      'B=2',
      'C=3',
    ].join('\n');

    const result = _readManifestEnvVars(env);
    assert.deepEqual(result, [
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
      { key: 'C', value: '3' },
    ]);
  });

  test('_readManifestEnvVars handles quoted values', () => {
    const env = [
      'ZYLOS_TMUX_ENV=QUOTED_VAR',
      'QUOTED_VAR="http://localhost:4318"',
    ].join('\n');

    const result = _readManifestEnvVars(env);
    assert.deepEqual(result, [
      { key: 'QUOTED_VAR', value: 'http://localhost:4318' },
    ]);
  });

  test('_readManifestEnvVars returns empty array for empty manifest', () => {
    const env = 'ZYLOS_TMUX_ENV=\n';
    const result = _readManifestEnvVars(env);
    assert.deepEqual(result, []);
  });

  test('_parseEnvValue handles standard key=value', () => {
    assert.equal(_parseEnvValue('FOO=bar', 'FOO'), 'bar');
  });

  test('_parseEnvValue handles spaces around equals', () => {
    assert.equal(_parseEnvValue('FOO = bar', 'FOO'), 'bar');
  });

  test('_parseEnvValue handles double-quoted values', () => {
    assert.equal(_parseEnvValue('FOO="bar baz"', 'FOO'), 'bar baz');
  });

  test('_parseEnvValue handles single-quoted values', () => {
    assert.equal(_parseEnvValue("FOO='bar baz'", 'FOO'), 'bar baz');
  });

  test('_parseEnvValue returns empty string for missing key', () => {
    assert.equal(_parseEnvValue('FOO=bar', 'MISSING'), '');
  });
});
