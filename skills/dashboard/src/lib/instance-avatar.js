import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { sendJson } from './http.js';

const MAX_AVATAR_BYTES = 512 * 1024;
const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp'
};
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export function avatarFileInfo(filename) {
  const match = typeof filename === 'string' && /^avatar-([a-f0-9]{64})\.(png|jpg|webp)$/.exec(filename);
  return match ? { version: match[1], type: IMAGE_TYPES[match[2]] } : null;
}

function matchesImageType(bytes, extension) {
  switch (extension) {
    case 'png':
      return bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('latin1', 12, 16) === 'IHDR';
    case 'jpg':
      return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'webp':
      return bytes.length >= 16 && bytes.toString('latin1', 0, 4) === 'RIFF' &&
        bytes.toString('latin1', 8, 12) === 'WEBP' &&
        ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16));
    default:
      return false;
  }
}

async function readAvatarBody(req) {
  if (Number(req.headers['content-length']) > MAX_AVATAR_BYTES) return null;
  const chunks = [];
  let size = 0;
  // Keep the response socket open so an oversized chunked upload gets a 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_AVATAR_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function writeAvatarFile(dataDir, filename, bytes) {
  const temporary = path.join(dataDir, `.avatar-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path.join(dataDir, filename));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function handleInstanceAvatar(req, res, { dataDir, avatar, saveAvatar }) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const image = avatarFileInfo(avatar);
    if (!image) {
      sendJson(res, 404, { error: 'avatar_not_found' });
      return;
    }
    let bytes;
    try {
      bytes = await readFile(path.join(dataDir, avatar));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      sendJson(res, 404, { error: 'avatar_not_found' });
      return;
    }
    res.writeHead(200, {
      'content-type': image.type,
      'content-length': bytes.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return;
  }

  if (req.method !== 'PUT') {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const type = req.headers['content-type']?.trim().toLowerCase();
  const extension = Object.keys(IMAGE_TYPES).find(key => IMAGE_TYPES[key] === type);
  if (!extension) {
    sendJson(res, 415, { error: 'unsupported_image_type' });
    return;
  }
  const bytes = await readAvatarBody(req);
  if (!bytes) {
    sendJson(res, 413, { error: 'payload_too_large' });
    return;
  }
  if (!matchesImageType(bytes, extension)) {
    sendJson(res, 400, { error: 'invalid_image' });
    return;
  }

  const version = createHash('sha256').update(bytes).digest('hex');
  const filename = `avatar-${version}.${extension}`;
  // Publish the config pointer only after the complete image is available.
  // A failed config write leaves the previous image readable.
  await writeAvatarFile(dataDir, filename, bytes);
  await saveAvatar(filename);
  sendJson(res, 200, { ok: true, avatar_version: version });
}
