import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalAddress } from '../cli/commands/init.js';
import { applyCaddyRoutes, generateManualRouteSnippet, generateRouteBlocks } from '../cli/lib/caddy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('isLocalAddress', () => {
  // Positive cases — should return true
  test('localhost', () => {
    assert.equal(isLocalAddress('localhost'), true);
  });

  test('localhost with trailing dot (FQDN)', () => {
    assert.equal(isLocalAddress('localhost.'), true);
  });

  test('localhost case-insensitive', () => {
    assert.equal(isLocalAddress('LOCALHOST'), true);
    assert.equal(isLocalAddress('Localhost'), true);
  });

  test('localhost with whitespace', () => {
    assert.equal(isLocalAddress('  localhost  '), true);
  });

  test('0.0.0.0 (bind-all)', () => {
    assert.equal(isLocalAddress('0.0.0.0'), true);
  });

  test('127.x.x.x loopback', () => {
    assert.equal(isLocalAddress('127.0.0.1'), true);
    assert.equal(isLocalAddress('127.0.1.1'), true);
    assert.equal(isLocalAddress('127.255.255.255'), true);
  });

  test('10.x.x.x private range', () => {
    assert.equal(isLocalAddress('10.0.0.1'), true);
    assert.equal(isLocalAddress('10.255.0.1'), true);
  });

  test('172.16-31.x.x private range', () => {
    assert.equal(isLocalAddress('172.16.0.1'), true);
    assert.equal(isLocalAddress('172.19.0.1'), true);
    assert.equal(isLocalAddress('172.20.0.1'), true);
    assert.equal(isLocalAddress('172.31.255.255'), true);
  });

  test('192.168.x.x private range', () => {
    assert.equal(isLocalAddress('192.168.0.1'), true);
    assert.equal(isLocalAddress('192.168.1.100'), true);
  });

  test('::1 IPv6 loopback', () => {
    assert.equal(isLocalAddress('::1'), true);
  });

  test('::ffff:127.0.0.1 IPv4-mapped IPv6 loopback', () => {
    assert.equal(isLocalAddress('::ffff:127.0.0.1'), true);
  });

  test('fe80:: IPv6 link-local', () => {
    assert.equal(isLocalAddress('fe80::1'), true);
    assert.equal(isLocalAddress('FE80::abc'), true);
  });

  test('fc00::/fd00:: IPv6 unique local', () => {
    assert.equal(isLocalAddress('fc00::1'), true);
    assert.equal(isLocalAddress('fd00::1'), true);
    assert.equal(isLocalAddress('fd12::1'), true);
  });

  // Negative cases — should return false
  test('public domain', () => {
    assert.equal(isLocalAddress('example.com'), false);
    assert.equal(isLocalAddress('zylos.example.com'), false);
  });

  test('public IP', () => {
    assert.equal(isLocalAddress('8.8.8.8'), false);
    assert.equal(isLocalAddress('1.1.1.1'), false);
  });

  test('172.x outside private range (172.15, 172.32)', () => {
    assert.equal(isLocalAddress('172.15.0.1'), false);
    assert.equal(isLocalAddress('172.32.0.1'), false);
  });

  test('192.x outside private range', () => {
    assert.equal(isLocalAddress('192.167.1.1'), false);
    assert.equal(isLocalAddress('192.169.1.1'), false);
  });

  test('::2 is not loopback', () => {
    assert.equal(isLocalAddress('::2'), false);
  });

  test('public IPv6', () => {
    assert.equal(isLocalAddress('2001:db8::1'), false);
  });
});

describe('generateRouteBlocks', () => {
  test('adds X-Forwarded-Prefix for stripped reverse proxy routes', () => {
    const block = generateRouteBlocks([{
      path: '/recruit/*',
      type: 'reverse_proxy',
      target: 'localhost:3465',
      strip_prefix: '/recruit',
    }]);

    assert.ok(block.includes('    redir /recruit /recruit/ permanent'));
    assert.ok(block.includes('        uri strip_prefix /recruit'));
    assert.ok(block.includes('        reverse_proxy localhost:3465 {'));
    assert.ok(block.includes('            header_up X-Forwarded-Prefix /recruit'));
  });

  test('keeps simple reverse proxy routes as single-line directives', () => {
    const block = generateRouteBlocks([{
      path: '/api/*',
      type: 'reverse_proxy',
      target: 'localhost:3000',
    }]);

    assert.ok(block.includes('        reverse_proxy localhost:3000'));
    assert.ok(!block.includes('header_up X-Forwarded-Prefix'));
    assert.ok(!block.includes('reverse_proxy localhost:3000 {'));
  });
});

describe('generateManualRouteSnippet', () => {
  test('wraps route blocks in zylos component markers', () => {
    const snippet = generateManualRouteSnippet('dashboard', [{
      path: '/dashboard/*',
      type: 'reverse_proxy',
      target: 'localhost:3000',
      strip_prefix: '/dashboard',
    }]);

    assert.ok(snippet.includes('    # BEGIN zylos-component:dashboard'));
    assert.ok(snippet.includes('    redir /dashboard /dashboard/ permanent'));
    assert.ok(snippet.includes('        uri strip_prefix /dashboard'));
    assert.ok(snippet.includes('        reverse_proxy localhost:3000 {'));
    assert.ok(snippet.includes('            header_up X-Forwarded-Prefix /dashboard'));
    assert.ok(snippet.includes('    # END zylos-component:dashboard'));
  });
});

describe('applyCaddyRoutes', () => {
  test('returns manual configuration details when zylos-managed Caddy is unavailable', () => {
    const result = applyCaddyRoutes('dashboard', [{
      path: '/dashboard/*',
      type: 'reverse_proxy',
      target: 'localhost:3000',
      strip_prefix: '/dashboard',
    }], {
      isCaddyAvailable: () => false,
      readFileSync: () => { throw new Error('Caddyfile unavailable'); },
    });

    assert.equal(result.success, false);
    assert.equal(result.action, 'manual_required');
    assert.equal(result.error, 'caddy_not_available');
    assert.ok(result.caddyfile);
    assert.ok(result.caddyBin);
    assert.equal(result.manualConfigPlacement, 'inside_primary_site_block');
    assert.equal(result.message, 'Zylos-managed Caddy is not available. HTTP routes were not configured automatically.');
    assert.ok(result.manualConfig.includes('# BEGIN zylos-component:dashboard'));
    assert.ok(result.manualConfig.includes('handle /dashboard/* {'));
    assert.ok(result.manualConfig.includes('reverse_proxy localhost:3000 {'));
  });

  test('skips empty route declarations before checking Caddy availability', () => {
    const result = applyCaddyRoutes('dashboard', [], {
      isCaddyAvailable: () => false,
    });

    assert.deepEqual(result, { success: true, action: 'skipped' });
  });
});

describe('X-Robots-Tag parity across all Caddyfile generation sources', () => {
  const NOINDEX_DIRECTIVE = '    header >X-Robots-Tag "noindex, nofollow"';

  function extractTemplateLiterals(source) {
    const literals = [];
    let i = 0;
    while (i < source.length) {
      if (source[i] === '`') {
        const start = i + 1;
        i++;
        let depth = 1;
        while (i < source.length && depth > 0) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '`') { depth--; break; }
          i++;
        }
        literals.push(source.slice(start, i));
        i++;
      } else {
        i++;
      }
    }
    return literals;
  }

  test('cli/commands/init.js embeds X-Robots-Tag in its Caddyfile template literal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'cli', 'commands', 'init.js'), 'utf8'
    );
    const literals = extractTemplateLiterals(src);
    const caddyLiterals = literals.filter(l => l.includes('Zylos Caddyfile'));
    assert.ok(caddyLiterals.length > 0);
    assert.ok(caddyLiterals[0].includes(NOINDEX_DIRECTIVE));
  });

  test('skills/http/Caddyfile.template contains X-Robots-Tag as a Caddy directive', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', 'skills', 'http', 'Caddyfile.template'), 'utf8'
    );
    const lines = template.split('\n').filter(l => !l.trim().startsWith('#'));
    assert.equal(lines.some(l => l.includes('header >X-Robots-Tag "noindex, nofollow"')), true);
  });

  test('skills/http/scripts/setup-caddy.js embeds X-Robots-Tag in its Caddyfile template literal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'skills', 'http', 'scripts', 'setup-caddy.js'), 'utf8'
    );
    const literals = extractTemplateLiterals(src);
    const caddyLiterals = literals.filter(l => l.includes('Zylos Caddyfile'));
    assert.ok(caddyLiterals.length > 0);
    assert.ok(caddyLiterals[0].includes(NOINDEX_DIRECTIVE));
  });
});
