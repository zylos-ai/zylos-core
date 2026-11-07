import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MIMEType } from 'node:util';
import { requireChatAccess, requireChatWrite } from './access.js';
import { sendJson } from '../http.js';
import { sniffImage, contentDisposition } from '../../../../web-console/scripts/attachment-utils.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
export const attachmentPrincipal = context => context && `${context.kind}:${context.principalId}`;

function checkPartHeaders(body, boundary) {
  const first = Buffer.from(`--${boundary}\r\n`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  if (!body.subarray(0, first.length).equals(first)) throw fail('invalid_chat_upload');
  let start = first.length;
  let parts = 0;
  while (true) {
    if (++parts > 9) throw fail('invalid_chat_upload');
    const end = body.indexOf('\r\n\r\n', start);
    if (end < 0 || end - start > 8192) throw fail('invalid_chat_upload');
    const headers = body.subarray(start, end).toString('utf8').split('\r\n');
    if (headers.length > 16 || headers.some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/.test(line))) throw fail('invalid_chat_upload');
    for (const line of headers) {
      if (!/^content-disposition:/i.test(line)) continue;
      let disposition;
      try { disposition = new MIMEType(`x/${line.slice(line.indexOf(':') + 1).trim()}`); }
      catch { throw fail('invalid_chat_upload'); }
      for (const key of ['name', 'filename']) {
        const value = disposition.params.get(key);
        if (value !== null && Buffer.byteLength(value) > 255) throw fail('invalid_chat_upload');
      }
    }
    let next = end + 4;
    while (true) {
      next = body.indexOf(separator, next);
      if (next < 0) throw fail('invalid_chat_upload');
      const after = next + separator.length;
      if (body[after] === 45 && body[after + 1] === 45) return;
      if (body[after] === 13 && body[after + 1] === 10) { start = after + 2; break; }
      next = after;
    }
  }
}

async function uploadFile(req, maxBytes) {
  let mime;
  try { mime = new MIMEType(req.headers['content-type'] || ''); }
  catch { throw fail('invalid_chat_upload'); }
  const boundary = mime.params.get('boundary');
  if (mime.essence !== 'multipart/form-data' || !boundary || boundary.length > 70 || /[^0-9A-Za-z'()+_,\-./:=? ]/.test(boundary) || boundary.endsWith(' ')) throw fail('invalid_chat_upload');
  const maximum = maxBytes + 65536;
  if (req.headers['content-length'] && Number(req.headers['content-length']) > maximum) throw fail('chat_upload_too_large', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw fail('chat_upload_too_large', 413);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, size);
  // The standard parser decodes field/file bodies. Preflight only the bounded
  // MIME envelope because FormData does not expose per-part header limits.
  checkPartHeaders(body, boundary);
  let form;
  try {
    form = await new Request('http://localhost/upload', { method: 'POST',
      headers: { 'content-type': req.headers['content-type'] },
      body }).formData();
  } catch (error) {
    if (error.code === 'chat_upload_too_large') throw error;
    throw fail('invalid_chat_upload');
  }
  let file, fields = 0;
  for (const [name, value] of form) {
    if (Buffer.byteLength(name) > 255) throw fail('invalid_chat_upload');
    if (typeof value === 'string') {
      if (++fields > 8 || Buffer.byteLength(value) > 1024) throw fail('invalid_chat_upload');
    } else {
      if (file || name !== 'file' || Buffer.byteLength(value.name) > 255) throw fail('invalid_chat_upload');
      file = value;
    }
  }
  if (!file) throw fail('invalid_chat_upload');
  if (file.size > maxBytes) throw fail('chat_upload_too_large', 413);
  return file;
}

/** Local data-instance endpoints; fleet streaming is owned by the proxy. */
export async function handleChatAttachments(req, res, url, { auth, config, sender, attachments, readMode }) {
  const match = /^\/api\/chat\/conversations\/([^/]+)\/(uploads(?:\/config)?|attachments\/([^/]+))$/.exec(url.pathname);
  if (!match) return false;
  const denied = requireChatAccess(req, auth, config);
  if (denied) { const { status, ...body } = denied; sendJson(res, status, body); return true; }
  try {
    const upload = match[2] === 'uploads';
    if (req.method !== (upload ? 'POST' : 'GET')) { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
    if ([...url.searchParams].length) throw fail('invalid_chat_parameters');
    let id, attachmentId;
    try { id = decodeURIComponent(match[1]); attachmentId = match[3] && decodeURIComponent(match[3]); }
    catch { throw fail('invalid_chat_conversation'); }
    const conversation = await sender.resolve(id);
    const checkWrite = () => requireChatWrite(req, auth, config, {
      mode: readMode(), conversation, namespace: conversation.namespace, localId: conversation.localId,
      draft: conversation.namespace === null && conversation.state !== 'active',
    });
    if (upload || match[2] === 'uploads/config') {
      const writeDenied = checkWrite();
      if (writeDenied) { const { status, ...body } = writeDenied; sendJson(res, status, body); return true; }
      if (!upload) { sendJson(res, 200, attachments.config()); return true; }
      await sender.prepareAttachmentConversation(conversation, { authorize: checkWrite });
      const watermark = attachments.captureWatermark();
      const file = await uploadFile(req, attachments.config().maxUploadBytes);
      const lateDenied = checkWrite();
      if (lateDenied) { const { status, ...body } = lateDenied; sendJson(res, status, body); return true; }
      const record = await attachments.prepareUser(conversation, { name: file.name, mime: file.type,
        stream: Readable.fromWeb(file.stream()), principal: attachmentPrincipal(req._authContext), watermark });
      sendJson(res, 201, { id: record.id, name: record.name, size: record.size, mime: record.mime, kind: record.kind });
      return true;
    }
    const record = attachments.download(conversation.localId, attachmentId);
    const file = await fs.promises.open(record.path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== record.size) throw fail('chat_attachment_unavailable', 404);
      const header = Buffer.alloc(12);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const image = sniffImage(header.subarray(0, bytesRead));
      const currentDenied = requireChatAccess(req, auth, config);
      if (currentDenied) { const { status, ...body } = currentDenied; sendJson(res, status, body); return true; }
      res.writeHead(200, { 'content-type': image?.mime || 'application/octet-stream',
        'content-length': stat.size, 'content-disposition': contentDisposition(image ? 'inline' : 'attachment', record.name),
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      await pipeline(file.createReadStream({ start: 0, autoClose: false }), res);
    } finally { await file.close(); }
  } catch (error) {
    if (res.headersSent) res.destroy();
    else sendJson(res, error.statusCode || 502, { error: error.code || 'chat_attachment_unavailable' });
  }
  return true;
}
