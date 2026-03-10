import { describe, test, expect } from '@jest/globals';
import { isLocalAddress } from '../cli/commands/init.js';

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
