import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createChatApiFixture, questionContent } from './chat-integration-api.js';
import { AuthGate } from '../../src/lib/auth.js';
import { ChatAttachments } from '../../src/lib/chat/attachments.js';
import { handleChatAttachments } from '../../src/lib/chat/attachment-routes.js';
import { sendHtml, sendJson } from '../../src/lib/http.js';
import { evaluateBeforeSend } from '../../scripts/send-hook.js';
import { acceptDelivery } from '../../src/lib/chat/channel.js';

// Deterministic valid PNG fixtures; dimensions exercise reserved media layout.
export function fixturePng(width = 720, height = 240) {
  const crc = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3); for (let i = 1; i < row.length; i += 3) { row[i] = 99; row[i + 1] = 102; row[i + 2] = 241; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

// A new private helper adds the existing attachment backend to the general
// real-API fixture. Neither production resources nor shared fixture behavior
// changes. Its original sender/history gain their normal attachment dependency.
export async function createAttachmentApiFixture(t, sandbox, { prototypeSource } = {}) {
  let attachments, mediaAuth, fixture, fallbackEnvelope;
  fixture = await createChatApiFixture(t, sandbox, { name: 'Attachments review', attachmentService: false, async extraHandler(req, res, url, f) {
    if (attachments && await handleChatAttachments(req, res, url, { auth: mediaAuth, config: f.config,
      sender: f.sender, attachments, readMode: f.readMode })) return true;
    if (url.pathname === '/attachment-fallback' && fallbackEnvelope) {
      sendHtml(res, 200, `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:15px/1.6 system-ui;margin:24px;background:#f4f7f8;color:#17222e}body.dark{background:#11191e;color:#e6edf2}main{max-width:900px;margin:auto}.chat-message-content{padding:20px;border:1px solid #86939d;border-radius:12px;margin:16px 0}.chat-block{margin:16px 0}h1{font-size:22px}</style><main><h1>无附件渲染器：保留可读内容</h1><div id="fallback"></div></main><script type="module">
      import {renderChatContent} from '/_assets/js/wb/chat-blocks.js';
      const root=document.querySelector('#fallback'),envelope=${JSON.stringify(fallbackEnvelope)};
      root.append(renderChatContent({document,row:{id:1,content:'[C4-JSON]\\n'+JSON.stringify(envelope)},supportsBlock:block=>!block.type.startsWith('x-zylos.'),showTechnicalDetails:false}));
      document.body.className=new URL(location).searchParams.get('theme')||'';root.dataset.ready='true';
      </script></html>`); return true;
    }
    if (url.pathname === '/approved-prototype.html' && prototypeSource) { sendHtml(res, 200, prototypeSource); return true; }
    if (url.pathname.startsWith('/api/chat/') || !url.pathname.startsWith('/api/')) return false;
    if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return true; }
    const values = { '/api/session-mode': { data: { sessionMode: f.readMode() } },
      '/api/state': { state: 'idle', runtime: 'claude', session_mode: f.readMode(), agent: { id: 'test', name: '隔离浏览器' }, runtime_info: {} },
      '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' }, '/api/communication': {}, '/api/summary': {},
      '/api/timeline': { items: [] }, '/api/instance-status': { status: 'ok' }, '/api/actions/meta': { actions: [] },
      '/api/settings': { active: 'claude', runtimes: { claude: { modelPrices: {}, builtInModels: [], fastMode: {} }, codex: { modelPrices: {}, builtInModels: [], priorityModelPrices: {}, builtInPriorityModels: [] } } },
      '/api/workbench/pricing': { models: [] }, '/api/workbench/runtime-overrides': { runtime: [], runtimeTotal: 0, nextAfter: null } };
    sendJson(res, 200, values[url.pathname] || {}); return true;
  } });
  sandbox.assertIsolation();
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.env'), 'DASHBOARD_MAX_UPLOAD_MB=1\n');
  attachments = new ChatAttachments({ store: fixture.store, c4Reader: fixture.reader, zylosDir: sandbox.paths.zylos });
  mediaAuth = new AuthGate(fixture.config, fixture.store);
  fixture.sender.attachments = attachments; fixture.history.attachments = attachments;
  sandbox.addCleanup(async () => { clearInterval(mediaAuth._cleanupTimer); await attachments.close(); });
  async function register(localId, name, kind = 'file', bytes = Buffer.from('隔离评估报告\n')) {
    const directory = path.join(sandbox.paths.zylos, 'workspace'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name); fs.writeFileSync(file, bytes);
    return attachments.register(localId, { kind, path: file });
  }
  function addAgent(localId, envelope) {
    sandbox.assertIsolation();
    const content = questionContent(envelope);
    const hook = evaluateBeforeSend({ version: 1, hook_event_name: 'BeforeSend', hook_id: 'dashboard.content',
      request_id: crypto.randomUUID(), invocation_id: crypto.randomUUID(), request: { channel: 'dashboard', endpoint: localId, content,
        options: { groupName: localId } }, context: {} }, { env: sandbox.env });
    assert.equal(hook.decision, 'continue', hook.message);
    const row = fixture.c4.insertConversation('out', 'dashboard', localId, content, { groupName: localId });
    acceptDelivery({ version: 1, c4_id: row.id, channel: row.channel, endpoint_id: row.endpoint_id, session_group: row.session_group, content }, { env: sandbox.env });
    return row;
  }
  const upload = async (conversation, name, bytes = Buffer.from('隔离用户文档\n'), type = 'text/plain') => {
    const body = new FormData(); body.append('file', new Blob([bytes], { type }), name);
    const response = await fetch(fixture.base + conversation.route + '/uploads', { method: 'POST', body,
      headers: { cookie: `__Secure-zylos_dashboard_session=${fixture.cookie}`, origin: fixture.base }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 201); return response.json();
  };
  return { ...fixture, attachments, register, addAgent, upload, setFallbackEnvelope(value) { fallbackEnvelope = value; } };
}
