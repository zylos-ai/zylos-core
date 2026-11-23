import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWebConsoleRoute, removeWebConsoleRoute } from '../web-console-route.js';
import { validateAndDeploy } from '../caddy.js';

const route = redirect => [
  '    # Web Console (core built-in)',
  ...(redirect ? ['    redir /console /console/ permanent'] : []),
  '    handle /console/* {',
  '        uri strip_prefix /console',
  '        reverse_proxy localhost:3456',
  '    }',
].join('\n') + '\n';
const before = '{\n    auto_https off\n}\nexample.com {\n    root * /srv/public\n\n';
const after = '\n    handle /health {\n        respond "ok { }"\n    }\n    file_server\n}\n';

function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-route-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.mkdirSync(path.join(root, 'http'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/caddy'), 'fixture');
  const caddyfile = path.join(root, 'http/Caddyfile');
  fs.writeFileSync(caddyfile, content, {mode:0o640});
  return {root, caddyfile};
}


for (const [name, suffix] of [
  ['same-site route', '    handle /other/* {\n        reverse_proxy localhost:3456\n    }\n' + after],
  ['other site', after + 'other.example {\n    reverse_proxy localhost:3456\n}\n'],
]) {
  for (const redirect of [false, true]) {
    test(`removes generated route ${redirect ? 'with' : 'without'} redirect while preserving unrelated ${name} on port 3456`, t => {
      const original = before + route(redirect) + suffix;
      const expected = before.slice(0, -1) + suffix;
      const {root, caddyfile} = fixture(t, original);
      let deployments = 0;
      const result = removeWebConsoleRoute({zylosDir:root, deploy:(next, old, options) => {
        deployments++;
        assert.equal(old, original);
        assert.equal(next, expected);
        return validateAndDeploy(next, old, {...options, validate:() => {}, reload:() => {}});
      }});
      assert.equal(deployments, 1);
      assert.deepEqual(result, {changed:true, warnings:[`Removed the generated Web Console route from ${caddyfile}.`]});
      assert.equal(fs.readFileSync(caddyfile, 'utf8'), expected);
      assert.deepEqual(inspectWebConsoleRoute(expected), {state:'absent', related:[]});
      assert.deepEqual(removeWebConsoleRoute({zylosDir:root, deploy:() => assert.fail('deploy unrelated route')}), {changed:false, warnings:[]});
    });
  }

}

test('reload failure atomically restores original bytes and permissions', t => {
  const original = before + route(true) + after;
  const {caddyfile} = fixture(t, original);
  let reloads = 0;
  const result = validateAndDeploy('candidate', original, {caddyfile, validate:() => {}, reload:() => {
    reloads++;
    assert.equal(fs.readFileSync(caddyfile, 'utf8'), reloads === 1 ? 'candidate' : original);
    throw Error('reload unavailable');
  }});
  assert.equal(result.success, false);
  assert.match(result.error, /original Caddyfile restored/);
  assert.equal(reloads, 2);
  assert.equal(fs.readFileSync(caddyfile, 'utf8'), original);
  assert.equal(fs.statSync(caddyfile).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(path.dirname(caddyfile)), ['Caddyfile']);
});
