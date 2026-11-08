import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseDotenv } from 'dotenv';
import { sanitizeDisplayName } from '../../comm-bridge/scripts/attachment-annotations.js';

export const MAX_ATTACHMENTS = 20;
const DEFAULT_UPLOAD_BYTES = 20 * 1024 * 1024;

export function resolveUploadRoot(env = process.env) {
  return fs.realpathSync(env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos'));
}

export function readUploadLimit(zylosDir) {
  try {
    const root = fs.realpathSync(zylosDir);
    const value = parseDotenv(fs.readFileSync(path.join(root, '.env'), 'utf8')).WEB_CONSOLE_MAX_UPLOAD_MB;
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return DEFAULT_UPLOAD_BYTES;
    const bytes = Number(value) * 1024 * 1024;
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : DEFAULT_UPLOAD_BYTES;
  } catch {
    return DEFAULT_UPLOAD_BYTES;
  }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function sanitizedExtension(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!ext || ext.length > 16) return '';
  return /^[.][a-z0-9_-]+$/.test(ext) ? ext : '';
}

export function uploadKind(file) {
  if (file?.mimetype?.startsWith('image/')) return 'image';
  if (IMAGE_EXTENSIONS.has(sanitizedExtension(file?.originalname || file?.name))) return 'image';
  return 'file';
}

export function resolveAllowedPathSync(targetPath, allowlistRoots) {
  let realTarget;
  try {
    realTarget = fs.realpathSync(targetPath);
  } catch {
    return null;
  }

  for (const root of allowlistRoots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)) {
      return realTarget;
    }
  }
  return null;
}

export function sniffImage(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47
      && buffer[4] === 0x0d
      && buffer[5] === 0x0a
      && buffer[6] === 0x1a
      && buffer[7] === 0x0a) {
    return { mime: 'image/png', extension: '.png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extension: '.jpg' };
  }
  const header = buffer.subarray(0, 6).toString('ascii');
  if (header === 'GIF87a' || header === 'GIF89a') {
    return { mime: 'image/gif', extension: '.gif' };
  }
  if (buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', extension: '.webp' };
  }
  return null;
}

export function contentDisposition(disposition, filename) {
  const safe = sanitizeDisplayName(filename, 'download').replace(/[\\"]/g, '_').toWellFormed();
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
