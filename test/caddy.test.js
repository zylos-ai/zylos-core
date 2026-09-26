import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';
import { isLocalAddress } from '../cli/commands/init.js';
import {
  applyCaddyRoutes,
  generateCookieAllowlistDirectives,
  generateManualRouteSnippet,
  generateRouteBlocks,
  validateHttpRoutes,
} from '../cli/lib/caddy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('isLocalAddress', () => {
  // Positive cases — should return true
  test('localhost', () => {
    expect(isLocalAddress('localhost')).toBe(true);
  });

  test('localhost with trailing dot (FQDN)', () => {
    expect(isLocalAddress('localhost.')).toBe(true);
  });

  test('localhost case-insensitive', () => {
    expect(isLocalAddress('LOCALHOST')).toBe(true);
    expect(isLocalAddress('Localhost')).toBe(true);
  });

  test('localhost with whitespace', () => {
    expect(isLocalAddress('  localhost  ')).toBe(true);
  });

  test('0.0.0.0 (bind-all)', () => {
    expect(isLocalAddress('0.0.0.0')).toBe(true);
  });

  test('127.x.x.x loopback', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('127.0.1.1')).toBe(true);
    expect(isLocalAddress('127.255.255.255')).toBe(true);
  });

  test('10.x.x.x private range', () => {
    expect(isLocalAddress('10.0.0.1')).toBe(true);
    expect(isLocalAddress('10.255.0.1')).toBe(true);
  });

  test('172.16-31.x.x private range', () => {
    expect(isLocalAddress('172.16.0.1')).toBe(true);
    expect(isLocalAddress('172.19.0.1')).toBe(true);
    expect(isLocalAddress('172.20.0.1')).toBe(true);
    expect(isLocalAddress('172.31.255.255')).toBe(true);
  });

  test('192.168.x.x private range', () => {
    expect(isLocalAddress('192.168.0.1')).toBe(true);
    expect(isLocalAddress('192.168.1.100')).toBe(true);
  });

  test('::1 IPv6 loopback', () => {
    expect(isLocalAddress('::1')).toBe(true);
  });

  test('::ffff:127.0.0.1 IPv4-mapped IPv6 loopback', () => {
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
  });

  test('fe80:: IPv6 link-local', () => {
    expect(isLocalAddress('fe80::1')).toBe(true);
    expect(isLocalAddress('FE80::abc')).toBe(true);
  });

  test('fc00::/fd00:: IPv6 unique local', () => {
    expect(isLocalAddress('fc00::1')).toBe(true);
    expect(isLocalAddress('fd00::1')).toBe(true);
    expect(isLocalAddress('fd12::1')).toBe(true);
  });

  // Negative cases — should return false
  test('public domain', () => {
    expect(isLocalAddress('example.com')).toBe(false);
    expect(isLocalAddress('zylos.example.com')).toBe(false);
  });

  test('public IP', () => {
    expect(isLocalAddress('8.8.8.8')).toBe(false);
    expect(isLocalAddress('1.1.1.1')).toBe(false);
  });

  test('172.x outside private range (172.15, 172.32)', () => {
    expect(isLocalAddress('172.15.0.1')).toBe(false);
    expect(isLocalAddress('172.32.0.1')).toBe(false);
  });

  test('192.x outside private range', () => {
    expect(isLocalAddress('192.167.1.1')).toBe(false);
    expect(isLocalAddress('192.169.1.1')).toBe(false);
  });

  test('::2 is not loopback', () => {
    expect(isLocalAddress('::2')).toBe(false);
  });

  test('public IPv6', () => {
    expect(isLocalAddress('2001:db8::1')).toBe(false);
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

    expect(block).toContain('    redir /recruit /recruit/ permanent');
    expect(block).toContain('        uri strip_prefix /recruit');
    expect(block).toContain('        reverse_proxy localhost:3465 {');
    expect(block).toContain('            header_up X-Forwarded-Prefix /recruit');
  });

  test('keeps simple reverse proxy routes as single-line directives', () => {
    const block = generateRouteBlocks([{
      path: '/api/*',
      type: 'reverse_proxy',
      target: 'localhost:3000',
    }]);

    expect(block).toContain('        reverse_proxy localhost:3000');
    expect(block).not.toContain('header_up X-Forwarded-Prefix');
    expect(block).not.toContain('reverse_proxy localhost:3000 {');
  });

  test('generates a declarative cookie allowlist before the reverse proxy', () => {
    const block = generateRouteBlocks([{
      path: '/pages/*',
      type: 'reverse_proxy',
      target: 'localhost:3462',
      strip_prefix: '/pages',
      cookie_allowlist: {
        exact: ['__Secure-zylos_pages_session', '__Secure-share_access'],
        patterns: ['^__Secure-share_access\\.[a-f0-9]{32}$'],
      },
    }]);

    expect(block).toContain('map {http.request.header.Cookie} {zylos_cookie_0_name_1}');
    expect(block).toContain('__Secure-zylos_pages_session "1"');
    expect(block).toContain('~^(__Secure-share_access\\.[a-f0-9]{32})$ "1"');
    expect(block).toContain('1 "{zylos_cookie_0_name_1}={zylos_cookie_0_value_1}; "');
    expect(block).toContain('request_header Cookie "{zylos_cookie_0_pair_1}{zylos_cookie_0_pair_2}');
    expect(block.indexOf('request_header Cookie')).toBeLessThan(block.indexOf('reverse_proxy localhost:3462'));
    expect(block).not.toContain('__Host-zylos_dashboard_session');
  });

  test('uses route-scoped placeholders and deterministic output across reinstall/upgrade', () => {
    const routes = [{
      path: '/pages/*', type: 'reverse_proxy', target: 'localhost:3462',
      cookie_allowlist: { exact: ['session'], patterns: ['^grant\\.[a-f0-9]{32}$'] },
    }];
    expect(generateRouteBlocks(routes)).toBe(generateRouteBlocks(routes));
    expect(generateRouteBlocks([...routes, ...routes])).toContain('{zylos_cookie_1_name_1}');
  });

  test('preserves declared matching semantics for duplicates, order, and prefix collisions', () => {
    const block = generateRouteBlocks([{
      path: '/pages/*', type: 'reverse_proxy', target: 'localhost:3462',
      cookie_allowlist: {
        exact: ['session'],
        patterns: ['^grant\\.[a-f0-9]{32}$'],
      },
    }]);
    expect(block).toContain('session "1"');
    expect(block).toContain('~^(grant\\.[a-f0-9]{32})$ "1"');
    expect(block).not.toContain('session_backup "1"');
    expect(new Set(block.match(/\{zylos_cookie_0_pair_\d+\}/g)).size).toBe(32);
  });

  test('rejects empty, unanchored, and prefix-like cookie declarations', () => {
    expect(() => generateCookieAllowlistDirectives({ exact: [] })).toThrow(/non-empty/);
    expect(() => generateCookieAllowlistDirectives({ patterns: ['share_access'] })).toThrow(/anchored/);
    expect(() => generateCookieAllowlistDirectives({ exact: ['session*'] })).toThrow(/invalid exact/);
    expect(() => generateCookieAllowlistDirectives({ patterns: ['^safe$\nheader_up X-Test injected'] })).toThrow(/anchored/);
    expect(() => generateCookieAllowlistDirectives({ patterns: ['^.*$'] })).toThrow(/must not match every/);
    expect(() => generateCookieAllowlistDirectives({ patterns: ['^.+$'] })).toThrow(/must not match every/);
    expect(() => generateCookieAllowlistDirectives({ patterns: ['^{$COOKIE}$'] })).toThrow(/placeholders/);
    expect(() => generateCookieAllowlistDirectives({ patterns: ['^{http.request.header.Cookie}$'] })).toThrow(/placeholders/);
    expect(() => generateCookieAllowlistDirectives({ patterns: ['^grant\\.[a-f0-9]{1,32}$'] })).not.toThrow();
  });

  test('keeps every declared pattern alternative inside full-name anchors', () => {
    const block = generateCookieAllowlistDirectives({ patterns: ['^first|second$'] }).join('\n');
    expect(block).toContain('~^(first|second)$ "1"');
    expect(block).not.toContain('~^first|second$ "1"');
  });
});

describe('validateHttpRoutes', () => {
  test('accepts the supported reverse proxy schema and bounded cookie patterns', () => {
    expect(validateHttpRoutes([{
      path: '/pages/*', type: 'reverse_proxy', target: 'localhost:3462',
      strip_prefix: '/pages',
      cookie_allowlist: { exact: ['session'], patterns: ['^grant\\.[a-f0-9]{32}$'] },
    }])).toEqual({ valid: true });
  });

  test.each([
    [{ type: 'reverse_proxy', path: 'pages/*', target: 'localhost:3462' }, /path must start/],
    [{ type: 'file_server', path: '/pages/*', target: 'localhost:3462' }, /type must be reverse_proxy/],
    [{ type: 'reverse_proxy', path: '/pages/*', target: 'localhost:3462', cookie_allowlist: { patterns: ['^.*$'] } }, /must not match every/],
    [{ type: 'reverse_proxy', path: '/pages/*', target: 'localhost:3462', cookie_allowlist: { patterns: ['^{$COOKIE}$'] } }, /placeholders/],
    [{ type: 'reverse_proxy', path: '/pages/*', target: 'localhost:3462', cookie_allowlist: { patterns: ['^{http.request.header.Cookie}$'] } }, /placeholders/],
  ])('rejects invalid route declarations without throwing', (route, expected) => {
    expect(validateHttpRoutes([route])).toEqual({ valid: false, error: expect.stringMatching(expected) });
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

    expect(snippet).toContain('    # BEGIN zylos-component:dashboard');
    expect(snippet).toContain('    redir /dashboard /dashboard/ permanent');
    expect(snippet).toContain('        uri strip_prefix /dashboard');
    expect(snippet).toContain('        reverse_proxy localhost:3000 {');
    expect(snippet).toContain('            header_up X-Forwarded-Prefix /dashboard');
    expect(snippet).toContain('    # END zylos-component:dashboard');
  });
});

describe('applyCaddyRoutes', () => {
  test('rejects invalid declarations before checking Caddy availability', () => {
    const result = applyCaddyRoutes('dashboard', [{
      path: '/dashboard/*', type: 'reverse_proxy', target: 'localhost:3000',
      cookie_allowlist: { patterns: ['^.*$'] },
    }], { isCaddyAvailable: () => false });

    expect(result.success).toBe(false);
    expect(result.action).toBe('invalid');
    expect(result.error).toMatch(/must not match every/);
  });

  test('rejects a non-array declaration instead of treating it as absent', () => {
    const result = applyCaddyRoutes('dashboard', { path: '/dashboard/*' }, {
      isCaddyAvailable: () => false,
    });

    expect(result).toEqual({
      success: false,
      action: 'invalid',
      error: 'http_routes must be an array',
    });
  });

  test('returns manual configuration details when zylos-managed Caddy is unavailable', () => {
    const result = applyCaddyRoutes('dashboard', [{
      path: '/dashboard/*',
      type: 'reverse_proxy',
      target: 'localhost:3000',
      strip_prefix: '/dashboard',
    }], {
      isCaddyAvailable: () => false,
    });

    expect(result.success).toBe(false);
    expect(result.action).toBe('manual_required');
    expect(result.error).toBe('caddy_not_available');
    expect(result.caddyfile).toBeTruthy();
    expect(result.caddyBin).toBeTruthy();
    expect(result.manualConfigPlacement).toBe('inside_primary_site_block');
    expect(result.message).toBe('Zylos-managed Caddy is not available. HTTP routes were not configured automatically.');
    expect(result.manualConfig).toContain('# BEGIN zylos-component:dashboard');
    expect(result.manualConfig).toContain('handle /dashboard/* {');
    expect(result.manualConfig).toContain('reverse_proxy localhost:3000 {');
  });

  test('skips empty route declarations before checking Caddy availability', () => {
    const result = applyCaddyRoutes('dashboard', [], {
      isCaddyAvailable: () => false,
    });

    expect(result).toEqual({ success: true, action: 'skipped' });
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
    expect(caddyLiterals.length).toBeGreaterThan(0);
    expect(caddyLiterals[0]).toContain(NOINDEX_DIRECTIVE);
  });

  test('skills/http/Caddyfile.template contains X-Robots-Tag as a Caddy directive', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', 'skills', 'http', 'Caddyfile.template'), 'utf8'
    );
    const lines = template.split('\n').filter(l => !l.trim().startsWith('#'));
    expect(lines.some(l => l.includes('header >X-Robots-Tag "noindex, nofollow"'))).toBe(true);
  });

  test('skills/http/scripts/setup-caddy.js embeds X-Robots-Tag in its Caddyfile template literal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'skills', 'http', 'scripts', 'setup-caddy.js'), 'utf8'
    );
    const literals = extractTemplateLiterals(src);
    const caddyLiterals = literals.filter(l => l.includes('Zylos Caddyfile'));
    expect(caddyLiterals.length).toBeGreaterThan(0);
    expect(caddyLiterals[0]).toContain(NOINDEX_DIRECTIVE);
  });
});
