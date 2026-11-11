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

for (const redirect of [false, true]) {
  test(`removes generated route ${redirect ? 'with' : 'without'} redirect and preserves surrounding bytes`, () => {
    const original = before + route(redirect) + after;
    const result = inspectWebConsoleRoute(original);
    assert.equal(result.state, 'generated');
    assert.equal(result.content, before.slice(0, -1) + after);
    assert.equal(inspectWebConsoleRoute(result.content).state, 'absent');
  });
}

test('accepts CRLF, indentation and trailing whitespace without normalizing other bytes', () => {
  const generated = route(true).split('\n').slice(0, -1).map(line => '\t' + line + ' \t\r\n').join('');
  const original = before.replaceAll('\n', '\r\n') + generated + after.replaceAll('\n', '\r\n');
  assert.equal(inspectWebConsoleRoute(original).content, (before.slice(0, -1) + after).replaceAll('\n', '\r\n'));
});

for (const [name, content] of [
  ['authentication', before + route(true).replace('        uri', '        basic_auth {\n            user hash\n        }\n        uri') + after],
  ['changed port', before + route(true).replace(':3456', ':9999') + after],
  ['duplicate route', before + route(true) + route(false) + after],
  ['route outside site', before + after + route(true)],
  ['route in second site', before + after + 'other.example {\n' + route(true) + '}\n'],
  ['missing marker', before + route(true).replace('    # Web Console (core built-in)\n', '') + after],
  ['nested route', before + '    handle {\n' + route(true) + '    }\n' + after],
  ['additional console reference', before + route(true) + after + '# custom /console\n'],
]) {
  test(`preserves ${name} and supplies original affected lines`, t => {
    const {root, caddyfile} = fixture(t, content);
    let called = false;
    const result = removeWebConsoleRoute({zylosDir:root, deploy:() => { called = true; }});
    assert.equal(called, false);
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(caddyfile, 'utf8'), content);
    assert.match(result.warnings.join('\n'), /Web Console has been removed/);
    assert.ok(result.warnings.join('\n').includes(caddyfile));
    assert.match(result.warnings.join('\n'), /pm2 reload caddy/);
    for (const line of content.split(/\r?\n/).filter(line => /\/console|:3456/.test(line))) assert.ok(result.warnings.join('\n').includes(line));
  });
}

test('missing Caddy, missing Caddyfile and no-Caddy option silently skip', t => {
  const {root, caddyfile} = fixture(t, before + route(true) + after);
  assert.deepEqual(removeWebConsoleRoute({zylosDir:root, noCaddy:true}), {changed:false, warnings:[]});
  fs.unlinkSync(path.join(root, 'bin/caddy'));
  assert.deepEqual(removeWebConsoleRoute({zylosDir:root}), {changed:false, warnings:[]});
  fs.writeFileSync(path.join(root, 'bin/caddy'), 'fixture');
  fs.unlinkSync(caddyfile);
  assert.deepEqual(removeWebConsoleRoute({zylosDir:root}), {changed:false, warnings:[]});
});

test('validation runs against same-directory candidate before atomic replacement and preserves metadata', t => {
  const original = before + route(true) + after;
  const {root, caddyfile} = fixture(t, original);
  const stat = fs.statSync(caddyfile);
  const expected = inspectWebConsoleRoute(original).content;
  let reloads = 0;
  const result = removeWebConsoleRoute({zylosDir:root, deploy:(next, old, options) => validateAndDeploy(next, old, {
    ...options,
    validate: candidate => {
      assert.equal(path.dirname(candidate), path.dirname(caddyfile));
      assert.equal(fs.readFileSync(caddyfile, 'utf8'), original);
      assert.equal(fs.readFileSync(candidate, 'utf8'), expected);
      assert.equal(fs.statSync(candidate).mode & 0o7777, stat.mode & 0o7777);
    },
    reload:() => { reloads++; assert.equal(fs.readFileSync(caddyfile, 'utf8'), expected); },
  })});
  assert.equal(result.changed, true);
  assert.equal(reloads, 1);
  const updated = fs.statSync(caddyfile);
  assert.notEqual(updated.ino, stat.ino);
  assert.equal(updated.uid, stat.uid);
  assert.equal(updated.gid, stat.gid);
  assert.equal(updated.mode & 0o7777, stat.mode & 0o7777);
  assert.deepEqual(fs.readdirSync(path.dirname(caddyfile)), ['Caddyfile']);
  assert.deepEqual(removeWebConsoleRoute({zylosDir:root}), {changed:false, warnings:[]});
});

test('validation failure keeps original file and never reloads', t => {
  const original = before + route(false) + after;
  const {caddyfile} = fixture(t, original);
  const inode = fs.statSync(caddyfile).ino;
  const result = validateAndDeploy('candidate', original, {caddyfile,
    validate:() => { throw Error('invalid'); }, reload:() => assert.fail('reload after rejected validation')});
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(caddyfile, 'utf8'), original);
  assert.equal(fs.statSync(caddyfile).ino, inode);
  assert.deepEqual(fs.readdirSync(path.dirname(caddyfile)), ['Caddyfile']);
});

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

test('symlink Caddyfiles and edits during validation are preserved', t => {
  const {caddyfile} = fixture(t, 'original');
  const target = caddyfile + '.target';
  fs.renameSync(caddyfile, target);
  fs.symlinkSync(target, caddyfile);
  assert.equal(validateAndDeploy('candidate', 'original', {caddyfile, validate:() => assert.fail()}).success, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  fs.unlinkSync(caddyfile);
  fs.renameSync(target, caddyfile);
  const result = validateAndDeploy('candidate', 'original', {caddyfile, validate:() => fs.writeFileSync(caddyfile, 'user edit'), reload:() => assert.fail()});
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(caddyfile, 'utf8'), 'user edit');
});
