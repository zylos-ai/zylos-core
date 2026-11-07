import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requireChatAccess, requireChatWrite } from './access.js';
import { sendJson } from '../http.js';
import { sniffImage, contentDisposition } from '../../../../web-console/scripts/attachment-utils.js';
import { receiveMultipartFile } from '../../../../web-console/scripts/multipart-upload.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
export const attachmentPrincipal = context => context && `${context.kind}:${context.principalId}`;

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
      const record = await receiveMultipartFile(req, {
        maxBytes: attachments.config().maxUploadBytes,
        authorize() {
          const denied = checkWrite();
          if (denied) throw fail(denied.error, denied.status);
        },
        writeFile: file => attachments.prepareUser(conversation, { ...file,
          principal: attachmentPrincipal(req._authContext), watermark }),
      });
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
      let lastAccessCheck = Date.now();
      const accessGuard = new Transform({ transform(chunk, encoding, callback) {
        try {
          const now = Date.now();
          if (now - lastAccessCheck >= 1000) {
            const denied = requireChatAccess(req, auth, config);
            if (denied) { callback(fail(denied.error, denied.status)); return; }
            lastAccessCheck = now;
          }
          callback(null, chunk);
        } catch (error) { callback(error); }
      } });
      await pipeline(file.createReadStream({ start: 0, autoClose: false }), accessGuard, res);
    } finally { await file.close(); }
  } catch (error) {
    if (res.headersSent) res.destroy();
    else sendJson(res, error.statusCode || 502, { error: error.code || 'chat_attachment_unavailable' });
  }
  return true;
}
