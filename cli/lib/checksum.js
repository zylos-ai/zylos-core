/**
 * Checksum utilities for file-delivered component installs.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Validate a sha256 hex digest string (64 hex characters).
 */
export function isValidSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Compute the sha256 hex digest of a file.
 *
 * @param {string} filePath
 * @returns {string} Lowercase hex digest
 */
export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
