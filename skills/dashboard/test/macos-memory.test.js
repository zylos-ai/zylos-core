import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { parseVmStatFreeMem } from '../src/lib/collectors/system-collector.js';

const SAMPLE_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              226121.
Pages active:                            290781.
Pages inactive:                          263526.
Pages speculative:                        26878.
Pages throttled:                              0.
Pages wired down:                        140024.
Pages purgeable:                          20256.
File-backed pages:                       290874.
Anonymous pages:                         290311.`;

test('parseVmStatFreeMem — parses page size and sums free + speculative + inactive + purgeable', () => {
  const result = parseVmStatFreeMem(SAMPLE_VM_STAT);
  const pageSize = 16384;
  const expected = (226121 + 26878 + 263526 + 20256) * pageSize;
  assert.equal(result, expected);
});

test('parseVmStatFreeMem — handles 4096 page size', () => {
  const small = SAMPLE_VM_STAT.replace('16384', '4096');
  const result = parseVmStatFreeMem(small);
  const expected = (226121 + 26878 + 263526 + 20256) * 4096;
  assert.equal(result, expected);
});

test('parseVmStatFreeMem — missing fields return 0 for those fields', () => {
  const partial = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              100.
Pages active:                            200.`;
  const result = parseVmStatFreeMem(partial);
  assert.equal(result, 100 * 16384);
});

test('parseVmStatFreeMem — defaults to 16384 page size if not found', () => {
  const noPageSize = `Some weird header
Pages free:                              10.
Pages inactive:                          20.`;
  const result = parseVmStatFreeMem(noPageSize);
  assert.equal(result, (10 + 20) * 16384);
});
