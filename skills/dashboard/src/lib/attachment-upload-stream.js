import { Transform } from 'node:stream';
import { MIMEType } from 'node:util';

const failure = (code, status = 400) => Object.assign(new Error(code), { status });

// Validate the envelope while forwarding its original bytes. Retain only one
// bounded header or a delimiter tail, never the file or complete request.
export function attachmentUploadStream(contentType, maxBytes) {
  let mime;
  try { mime = new MIMEType(contentType || ''); } catch { throw failure('invalid_chat_upload'); }
  const boundary = mime.params.get('boundary');
  if (mime.essence !== 'multipart/form-data' || !boundary || boundary.length > 70 ||
      /[^0-9A-Za-z'()+_,\-./:=? ]/.test(boundary) || boundary.endsWith(' ')) throw failure('invalid_chat_upload');
  const first = Buffer.from(`--${boundary}\r\n`), delimiter = Buffer.from(`\r\n--${boundary}`);
  let pending = Buffer.alloc(0), state = 'first', total = 0, files = 0, fields = 0, partBytes = 0, file = false;
  const count = size => {
    partBytes += size;
    if (partBytes > (file ? maxBytes : 1024)) throw failure(file ? 'chat_upload_too_large' : 'invalid_chat_upload', file ? 413 : 400);
  };
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        total += chunk.length;
        if (total > maxBytes + 65536) throw failure('chat_upload_too_large', 413);
        pending = Buffer.concat([pending, chunk]);
        while (state !== 'done') {
          if (state === 'first') {
            if (pending.length < first.length) break;
            if (!pending.subarray(0, first.length).equals(first)) throw failure('invalid_chat_upload');
            pending = pending.subarray(first.length); state = 'headers';
          } else if (state === 'headers') {
            const end = pending.indexOf('\r\n\r\n');
            if (end < 0) { if (pending.length > 8195) throw failure('invalid_chat_upload'); break; }
            if (end > 8192) throw failure('invalid_chat_upload');
            const headers = pending.subarray(0, end).toString('utf8').split('\r\n');
            if (headers.length > 16 || headers.some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/.test(line))) throw failure('invalid_chat_upload');
            const dispositions = headers.filter(line => /^content-disposition:/i.test(line));
            if (dispositions.length !== 1) throw failure('invalid_chat_upload');
            const disposition = new MIMEType(`x/${dispositions[0].slice(dispositions[0].indexOf(':') + 1).trim()}`);
            const name = disposition.params.get('name'), filename = disposition.params.get('filename');
            if (disposition.essence !== 'x/form-data' || name === null || Buffer.byteLength(name) > 255 ||
                (filename !== null && Buffer.byteLength(filename) > 255)) throw failure('invalid_chat_upload');
            file = filename !== null;
            if (file ? name !== 'file' || ++files > 1 : ++fields > 8) throw failure('invalid_chat_upload');
            partBytes = 0; pending = pending.subarray(end + 4); state = 'body';
          } else {
            const next = pending.indexOf(delimiter);
            if (next < 0) {
              const safe = Math.max(0, pending.length - delimiter.length - 1);
              count(safe); pending = pending.subarray(safe); break;
            }
            if (pending.length < next + delimiter.length + 2) {
              count(next); pending = pending.subarray(next); break;
            }
            count(next);
            const suffix = pending.subarray(next + delimiter.length, next + delimiter.length + 2).toString();
            pending = pending.subarray(next + delimiter.length + 2);
            if (suffix === '--') state = 'done';
            else if (suffix === '\r\n') state = 'headers';
            else throw failure('invalid_chat_upload');
          }
        }
        if (state === 'done') pending = Buffer.alloc(0);
        callback(null, chunk);
      } catch (error) { callback(error.status ? error : failure('invalid_chat_upload')); }
    },
    flush(callback) { callback(state === 'done' && files === 1 ? null : failure('invalid_chat_upload')); },
  });
}
