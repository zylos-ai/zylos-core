import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'docker/dashboard-host.mjs');
const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

// Runs the real container step on a private file. Run when the Docker Dashboard step changes; skip otherwise.
// Only a temporary directory is touched: no Docker, PM2, tmux, network or database.
function run(content, mode = 0o600) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-host-')));
  fixtures.push(dir);
  const file = path.join(dir, 'config.json');
  if (content !== undefined) fs.writeFileSync(file, content, { mode });
  const result = spawnSync(process.execPath, [script, file], {
    cwd: dir, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
  });
  const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  return { ...result, file, after, mode: after === undefined ? null : fs.statSync(file).mode & 0o777, entries: fs.readdirSync(dir) };
}

describe('Dashboard listen address in the container', () => {
  test('sets 0.0.0.0 when the file has no host, keeping other keys and permissions', () => {
    const result = run(JSON.stringify({ port: 3470, auth: { enabled: true, password: 'hash' } }), 0o640);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.after), { port: 3470, auth: { enabled: true, password: 'hash' }, host: '0.0.0.0' });
    assert.equal(result.mode, 0o640);
    assert.deepEqual(result.entries, ['config.json']);
    assert.ok(!(result.stdout + result.stderr).includes('hash'));
  });

});

describe('Docker Codex launch arguments', () => {
  test('disables interactive tools before the permission bypass condition and preserves the setting when bypassing', () => {
    const entrypoint = fs.readFileSync(path.join(root, 'docker/entrypoint.sh'), 'utf8');
    assert.ok(entrypoint.includes('  CODEX_ARGS="-c tools.experimental_request_user_input.enabled=false -c features.goals=false -c features.apps=false"\n'
      + '  if [ "${CODEX_BYPASS_PERMISSIONS:-true}" = "true" ]; then\n'
      + '    CODEX_ARGS="${CODEX_ARGS} --dangerously-bypass-approvals-and-sandbox"\n'
      + '  fi'));
    assert.ok(entrypoint.includes('exec codex ${CODEX_ARGS}'));
    assert.equal(entrypoint.match(/tools\.experimental_request_user_input\.enabled=false/g).length, 1);
  });
});

describe('Docker Claude launch arguments', () => {
  test('disables interactive tools before the permission bypass condition and keeps the single-argument form', () => {
    const entrypoint = fs.readFileSync(path.join(root, 'docker/entrypoint.sh'), 'utf8');
    assert.ok(entrypoint.includes('  CLAUDE_ARGS="--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode,Artifact,ReportFindings,Workflow"\n'
      + '  if [ "${CLAUDE_BYPASS_PERMISSIONS:-true}" = "true" ]; then\n'
      + '    CLAUDE_ARGS="${CLAUDE_ARGS} --dangerously-skip-permissions"\n'
      + '  fi'));
    assert.doesNotMatch(entrypoint, /--disallowedTools(?:\s|["'])/);
    assert.ok(entrypoint.includes('exec claude ${CLAUDE_ARGS}'));
    assert.equal(entrypoint.match(/--disallowedTools=/g).length, 1);
  });
});
