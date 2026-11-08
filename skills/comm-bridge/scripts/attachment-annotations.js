import path from 'node:path';

const ATTACHMENT_RE = /^\[attachment:(image|file) (.+) name="([^"]*)" ([^\]]+)\]$/;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function sanitizeDisplayName(name, fallback = 'attachment') {
  const base = path.basename(String(name || fallback)).replace(/[\r\n\t"]/g, '_').trim();
  const safe = base.replace(/[/\\<>|*?\x00-\x1f"]/g, '_').replace(/\s+/g, ' ');
  return (safe || fallback).slice(0, 160);
}

export function buildAttachmentAnnotation(attachment) {
  const kind = attachment.kind === 'image' ? 'image' : 'file';
  const filePath = String(attachment.path || '');
  const name = sanitizeDisplayName(attachment.name);
  return `[attachment:${kind} ${filePath} name="${name}" ${formatBytes(attachment.size)}]`;
}

export function buildAnnotatedContent(message, attachments = []) {
  const text = String(message || '').trim();
  const annotations = attachments.map(buildAttachmentAnnotation);
  if (annotations.length === 0) return text;
  if (!text) return annotations.join('\n');
  return `${text}\n${annotations.join('\n')}`;
}

export function parseAttachmentAnnotation(line) {
  const match = String(line || '').match(ATTACHMENT_RE);
  if (!match) return null;
  const filePath = match[2].trim();
  if (!path.isAbsolute(filePath)) return null;
  return {
    kind: match[1],
    path: filePath,
    name: sanitizeDisplayName(match[3], 'attachment'),
    sizeLabel: match[4]
  };
}

export function splitContentAndAttachments(content) {
  const lines = String(content || '').split('\n');
  const bodyLines = [];
  const attachments = [];

  for (const line of lines) {
    const attachment = parseAttachmentAnnotation(line);
    if (attachment) {
      attachments.push(attachment);
    } else {
      bodyLines.push(line);
    }
  }

  return {
    content: bodyLines.join('\n').trim(),
    attachments
  };
}
