import { Transform } from 'node:stream';
import { MIMEType } from 'node:util';
import multer from 'multer';

const invalid = () => Object.assign(new Error('invalid_chat_upload'), { code: 'invalid_chat_upload', statusCode: 400 });
const tooLarge = () => Object.assign(new Error('chat_upload_too_large'), { code: 'chat_upload_too_large', statusCode: 413 });

// Inspect only the MIME envelope; Multer decodes and streams the payload.
// Body scanning retains at most a delimiter plus its two-byte suffix.
function envelopeGuard(boundary, maximum) {
  const first = Buffer.from(`--${boundary}\r\n`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  let pending = Buffer.alloc(0), state = 'first', size = 0, parts = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        size += chunk.length;
        if (size > maximum) throw tooLarge();
        pending = Buffer.concat([pending, chunk]);
        while (state !== 'done') {
          if (state === 'first') {
            if (pending.length < first.length) break;
            if (!pending.subarray(0, first.length).equals(first)) throw invalid();
            pending = pending.subarray(first.length);
            state = 'headers';
          } else if (state === 'headers') {
            const end = pending.indexOf('\r\n\r\n');
            if (end < 0) {
              if (pending.length > 8195) throw invalid();
              break;
            }
            if (end > 8192 || ++parts > 9) throw invalid();
            const headers = pending.subarray(0, end).toString('utf8').split('\r\n');
            if (headers.length > 16 || headers.some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/.test(line))) throw invalid();
            let dispositions = 0;
            for (const line of headers) {
              if (!/^content-disposition:/i.test(line)) continue;
              const disposition = new MIMEType(`x/${line.slice(line.indexOf(':') + 1).trim()}`);
              if (++dispositions > 1 || disposition.essence !== 'x/form-data' || disposition.params.get('name') === null) throw invalid();
              for (const key of ['name', 'filename']) {
                const value = disposition.params.get(key);
                if (value !== null && Buffer.byteLength(value) > 255) throw invalid();
              }
            }
            if (dispositions !== 1) throw invalid();
            pending = pending.subarray(end + 4);
            state = 'body';
          } else {
            const next = pending.indexOf(separator);
            if (next < 0) {
              pending = pending.subarray(Math.max(0, pending.length - separator.length - 1));
              break;
            }
            if (pending.length < next + separator.length + 2) {
              pending = pending.subarray(next);
              break;
            }
            const suffix = pending.subarray(next + separator.length, next + separator.length + 2).toString();
            pending = pending.subarray(next + separator.length + 2);
            if (suffix === '--') state = 'done';
            else if (suffix === '\r\n') state = 'headers';
            else throw invalid();
          }
        }
        if (state === 'done') pending = Buffer.alloc(0);
        callback(null, chunk);
      } catch (error) { callback(error.statusCode ? error : invalid()); }
    },
    flush(callback) { callback(state === 'done' ? null : invalid()); },
  });
}

/** Stream one bounded file; writeFile must commit only after its stream ends. */
export async function receiveMultipartFile(req, { maxBytes, writeFile, authorize }) {
  let mime;
  try { mime = new MIMEType(req.headers['content-type'] || ''); } catch { throw invalid(); }
  const boundary = mime.params.get('boundary');
  if (mime.essence !== 'multipart/form-data' || !boundary || boundary.length > 70
      || /[^0-9A-Za-z'()+_,\-./:=? ]/.test(boundary) || boundary.endsWith(' ')) throw invalid();
  if (Number(req.headers['content-length']) > maxBytes + 65536) throw tooLarge();
  const guard = envelopeGuard(boundary, maxBytes + 65536);
  let resolveEnvelope, rejectEnvelope, result, writing, parser, middlewareDone = false;
  const envelope = new Promise((resolve, reject) => { resolveEnvelope = resolve; rejectEnvelope = reject; });
  envelope.catch(() => {});
  const normalize = error => error.statusCode ? error : error.code === 'LIMIT_FILE_SIZE' ? tooLarge() : invalid();
  const abort = error => {
    const failure = normalize(error);
    rejectEnvelope(failure);
    req.unpipe(guard);
    guard.unpipe();
    guard.destroy();
    if (parser && !parser.destroyed && !middlewareDone) parser.destroy(failure);
    req.resume();
  };
  const onAbort = () => abort(invalid());
  req.once('aborted', onAbort);
  guard.once('error', abort);
  const storage = {
    _handleFile(request, file, callback) {
      file.stream.once('limit', () => rejectEnvelope(tooLarge()));
      async function* validatedFile() {
        yield* file.stream;
        await envelope;
        if (req.aborted) throw invalid();
        await authorize();
      }
      writing = Promise.resolve().then(() => writeFile({ name: file.originalname, mime: file.mimetype, stream: validatedFile() }));
      writing.then(record => { result = record; callback(null, {}); }, error => { abort(error); callback(normalize(error)); });
    },
    _removeFile(request, file, callback) { callback(null); },
  };
  const middleware = multer({ storage, preservePath: true, defParamCharset: 'utf8',
    fileFilter(request, file, callback) {
      const error = Buffer.byteLength(file.fieldname) > 255 || Buffer.byteLength(file.originalname) > 255 ? invalid() : null;
      if (error) abort(error);
      callback(error, !error);
    },
    limits: { files: 1, fields: 8, parts: 9, fileSize: maxBytes, fieldSize: 1025, fieldNameSize: 255 },
    streamHandler(request, busboy) {
      parser = busboy;
      busboy.once('error', error => rejectEnvelope(normalize(error)));
      for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) busboy.once(event, () => rejectEnvelope(invalid()));
      // Text fields are accepted but unused. Validate them without Multer's
      // bracket-path object expansion, which can allocate huge sparse arrays.
      busboy.removeAllListeners('field');
      busboy.on('field', (name, value, info) => {
        if (typeof name !== 'string' || typeof value !== 'string' || info.nameTruncated || info.valueTruncated
            || Buffer.byteLength(name) > 255 || Buffer.byteLength(value) > 1024) abort(invalid());
      });
      busboy.once('close', resolveEnvelope);
      request.pipe(guard).pipe(busboy);
    },
  }).single('file');
  try {
    await new Promise((resolve, reject) => middleware(req, {}, error => {
      middlewareDone = true;
      if (error) { rejectEnvelope(normalize(error)); reject(normalize(error)); } else resolve();
    }));
    if (!result) throw invalid();
    return result;
  } finally {
    // Multer can report a disconnected request before the storage callback.
    // Wait for the writer's cleanup before returning control to the route.
    rejectEnvelope(invalid());
    await writing?.catch(() => {});
    req.removeListener('aborted', onAbort);
    guard.destroy();
  }
}
