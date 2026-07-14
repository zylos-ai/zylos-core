import { describe, expect, test } from '@jest/globals';
import {
  checkWebConsoleExposure,
  classifyPermissionSeverity,
  findSiteBlockForPath,
  formatMode,
  getCaddySiteAddress,
  getCaddySiteBlocks,
  hasAuthDirective,
  isPublicAddress,
  objectContainsSecrets,
} from '../cli/commands/security.js';

describe('security helpers', () => {
  test('classifyPermissionSeverity flags world-readable files as critical', () => {
    expect(classifyPermissionSeverity(0o644, true)).toBe('critical');
  });

  test('classifyPermissionSeverity flags group-readable secret files as critical', () => {
    expect(classifyPermissionSeverity(0o640, true)).toBe('critical');
  });

  test('classifyPermissionSeverity flags group-readable non-secret files as warn', () => {
    expect(classifyPermissionSeverity(0o640, false)).toBe('warn');
  });

  test('classifyPermissionSeverity accepts owner-only files', () => {
    expect(classifyPermissionSeverity(0o600, true)).toBeNull();
  });

  test('formatMode prints zero-prefixed octal', () => {
    expect(formatMode(0o100644)).toBe('0644');
  });

  test('objectContainsSecrets detects nested secret keys', () => {
    expect(objectContainsSecrets({ orgs: { coco: { agent_token: 'secret' } } })).toBe(true);
  });

  test('objectContainsSecrets ignores non-secret objects', () => {
    expect(objectContainsSecrets({ owner: { chat_id: '123' }, enabled: true })).toBe(false);
  });

  test('hasAuthDirective detects Caddy auth directives', () => {
    expect(hasAuthDirective('example.com {\n  basic_auth /console/* {\n    admin hash\n  }\n}')).toBe(true);
    expect(hasAuthDirective('example.com {\n  reverse_proxy localhost:3456\n}')).toBe(false);
  });

  test('getCaddySiteAddress returns the first site label', () => {
    expect(getCaddySiteAddress('# comment\nexample.com {\n  respond \"ok\"\n}')).toBe('example.com');
  });

  test('getCaddySiteAddress ignores snippets and returns the first real site label', () => {
    const caddyfile = '(shared) {\n  header X-Test 1\n}\n\nexample.com {\n  import shared\n}';
    expect(getCaddySiteAddress(caddyfile)).toBe('example.com');
  });

  test('findSiteBlockForPath returns the matching site block instead of unrelated auth blocks', () => {
    const caddyfile = 'admin.example.com {\n  basic_auth {\n    admin hash\n  }\n}\n\nexample.com {\n  handle /console/* {\n    reverse_proxy localhost:3456\n  }\n}';
    expect(findSiteBlockForPath(caddyfile, '/console')?.address).toBe('example.com');
  });

  test('checkWebConsoleExposure still flags unauthenticated console when auth exists on another site', () => {
    const caddyfile = 'admin.example.com {\n  basic_auth {\n    admin hash\n  }\n}\n\nexample.com {\n  handle /console/* {\n    reverse_proxy localhost:3456\n  }\n}';
    expect(checkWebConsoleExposure(caddyfile)).toEqual([
      expect.objectContaining({ id: 'web-console:auth', severity: 'critical' }),
    ]);
  });

  test('getCaddySiteBlocks collects only actual site blocks', () => {
    const caddyfile = '{\n  debug\n}\n\n(shared) {\n  encode gzip\n}\n\nexample.com {\n  import shared\n}\n\nlocalhost {\n  respond \"ok\"\n}';
    expect(getCaddySiteBlocks(caddyfile).map((block) => block.address)).toEqual(['example.com', 'localhost']);
  });

  test('isPublicAddress distinguishes local and public hosts', () => {
    expect(isPublicAddress('example.com')).toBe(true);
    expect(isPublicAddress(':80')).toBe(true);
    expect(isPublicAddress('0.0.0.0')).toBe(true);
    expect(isPublicAddress('localhost')).toBe(false);
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('192.168.1.10')).toBe(false);
  });
});
