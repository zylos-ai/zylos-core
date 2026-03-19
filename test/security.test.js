import { describe, expect, test } from '@jest/globals';
import {
  classifyPermissionSeverity,
  formatMode,
  getCaddySiteAddress,
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

  test('isPublicAddress distinguishes local and public hosts', () => {
    expect(isPublicAddress('example.com')).toBe(true);
    expect(isPublicAddress(':80')).toBe(true);
    expect(isPublicAddress('0.0.0.0')).toBe(true);
    expect(isPublicAddress('localhost')).toBe(false);
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('192.168.1.10')).toBe(false);
  });
});
