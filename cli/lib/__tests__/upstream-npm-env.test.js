import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  buildCleanEnv, deployManifestTemplate, loadRuntimeEnvManifest,
  parseRuntimeEnvManifest, writeLaunchSpec,
} from '../runtime/tmux-env.js';

const templatePath = path.resolve(import.meta.dirname, '../../../templates/runtime-env.manifest.example');
const launcher = path.resolve(import.meta.dirname, '../runtime/tmux-launcher.js');
const registry = 'https://registry.example.test/';
const binaryHost = 'https://binary.example.test/better-sqlite3';
const names = ['ZYLOS_UPSTREAM_CONFIG', 'npm_config_registry', 'npm_config_better_sqlite3_binary_host_mirror'];

test('persistent deployment environment reaches real npm lifecycle through clean launch specs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-npm-env-'));
  try {
    // npm is part of the supported Node/npm toolchain, not a mocked executable.
    const npmPath = fs.realpathSync(execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim());
    const deployment = path.join(dir, 'deployment-env.json');
    fs.writeFileSync(deployment, JSON.stringify({
      HOME: dir, PATH: path.dirname(process.execPath),
      npm_config_registry: registry,
      npm_config_better_sqlite3_binary_host_mirror: binaryHost,
      UNRELATED_DEPLOYMENT_SECRET: 'must-not-cross-clean-env',
    }));
    deployManifestTemplate(templatePath, dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'local-environment-probe', version: '1.0.0',
      scripts: { probe: 'node probe.cjs' },
    }));
    fs.writeFileSync(path.join(dir, 'probe.cjs'), `
      require('node:fs').writeFileSync('observed.json', JSON.stringify({
        registry: process.env.npm_config_registry,
        binaryHost: process.env.npm_config_better_sqlite3_binary_host_mirror,
        unrelated: process.env.UNRELATED_DEPLOYMENT_SECRET,
      }));
    `);
    for (const cycle of ['initial', 'supervisor-reload', 'rotation']) {
      // Reload persistent values for each fresh launch. No inherited ambient
      // host environment is allowed to make this pass accidentally.
      const processEnv = JSON.parse(fs.readFileSync(deployment, 'utf8'));
      const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, manifest: loadRuntimeEnvManifest(dir) });
      const spec = writeLaunchSpec({ command: process.execPath, args: [npmPath, 'run', '--silent', 'probe'], env, cwd: dir });
      execFileSync(process.execPath, [launcher, spec], { env: { PATH: path.dirname(process.execPath) }, timeout: 15000 });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'observed.json'), 'utf8')),
        { registry, binaryHost }, cycle);
      assert.equal(fs.existsSync(spec), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing any upstream inherit directive is detected, absent values stay absent', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const processEnv = { ZYLOS_UPSTREAM_CONFIG: 'https://config.example.test/profile', npm_config_registry: registry, npm_config_better_sqlite3_binary_host_mirror: binaryHost };
  const build = content => buildCleanEnv({ processEnv, dotenvVars: {}, manifest: parseRuntimeEnvManifest(content) }).env;
  const check = env => {
    for (const name of names) assert.equal(env[name], processEnv[name], name);
  };
  check(build(template));
  for (const name of names) {
    const mutant = template.replace(`inherit ${name}\n`, '');
    assert.notEqual(mutant, template);
    assert.throws(() => check(build(mutant)), assert.AssertionError, `missing ${name} must fail`);
  }
  const { env } = buildCleanEnv({ processEnv: {}, dotenvVars: {}, manifest: parseRuntimeEnvManifest(template) });
  for (const name of names) assert.equal(Object.hasOwn(env, name), false);
});

test('runtime preflight probes the configured npm registry when official npm is blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-npm-preflight-'));
  try {
    const script = fs.readFileSync(path.resolve(import.meta.dirname, '../../../test/integration/runtime/run.sh'), 'utf8');
    const fn = script.match(/^network_available\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(fn, 'network_available function must exist');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
      case "$*" in *registry.npmjs.org*) exit 42;; esac
      printf '%s\\n' "$*" >> "$PROBE_LOG"
    `, { mode: 0o755 });
    const log = path.join(dir, 'requests.log');
    const opts = { encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: dir,
      npm_config_registry: 'https://mirror.example.test/npm-prefix/', PROBE_LOG: log,
    }, timeout: 15000 };
    execFileSync('bash', ['-c', `${fn}\nnetwork_available`], opts);
    assert.match(fs.readFileSync(log, 'utf8'), /https:\/\/mirror\.example\.test\/npm-prefix\/@anthropic-ai%2fclaude-code/);
    const mutant = fn.replace('"${registry%/}/@anthropic-ai%2fclaude-code"', "'https://registry.npmjs.org/@anthropic-ai%2fclaude-code'");
    assert.notEqual(mutant, fn);
    assert.throws(() => execFileSync('bash', ['-c', `${mutant}\nnetwork_available`], opts),
      error => error.status !== 0, 'official-registry mutant must be rejected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('persistent source environment reaches CLI through real clean launcher across fresh sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-source-env-'));
  try {
    const file = path.join(dir, 'profile.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 'env-probe', providers: { github: { rawBase: 'https://env.example.test/raw/' } } }));
    const deployment = path.join(dir, 'deployment-env.json');
    fs.writeFileSync(deployment, JSON.stringify({ HOME: dir, PATH: path.dirname(process.execPath), ZYLOS_UPSTREAM_CONFIG: file }));
    deployManifestTemplate(templatePath, dir);
    const manifest = loadRuntimeEnvManifest(dir);
    const cli = path.resolve(import.meta.dirname, '../../zylos.js');
    const launch = (processEnv, selectedManifest = manifest, dotenvVars = {}) => {
      const { env } = buildCleanEnv({ processEnv, dotenvVars, manifest: selectedManifest });
      const spec = writeLaunchSpec({ command: process.execPath, args: [cli, 'upstream', 'status', '--resolved'], env, cwd: dir });
      return JSON.parse(execFileSync(process.execPath, [launcher, spec], { env: { PATH: path.dirname(process.execPath) }, encoding: 'utf8', timeout: 15000 }));
    };
    const assertSource = observed => {
      assert.equal(observed.selectedBy, 'environment');
      assert.equal(observed.endpoints.rawBase.url, 'https://env.example.test/raw/');
    };
    for (const cycle of ['initial', 'supervisor-reload', 'rotation']) {
      assertSource(launch(JSON.parse(fs.readFileSync(deployment, 'utf8'))));
      assert.equal(fs.existsSync(path.join(dir, 'zylos/.zylos/upstreams.json')), false, cycle);
    }
    const absent = { HOME: dir, PATH: path.dirname(process.execPath) };
    assert.equal(launch(absent).selectedBy, 'default');
    const withoutSource = parseRuntimeEnvManifest(fs.readFileSync(templatePath, 'utf8').replace('inherit ZYLOS_UPSTREAM_CONFIG\n', ''));
    assert.throws(() => assertSource(launch(JSON.parse(fs.readFileSync(deployment, 'utf8')), withoutSource)), assert.AssertionError);
    assertSource(launch(absent, parseRuntimeEnvManifest('env ZYLOS_UPSTREAM_CONFIG\n'), { ZYLOS_UPSTREAM_CONFIG: file }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
