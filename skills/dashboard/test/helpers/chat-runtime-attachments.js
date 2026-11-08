import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChatSandbox } from './chat-integration-harness.js';
import { createRemoteChatApiFixture } from './chat-integration-api.js';
import { waitForTtlRunEnding } from './chat-runtime-support.js';
import { parseC4Content } from '../../../comm-bridge/scripts/c4-content-schema.js';
import { splitContentAndAttachments } from '../../../web-console/scripts/attachment-utils.js';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64');

// This runs inside the proven native driver, whose parent owns the private
// socket and bounded process. A fleet gateway gets a separate AuthGate process.
export async function runRuntimeAttachments({ api, sandbox, root, scenario, configuration, saveConfig,
  scenes, coreDb, check, wait }) {
  const fleet = scenario.endsWith('-fleet');
  const runtime = fleet ? 'codex' : 'claude';
  configuration.runtime = runtime;
  saveConfig();
  let gateway, gatewaySandbox;
  try {
    if (fleet) {
      const enabled = await api.request('/api/chat/settings', { method: 'PUT', body: { allowRemote: true } });
      check(enabled.status === 200, 'Target explicitly permits remote chat');
      gatewaySandbox = createChatSandbox(null);
      gateway = await createRemoteChatApiFixture(null, gatewaySandbox, { timeoutMs: 620000 });
      await gateway.setProxy({ base: api.base, tokens: api.tokens });
    }
    const client = gateway || api;
    const prefix = fleet ? '/fleet/Remote' : '';
    const raw = async (route, { method = 'GET', body, headers = {} } = {}) => {
      sandbox.assertIsolation();
      if (gatewaySandbox) gatewaySandbox.assertIsolation();
      return fetch(client.base + prefix + route, { method, body,
        headers: { cookie: `__Secure-zylos_dashboard_session=${client.cookie}`, origin: client.base, ...headers },
        signal: AbortSignal.timeout(45000) });
    };
    const json = async (route, method, body) => {
      const response = await raw(route, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
      const result = await response.json();
      check(response.ok, `Native attachment HTTP ${method} ${route}: ${response.status}`);
      return result;
    };
    const draft = (await json('/api/chat/drafts', 'POST', { displayName: `${runtime} attachment chain` })).conversation;
    let route = `/api/chat/conversations/${encodeURIComponent(draft.id)}`;
    const contents = [png, Buffer.from(`private native ${runtime} attachment ${crypto.randomUUID()}\n`)];
    const uploads = [];
    for (const [index, bytes] of contents.entries()) {
      const data = new FormData();
      data.append('file', new Blob([bytes], { type: index === 0 ? 'image/png' : 'text/plain' }), index === 0 ? 'native.png' : 'native.txt');
      const response = await raw(route + '/uploads', { method: 'POST', body: data });
      check(response.status === 201, 'User upload stored on target through selected local/fleet route');
      uploads.push(await response.json());
    }
    const outbound = group => api.db.prepare("SELECT id,content,endpoint_id,session_group FROM conversations WHERE session_group=? AND direction='out' ORDER BY id").all(group);
    let current, oldIdentity, freshIdentity, ttlEnding, endingIdentity, originalTrigger;
    const replyIds = new Set();
    const triggers = [];
    const originalPaths = uploads.map(upload => api.attachments.resolve(draft.localId, upload.id));
    for (const phase of ['original', 'fresh']) {
      const content = `FIXTURE_ATTACHMENT_READ:${draft.localId}:${phase}`;
      const body = phase === 'original'
        ? { content, attachments: uploads.map(item => item.id) }
        : { content: `${content}\nRead the original attachment annotations from C4 history with node .claude/skills/comm-bridge/scripts/c4-fetch.js --begin ${originalTrigger.id} --end ${originalTrigger.id}. Use the two absolute paths in that historical row; this new message has no attachments.` };
      const sent = await json(route + '/send', 'POST', body);
      check(sent.stored === true, 'Attachment send is authoritatively committed');
      check(typeof sent.conversationId === 'string' && sent.conversationId.startsWith('g:'), 'Committed send returns the canonical conversation ID');
      const trigger = api.db.prepare("SELECT id,content FROM conversations WHERE id=? AND direction='in'").get(sent.messageId);
      check(Boolean(trigger), 'The committed native trigger exists in private C4 history');
      const annotationCount = splitContentAndAttachments(trigger.content).attachments.length;
      check(annotationCount === (phase === 'original' ? uploads.length : 0), 'Only the original native trigger carries attachment annotations');
      triggers.push({ phase, id: trigger.id, attachmentAnnotations: annotationCount });
      if (phase === 'original') originalTrigger = trigger;
      route = `/api/chat/conversations/${encodeURIComponent(sent.conversationId)}`;
      current = api.conversations.get(draft.localId);
      coreDb.setSessionRuntimeConfig({ sessionGroup: current.sessionGroup, runtime });
      const expected = `FIXTURE_ATTACHMENT_ACK:${phase}:${digest(contents[0])}:${digest(contents[1])}`;
      const observedFile = path.join(root, 'workspace', `fixture-attachment-observed-${phase}.json`);
      const row = await wait(() => fs.existsSync(observedFile) && outbound(current.sessionGroup).find(item => parseC4Content(item.content).envelope?.fallbackText === expected),
        `${runtime} native ${phase} annotated-file read and register reply`, 180000);
      const observed = JSON.parse(fs.readFileSync(observedFile, 'utf8'));
      check(observed.phase === phase && observed.endpoint === draft.localId, 'Model helper observed the requested original/fresh read');
      check(observed.paths.length === originalPaths.length && observed.paths.every((value, index) => value === originalPaths[index]), 'Native helper read the original historical upload paths, not reply copies');
      check(observed.hashes.length === contents.length && observed.hashes.every((value, index) => value === digest(contents[index])), 'Native helper observed the original historical bytes');
      const parsed = parseC4Content(row.content);
      check(parsed.kind === 'envelope', 'Native tool emitted a valid structured envelope');
      const blocks = parsed.envelope.blocks;
      check(blocks.map(block => block.type).join(',') === 'markdown,x-zylos.image,markdown,x-zylos.file', 'Image and file are interleaved in the same envelope');
      const media = blocks.filter(block => block.type.startsWith('x-zylos.'));
      for (const [index, block] of media.entries()) {
        const saved = api.store.db.prepare('SELECT source,local_id,storage_name FROM chat_attachments WHERE id=?').get(block.data.attachmentId);
        check(saved?.source === 'agent' && saved.local_id === draft.localId, 'Real target CLI registered the reply copy in the original group');
        check(fs.readFileSync(path.join(root, 'components/dashboard/media', saved.storage_name)).equals(contents[index]), 'Registered target copy contains the actual annotated input bytes');
      }
      replyIds.add(row.id);
      // Historical read repairs any deliberately absent per-process delivery
      // callback, then authorized routes independently verify persisted copies.
      const historyResponse = await raw(route + '/messages?tab=mine');
      check(historyResponse.status === 200, 'History refresh succeeds through local/fleet authorization');
      const history = await historyResponse.json();
      check(history.items.some(item => item.id === row.id), 'Native reply is visible in refreshed target history');
      for (const [index, block] of media.entries()) {
        const download = await raw(route + `/attachments/${encodeURIComponent(block.data.attachmentId)}`);
        check(download.status === 200, 'Registered reply is downloadable through the authorized route');
        check(Buffer.from(await download.arrayBuffer()).equals(contents[index]), 'Authorized download is byte-identical');
      }
      if (phase === 'original') {
        oldIdentity = await scenes.readIdentity(current.sessionGroup);
        check(oldIdentity.ready && oldIdentity.runtime === runtime, 'Original native runtime reached READY');
        ttlEnding = await waitForTtlRunEnding(coreDb, current.sessionGroup, oldIdentity.runId);
        endingIdentity = await scenes.readIdentity(current.sessionGroup);
        check(ttlEnding.reason === 'ttl' && !endingIdentity.present, 'Supervisor completed the actual native TTL ending');
        // Existing timestamps create the thirty-minute condition without any
        // production clock, scheduler setting or test-only product switch.
        api.store.db.prepare('UPDATE chat_attachments SET created_at=created_at-?,next_check_at=next_check_at-?').run(31 * 60000, 31 * 60000);
        await api.attachments.gc();
        for (const [index, upload] of uploads.entries()) {
          const download = await raw(route + `/attachments/${encodeURIComponent(upload.id)}`);
          check(download.status === 200, 'Linked historical upload survives thirty minutes and TTL');
          check(Buffer.from(await download.arrayBuffer()).equals(contents[index]), 'Historical upload remains byte-identical before fresh runtime');
        }
      } else {
        freshIdentity = await scenes.readIdentity(current.sessionGroup);
        check(freshIdentity.ready && freshIdentity.runtime === runtime && freshIdentity.runId !== oldIdentity.runId, 'A fresh native session read the original historical upload');
      }
    }
    if (gateway) check((await gateway.snapshot()).upstream > 0, 'Second instance used the real FleetProxy');
    return { runtime, fleet, attachmentReplies: replyIds.size, attachmentReplyIds: [...replyIds], triggers,
      originalRunId: oldIdentity.runId, freshRunId: freshIdentity.runId, ttlEndingRunId: ttlEnding.runId,
      ttlEndingReason: ttlEnding.reason,
      reclaimed: ttlEnding.runId === oldIdentity.runId && ttlEnding.reason === 'ttl' && !endingIdentity.present
        && freshIdentity.runId !== oldIdentity.runId };
  } finally {
    if (gatewaySandbox) await gatewaySandbox.close();
  }
}
