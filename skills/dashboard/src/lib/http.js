import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function sendText(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        req.resume();
        return;
      }
      if (!overflow) chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflow) {
        const err = new Error('payload_too_large');
        err.status = 413;
        reject(err);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('invalid_json');
        err.status = 400;
        reject(err);
      }
    });

    req.on('error', (err) => reject(err));
  });
}

export function serveStatic(req, res, rootDir) {
  let pathname;
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { error: 'invalid_request' });
    return true;
  }
  const assetPath = pathname.startsWith('/_assets/') ? pathname.slice('/_assets/'.length) : null;
  const relative = assetPath || (pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const vendorPrefix = 'vendor/';
  const baseDir = relative.startsWith(vendorPrefix)
    ? path.resolve(rootDir, '..', 'node_modules', 'chart.js', 'dist')
    : rootDir;
  const localRelative = relative.startsWith(vendorPrefix) ? relative.slice(vendorPrefix.length) : relative;
  const candidate = path.resolve(baseDir, localRelative);

  if (candidate !== baseDir && !candidate.startsWith(`${baseDir}${path.sep}`)) {
    sendText(res, 403, 'forbidden');
    return true;
  }

  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return false;
  }

  const filePath = stat.isDirectory() ? path.join(candidate, 'index.html') : candidate;
  try {
    const fileStat = fs.statSync(filePath);
    if (!fileStat.isFile()) return false;
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60'
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}
