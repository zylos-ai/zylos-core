import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateWebConsoleRoute, inspectWebConsoleRoute, migrateWebConsoleRoute } from '../web-console-route.js';
import { generateCaddyfile } from '../../commands/init.js';
import { CADDYFILE } from '../config.js';

const stock = `    redir /console /console/ permanent
    handle /console/* {
        uri strip_prefix /console
        reverse_proxy localhost:3456
    }`;
const site = block => `http://localhost:8080 {\n${block}\n}\n`;

test('fresh initialization generates a marked console route with upstream prefix', () => {
  assert.ok(CADDYFILE.startsWith(process.env.ZYLOS_DIR));
  generateCaddyfile('localhost', 'http', 8080);
  const content = fs.readFileSync(CADDYFILE, 'utf8');
  assert.match(content, /# BEGIN zylos-core:web-console/);
  assert.match(content, /header_up X-Forwarded-Prefix \/console/);
  assert.equal(inspectWebConsoleRoute(content).status, 'unchanged');
});

test('stock route migrates with whitespace tolerance and subsequent checks are silent', () => {
  for (const block of [stock, stock.replaceAll('    ', '\t').replaceAll('\n', '\r\n')]) {
    const result = inspectWebConsoleRoute(site(block));
    assert.equal(result.status, 'ready');
    assert.match(result.content, /# BEGIN zylos-core:web-console/);
    assert.match(result.content, /header_up X-Forwarded-Prefix \/console/);
    assert.equal(inspectWebConsoleRoute(result.content).status, 'unchanged');
  }
});

test('unique correct custom formatting and unmarked routes are already complete', () => {
  const correct = generateWebConsoleRoute().replace(/    # (BEGIN|END).*\n?/g, '')
    .replace('            header_up', '            flush_interval -1\n            header_up');
  assert.equal(inspectWebConsoleRoute(site(correct)).status, 'unchanged');
});

test('duplicate, missing, custom, wrong upstream and commented headers require manual work', () => {
  const fixed = generateWebConsoleRoute();
  for (const content of [
    site('respond 200'), site(`${stock}\n${stock}`), site(`${stock}\n${fixed}`), site(`${fixed}\n${fixed}`),
    site(stock.replace('localhost:3456', 'localhost:9999')),
    site(stock.replace('uri strip_prefix /console', 'uri strip_prefix /elsewhere')),
    site(stock.replace('reverse_proxy localhost:3456', '# header_up X-Forwarded-Prefix /console\n        reverse_proxy localhost:3456')),
    site(fixed.replace('localhost:3456', 'localhost:9999')),
    site(`${stock.replace('localhost:3456', 'localhost:9999')}\nhandle /other/* {\n reverse_proxy localhost:3456 {\n header_up X-Forwarded-Prefix /console\n }\n}`),
    site(fixed.replace('X-Forwarded-Prefix /console', 'X-Forwarded-Prefix /wrong')),
    site(fixed.replace('X-Forwarded-Prefix /console', '+X-Forwarded-Prefix /console')),
    site(stock.replace('reverse_proxy localhost:3456', 'reverse_proxy localhost:3456\n        respond 200')),
  ]) assert.equal(inspectWebConsoleRoute(content).status, 'manual_required', content);
});

test('an unrelated upstream header cannot mark the stock route already complete', () => {
  const content = site(`${stock}\nhandle /other/* {\n reverse_proxy localhost:3456 {\n header_up X-Forwarded-Prefix /console\n }\n}`);
  assert.equal(inspectWebConsoleRoute(content).status, 'ready');
});

test('malformed, duplicate or misplaced markers never suppress a warning', () => {
  for (const content of [
    site(`# BEGIN zylos-core:web-console\n${stock}`),
    site(`${stock}\n# END zylos-core:web-console`),
    site(`# BEGIN zylos-core:web-console extra\n${stock}\n# END zylos-core:web-console`),
    site(`# BEGIN zylos-core:web-console\n# END zylos-core:web-console\n${stock}`),
    site(`${generateWebConsoleRoute()}\n# BEGIN zylos-core:web-console`),
  ]) assert.equal(inspectWebConsoleRoute(content).status, 'manual_required');
});

test('imports and unrecognized console matchers remain untouched', () => {
  for (const content of [site(`${stock}\nimport custom-routes`), site(stock.replace('handle /console/*', 'handle_path /console/*')),
    `(shared) {\n${generateWebConsoleRoute()}\n}\n`, site(`route {\n${generateWebConsoleRoute()}\n}`)]) {
    assert.equal(inspectWebConsoleRoute(content).status, 'manual_required');
  }
});

test('alternate named matchers and shorthand proxies prevent migration or silent completion', () => {
  for (const block of [stock, generateWebConsoleRoute()]) {
    for (const alternate of [
      '@alternate /console/*\nroute {\n handle @alternate {\n reverse_proxy localhost:3456\n }\n}',
      'reverse_proxy /console/* localhost:3456',
      'reverse_proxy /console* localhost:3456',
      'route /console/* {\n reverse_proxy localhost:3456\n}',
      'handle @unresolved {\n reverse_proxy localhost:3456\n}',
      'handle /c* {\n reverse_proxy localhost:3456\n}',
      '@markdown path *.md\nroute {\n handle @markdown {\n uri strip_prefix /console\n reverse_proxy localhost:3456\n }\n}',
      '@markdown path *.md\nhandle @markdown {\n reverse_proxy localhost:3456\n}',
    ]) {
      const result = inspectWebConsoleRoute(site(`${alternate}\n${block}`));
      assert.equal(result.status, 'manual_required', alternate);
      assert.ok(result.lines.length);
      assert.equal(Object.hasOwn(result, 'content'), false);
    }
  }
});

test('named matchers confined to unrelated paths or other sites do not shadow console routes', () => {
  const nested = `handle_path /x/* {
    @relay remote_ip 100.64.0.23
    reverse_proxy @relay 127.0.0.1:8787
}`;
  const otherSite = `http://localhost:9090 {
    import custom-routes
    handle @unresolved {
        reverse_proxy localhost:8787
    }
}`;
  for (const [block, status] of [[stock, 'ready'], [generateWebConsoleRoute(), 'unchanged']]) {
    for (const unrelated of [nested, nested.replace('handle_path', 'handle')]) {
      assert.equal(inspectWebConsoleRoute(site(`${block}\n${unrelated}`)).status, status);
      assert.equal(inspectWebConsoleRoute(`${site(block)}\n${otherSite}`).status, status);
    }
  }
});

test('migration rereads state, deploys once and reports exact manual instructions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'http'));
  const filename = path.join(root, 'http/Caddyfile');
  fs.writeFileSync(filename, site(stock));
  let deployments = 0;
  const deps = { zylosDir: root, validateAndDeploy: (candidate, original, options) => {
    deployments++;
    assert.equal(options.caddyfile, filename);
    assert.equal(original, fs.readFileSync(filename, 'utf8'));
    fs.writeFileSync(filename, candidate);
    return { success: true };
  } };
  assert.equal(migrateWebConsoleRoute(deps).status, 'updated');
  assert.deepEqual(migrateWebConsoleRoute(deps), { status: 'unchanged' });
  assert.equal(deployments, 1);
  fs.writeFileSync(filename, site('respond 200'));
  const original = fs.readFileSync(filename);
  const result = migrateWebConsoleRoute(deps);
  assert.equal(result.status, 'manual_required');
  assert.equal(result.caddyfile, filename);
  assert.match(result.instructions.join('\n'), /header_up X-Forwarded-Prefix \/console/);
  assert.match(result.instructions.join('\n'), /validate.*pm2 reload/s);
  assert.match(result.instructions.join('\n'), /Log in again/);
  assert.equal(fs.readFileSync(filename).equals(original), true);
  assert.equal(deployments, 1);
});

test('true absence is silent but configured missing files and config read errors are actionable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-absence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(migrateWebConsoleRoute({ zylosDir: root }), { status: 'not_applicable' });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/caddy'), 'fixture binary');
  assert.deepEqual(migrateWebConsoleRoute({ zylosDir: root }), { status: 'not_applicable' });
  fs.mkdirSync(path.join(root, '.zylos'));
  const config = path.join(root, '.zylos/config.json');
  fs.writeFileSync(config, '{"domain":"example.com"}');
  assert.equal(migrateWebConsoleRoute({ zylosDir: root }).status, 'manual_required');
  fs.writeFileSync(config, '{bad');
  assert.match(migrateWebConsoleRoute({ zylosDir: root }).reason, /Cannot read.*config.json/);
  assert.equal(migrateWebConsoleRoute({ zylosDir: root, readFileSync: () => { throw new Error('permission denied'); } }).status, 'manual_required');
});

// Filesystem migration boundary only: official runner isolates HOME/ZYLOS_DIR,
// and this fixture creates no service, child, database or socket. Run for route
// decoding/deployment changes; unrelated cookie/UI work can skip it.
test('invalid UTF-8 Caddyfiles remain byte-identical and never reach deployment', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-bytes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'http'));
  const filename = path.join(root, 'http/Caddyfile');
  const bytes = Buffer.concat([Buffer.from(site(stock)), Buffer.from([0x23, 0xff, 0x0a])]);
  fs.writeFileSync(filename, bytes);
  const result = migrateWebConsoleRoute({ zylosDir: root,
    validateAndDeploy: () => assert.fail('invalid UTF-8 must not reach deployment'),
  });
  assert.equal(result.status, 'manual_required');
  assert.match(result.reason, /encoded data|encoding/i);
  assert.equal(fs.readFileSync(filename).equals(bytes), true);
});

test('deployment errors become nonfatal actionable results', () => {
  const result = migrateWebConsoleRoute({ zylosDir: '/private-fixture',
    readFileSync: filename => filename.endsWith('config.json') ? '{}' : site(stock),
    validateAndDeploy: () => ({ success: false, error: 'recovery failed: write denied' }),
  });
  assert.equal(result.status, 'manual_required');
  assert.match(result.reason, /recovery failed/);
  assert.ok(result.lines.length);
});
