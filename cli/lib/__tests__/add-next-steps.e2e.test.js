import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

// Runs the real `zylos add` against a local component directory with a
// private ZYLOS_DIR. The fixtures declare no npm install, service, hooks,
// bin links or HTTP routes, so nothing outside the temporary directory is
// touched.

const CLI = path.join(import.meta.dirname, '..', '..', 'zylos.js');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeFixture(name, frontmatter) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-add-next-steps-'));
  tmpDirs.push(root);
  const zylosDir = path.join(root, 'zylos-home');
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), '{}\n', 'utf8');
  const sourceDir = path.join(root, name);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'SKILL.md'),
    `---\nname: ${name}\nversion: 1.0.0\ndescription: next-steps fixture\n${frontmatter}---\n\n# Fixture\n`,
    'utf8'
  );
  return { root, zylosDir, target: `./${name}` };
}

function runAdd({ root, zylosDir, target }, extraArgs) {
  const result = spawnSync(process.execPath, [CLI, 'add', target, ...extraArgs], {
    cwd: root,
    env: { ...process.env, ZYLOS_DIR: zylosDir, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout;
}

const TOP_LEVEL = 'next-steps: "Ask the user for the verification token, then pm2 restart zylos-top"\n';
const UNDER_LIFECYCLE = 'lifecycle:\n  next-steps: "Restart agent session to activate fixture hooks."\n';

describe('zylos add next-steps', () => {
  it('prints top-level next-steps after the success line in terminal mode', () => {
    const stdout = runAdd(makeFixture('top-level-steps', TOP_LEVEL), ['--yes']);

    assert.match(stdout, /✓ top-level-steps installed successfully!\n\nNext: Ask the user for the verification token, then pm2 restart zylos-top\n/);
  });

  it('prints next-steps declared under lifecycle in terminal mode', () => {
    const stdout = runAdd(makeFixture('lifecycle-steps', UNDER_LIFECYCLE), ['--yes']);

    assert.match(stdout, /✓ lifecycle-steps installed successfully!\n\nNext: Restart agent session to activate fixture hooks\.\n/);
  });

  it('prints no Next line in terminal mode when none is declared', () => {
    const stdout = runAdd(makeFixture('no-steps', ''), ['--yes']);

    assert.match(stdout, /✓ no-steps installed successfully!/);
    assert.doesNotMatch(stdout, /Next:/);
  });

  it('reports next-steps declared under lifecycle in JSON mode', () => {
    const output = JSON.parse(runAdd(makeFixture('lifecycle-json', UNDER_LIFECYCLE), ['--json']));

    assert.equal(output.success, true);
    assert.equal(output.skill.nextSteps, 'Restart agent session to activate fixture hooks.');
    assert.equal(output.reply, 'lifecycle-json installed (v1.0.0)\nNext: Restart agent session to activate fixture hooks.');
  });

  it('prefers the top-level value when both locations declare next-steps', () => {
    const fixture = makeFixture('both-locations', `${TOP_LEVEL}${UNDER_LIFECYCLE}`);
    const output = JSON.parse(runAdd(fixture, ['--json']));

    assert.equal(output.skill.nextSteps, 'Ask the user for the verification token, then pm2 restart zylos-top');
    assert.match(output.reply, /\nNext: Ask the user for the verification token, then pm2 restart zylos-top$/);
  });

  it('keeps nextSteps null in JSON mode when none is declared', () => {
    const output = JSON.parse(runAdd(makeFixture('no-steps-json', ''), ['--json']));

    assert.equal(output.skill.nextSteps, null);
    assert.doesNotMatch(output.reply, /Next:/);
  });
});
