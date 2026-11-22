import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { ClaudeHistory } from '../../skills/dashboard/src/lib/history/claude-history.js';
import { HistoryService } from '../../skills/dashboard/src/lib/history/history-service.js';
import { sendHtml, serveStatic } from '../../skills/dashboard/src/lib/http.js';

const { port, home, zylosDir } = workerData;
const service = new HistoryService({ config: { zylosDir }, parser: new ClaudeHistory({ homeDir: home, zylosDir }) });
const assets = path.resolve(fileURLToPath(new URL('../../skills/dashboard/public/', import.meta.url)));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.apiPath = url.pathname;
  if (url.pathname.startsWith('/api/observer/history/')) return service.handle(req, res, url);
  if (url.pathname === '/fixture') return sendHtml(res, 200, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/themes/light.css"><link rel="stylesheet" href="/themes/dark.css"></head><body><main id="observer-history"></main><script type="module">
    import { ObserverHistory } from '/js/observer-history.js';
    const params = new URLSearchParams(location.search);
    const lang = params.get('lang') === 'zh' ? 'zh' : 'en';
    document.documentElement.lang = lang;
    document.documentElement.dataset.theme = params.get('theme');
    const labels = await (await fetch('/i18n/' + lang + '.json')).json();
    new ObserverHistory({ root: document.querySelector('main'), endpoint: path => path, t: key => labels[key] ?? key }).setActive(true);
  </script></body></html>`);
  if (!serveStatic(req, res, assets)) { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => parentPort.postMessage(server.address().port));
parentPort.on('message', () => {
  server.closeAllConnections();
  server.close(async () => { await service.close(); parentPort.close(); });
});
