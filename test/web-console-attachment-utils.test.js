import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  UploadRegistry,
  assertAttachmentContentFitsC4,
  buildAnnotatedContent,
  buildAttachmentAnnotation,
  classifyConversationMessage,
  contentDisposition,
  formatBytes,
  parseAttachmentAnnotation,
  parseMediaContent,
  resolveAllowedPathSync,
  sanitizeDisplayName,
  sniffImage,
  splitContentAndAttachments
} from '../skills/web-console/scripts/attachment-utils.js';

let tempRoot;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-attachment-test-'));
});

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('web-console attachment annotations', () => {
  test('sanitizes display names and formats byte sizes', () => {
    expect(sanitizeDisplayName('../bad\r\n"name".png')).toBe('bad___name_.png');
    expect(formatBytes(42)).toBe('42B');
    expect(formatBytes(1536)).toBe('1.5KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0MB');
  });

  test('builds and parses annotation lines with absolute paths', () => {
    const filePath = path.join(tempRoot, 'wc-test.png');
    const line = buildAttachmentAnnotation({
      kind: 'image',
      path: filePath,
      name: 'screen shot.png',
      size: 1536
    });

    expect(line).toBe(`[attachment:image ${filePath} name="screen shot.png" 1.5KB]`);
    expect(parseAttachmentAnnotation(line)).toEqual({
      kind: 'image',
      path: filePath,
      name: 'screen shot.png',
      sizeLabel: '1.5KB'
    });
    expect(parseAttachmentAnnotation('[attachment:file relative.txt name="x" 1B]')).toBeNull();
  });

  test('builds attachment-only and text-plus-attachment content', () => {
    const filePath = path.join(tempRoot, 'report.pdf');
    const attachment = { kind: 'file', path: filePath, name: 'report.pdf', size: 2048 };

    expect(buildAnnotatedContent('', [attachment])).toBe(
      `[attachment:file ${filePath} name="report.pdf" 2.0KB]`
    );
    expect(buildAnnotatedContent('please inspect', [attachment])).toBe(
      `please inspect\n[attachment:file ${filePath} name="report.pdf" 2.0KB]`
    );
  });

  test('splits annotated content for history rendering', () => {
    const filePath = path.join(tempRoot, 'image.png');
    const parsed = splitContentAndAttachments(
      `hello\n[attachment:image ${filePath} name="image.png" 3B]`
    );

    expect(parsed.content).toBe('hello');
    expect(parsed.attachments).toEqual([{
      kind: 'image',
      path: filePath,
      name: 'image.png',
      sizeLabel: '3B'
    }]);
  });

  test('enforces the 2KB pre-c4-receive guard for attachment content', () => {
    const scriptDir = path.join(tempRoot, 'comm-bridge', 'scripts');
    const short = assertAttachmentContentFitsC4('short message', {
      c4ReceiveScriptDir: scriptDir,
      threshold: 2048
    });

    expect(short.bytes).toBeLessThan(2048);
    expect(() => assertAttachmentContentFitsC4('x'.repeat(2048), {
      c4ReceiveScriptDir: scriptDir,
      threshold: 2048
    })).toThrow(/too long/i);
  });
});

describe('web-console outbound media classification', () => {
  test('matches exact media rows only', () => {
    const imagePath = path.join(tempRoot, 'image.png');
    fs.writeFileSync(imagePath, 'x');

    expect(parseMediaContent(`[MEDIA:image]${imagePath}`)).toEqual({
      media_type: 'image',
      path: imagePath,
      name: 'image.png'
    });
    expect(parseMediaContent(`hello [MEDIA:image]${imagePath}`)).toBeNull();
    expect(parseMediaContent(`[MEDIA:image]relative.png`)).toBeNull();
    expect(parseMediaContent(`[MEDIA:audio]${imagePath}`)).toBeNull();
    expect(parseMediaContent(`[MEDIA:file]${imagePath}\nextra`)).toBeNull();
  });

  test('classifies only outbound web-console console rows as media', () => {
    const mediaPath = path.join(tempRoot, 'file.txt');
    fs.writeFileSync(mediaPath, 'hello');
    const row = {
      id: 7,
      direction: 'out',
      channel: 'web-console',
      endpoint_id: 'console',
      content: `[MEDIA:file]${mediaPath}`,
      timestamp: '2026-06-12T00:00:00'
    };

    expect(classifyConversationMessage(row)).toMatchObject({
      id: 7,
      kind: 'media',
      media_type: 'file',
      message_id: 7,
      name: 'file.txt',
      size: 5
    });
    expect(classifyConversationMessage({ ...row, direction: 'in' }).kind).toBeUndefined();
    expect(classifyConversationMessage({ ...row, endpoint_id: 'other' }).kind).toBeUndefined();
  });
});

describe('web-console media serving safety helpers', () => {
  test('uses realpath containment for allowed files', () => {
    const allowed = path.join(tempRoot, 'allowed');
    fs.mkdirSync(allowed);
    const filePath = path.join(allowed, 'ok.txt');
    fs.writeFileSync(filePath, 'ok');

    expect(resolveAllowedPathSync(filePath, [allowed])).toBe(fs.realpathSync(filePath));
  });

  test('rejects symlink escape and broken symlinks', () => {
    const allowed = path.join(tempRoot, 'allowed');
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'secret');

    const escapingLink = path.join(allowed, 'link.txt');
    fs.symlinkSync(secret, escapingLink);
    expect(resolveAllowedPathSync(escapingLink, [allowed])).toBeNull();

    const brokenLink = path.join(allowed, 'broken.txt');
    fs.symlinkSync(path.join(outside, 'missing.txt'), brokenLink);
    expect(resolveAllowedPathSync(brokenLink, [allowed])).toBeNull();
  });

  test('handles allowlist roots that are symlinks by canonical path', () => {
    const realRoot = path.join(tempRoot, 'real-root');
    const linkedRoot = path.join(tempRoot, 'linked-root');
    fs.mkdirSync(realRoot);
    fs.symlinkSync(realRoot, linkedRoot);
    const filePath = path.join(realRoot, 'ok.txt');
    fs.writeFileSync(filePath, 'ok');

    expect(resolveAllowedPathSync(filePath, [linkedRoot])).toBe(fs.realpathSync(filePath));
  });

  test('sniffs image magic bytes and uses attachment headers for unknown bytes', () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({
      mime: 'image/png',
      extension: '.png'
    });
    expect(sniffImage(Buffer.from('MZ executable'))).toBeNull();
    expect(contentDisposition('attachment', 'bad"name.exe')).toBe('attachment; filename="bad_name.exe"');
  });
});

describe('UploadRegistry', () => {
  test('is session-scoped, single-use, duplicate-safe, and expires entries', () => {
    let now = 1000;
    const registry = new UploadRegistry({ ttlMs: 100, now: () => now });
    const entry = registry.add({ sessionId: 's1', path: '/tmp/a.txt' });

    expect(registry.getMany([entry.id], 's2')).toEqual([]);
    expect(registry.getMany([entry.id, entry.id], 's1')).toEqual([]);
    expect(registry.consumeMany([entry.id], 's1')).toEqual([expect.objectContaining({ path: '/tmp/a.txt' })]);
    expect(registry.consumeMany([entry.id], 's1')).toBeNull();

    const expiring = registry.add({ sessionId: 's1', path: '/tmp/b.txt' });
    now = 1200;
    expect(registry.consumeMany([expiring.id], 's1')).toBeNull();
  });

  test('restores consumed entries with their original id and expiry', () => {
    let now = 1000;
    const registry = new UploadRegistry({ ttlMs: 100, now: () => now });
    const entry = registry.add({ sessionId: 's1', path: '/tmp/a.txt' });
    const consumed = registry.consumeMany([entry.id], 's1');

    expect(registry.consumeMany([entry.id], 's1')).toBeNull();
    registry.restoreMany(consumed);
    expect(registry.getMany([entry.id], 's1')).toEqual([expect.objectContaining({
      id: entry.id,
      path: '/tmp/a.txt',
      expiresAt: 1100
    })]);

    now = 1200;
    expect(registry.consumeMany([entry.id], 's1')).toBeNull();
  });
});
