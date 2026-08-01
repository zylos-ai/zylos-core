import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';
import { isLocalAddress } from '../cli/commands/init.js';
import { applyCaddyRoutes, generateManualRouteSnippet, generateRouteBlocks } from '../cli/lib/caddy.js';

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
