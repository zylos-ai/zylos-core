import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadTray } from '../public/js/wb/chat-upload-tray.js';

class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
  count() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0); }
}
class Upload extends Events {
  upload = new Events();
  open(method, url) { this.method = method; this.url = url; }
  send(body) { this.body = body; }
  abort() { this.aborted = true; this.emit('abort'); }
  reply(status = 200, data = {}) { this.status = status; this.responseText = JSON.stringify(data); this.emit('load'); }
}
const file = (name = 'image.png', type = 'image/png', size = 4) => new File([new Uint8Array(size)], name, { type });
const scope = (conversationId = 'a', instance = 'local') => ({ instance, conversationId, uploadsUrl: `/instance/${instance}/api/chat/conversations/${conversationId}/uploads` });
function fixture(options = {}) {
  let clock = 1000, nextTimer = 0;
  const uploads = [], revoked = [], created = [], changes = [], calls = [], unauthorized = [], timers = new Map();
  const controller = createUploadTray({
    fetch: async (path, init) => { calls.push({ path, init }); return { ok: true, status: 200, json: async () => ({ maxUploadBytes: 10, maxAttachments: 20 }) }; },
    createXHR: () => { const xhr = new Upload(); uploads.push(xhr); return xhr; },
    createFormData: () => ({ entries: [], append(...entry) { this.entries.push(entry); } }),
    url: { createObjectURL(blob) { const value = 'blob:local-' + created.length; created.push({ blob, value }); return value; }, revokeObjectURL(value) { revoked.push(value); } },
    now: () => clock, onChange: value => changes.push(value), onUnauthorized: value => unauthorized.push(value),
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, ...options
  });
  function ready(index = 0, extra = {}) { uploads[index].reply(200, { id: 'attachment-' + index, name: 'image.png', size: 4, mime: 'image/png', kind: 'image', ...extra }); }
  async function advance(amount) {
    clock += amount;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    await Promise.resolve(); await Promise.resolve();
  }
  return { controller, uploads, revoked, created, changes, calls, unauthorized, timers, ready, advance };
}

test('upload configuration is authoritative and each request carries one multipart file with local preview only', async () => {
  const f = fixture(); await f.controller.setScope(scope());
  const source = file(), accepted = await f.controller.acceptFiles([source]);
  assert.equal(accepted.accepted.length, 1); assert.equal(f.calls[0].path, scope().uploadsUrl + '/config');
  assert.equal(f.uploads[0].method, 'POST'); assert.equal(f.uploads[0].url, scope().uploadsUrl);
  assert.deepEqual(f.uploads[0].body.entries, [['file', source, 'image.png']]);
  assert.equal(f.controller.snapshot().items[0].previewUrl, 'blob:local-0');
  assert.equal(f.created[0].blob, source); assert.equal(f.controller.snapshot().items[0].file, undefined);
  assert.equal(f.controller.isSendable('text'), false);
  f.uploads[0].upload.emit('progress', { lengthComputable: true, loaded: 4, total: 8 });
  assert.equal(f.controller.snapshot().items[0].progress, 50);
  f.ready(); assert.deepEqual(f.controller.readyIDs(), ['attachment-0']); assert.equal(f.controller.isSendable(), true);
  assert.equal(f.uploads[0].count() + f.uploads[0].upload.count(), 0); f.controller.destroy();
  assert.deepEqual(f.revoked, ['blob:local-0']); assert.equal(f.timers.size, 0);
});
test('server size and count limits reject oversized files and never queue a twenty-first upload', async () => {
  const f = fixture(); await f.controller.setScope(scope());
  const tooLarge = await f.controller.acceptFiles([file('huge.png', 'image/png', 11)]);
  assert.equal(tooLarge.rejected[0].error, 'chat_attachment_too_large'); assert.equal(f.uploads.length, 0);
  const result = await f.controller.acceptFiles(Array.from({ length: 21 }, () => file()));
  assert.equal(result.accepted.length, 20); assert.equal(result.rejected[0].error, 'chat_attachment_too_many');
  assert.equal(f.uploads.length, 20); f.controller.destroy(); assert.ok(f.uploads.every(xhr => xhr.aborted));
});
test('a smaller configured attachment limit is used without adding a total byte limit', async () => {
  const f = fixture({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ maxUploadBytes: 4, maxAttachments: 2 }) }) });
  await f.controller.setScope(scope());
  const result = await f.controller.acceptFiles([file(), file(), file()]);
  assert.equal(result.accepted.length, 2); assert.equal(f.uploads.length, 2); f.controller.destroy();
});
test('failed and expired uploads stay visible while text or other ready attachments may be sent', async () => {
  const f = fixture(); await f.controller.setScope(scope()); await f.controller.acceptFiles([file(), file(), file()]);
  f.uploads[0].reply(413, { error: 'chat_attachment_too_large' }); f.ready(1); f.ready(2, { expiresAt: 1000 });
  assert.deepEqual(f.controller.snapshot().items.map(item => item.status), ['failed', 'ready', 'expired']);
  assert.equal(f.controller.snapshot().items[0].error, 'chat_attachment_too_large');
  assert.deepEqual(f.controller.readyIDs(), ['attachment-1']); assert.equal(f.controller.isSendable(), true);
  f.controller.completeStored(f.controller.capture());
  assert.deepEqual(f.controller.snapshot().items.map(item => item.status), ['failed', 'expired']);
  assert.equal(f.controller.isSendable(), false); assert.equal(f.controller.isSendable('text'), true); f.controller.destroy();
});
test('upload start gives a conservative expiry when HTTP success omits expiresAt', async () => {
  const f = fixture(); await f.controller.setScope(scope()); await f.controller.acceptFiles([file()]);
  await f.advance(10000); f.ready();
  assert.equal(f.controller.snapshot().items[0].expiresAt, 1000 + 25 * 60 * 1000);
  await f.advance(25 * 60 * 1000 - 10000);
  assert.equal(f.controller.snapshot().items[0].status, 'expired'); assert.deepEqual(f.controller.readyIDs(), []);
  assert.equal(f.controller.isSendable(), false); assert.equal(f.timers.size, 0); f.controller.destroy();
});
test('explicit retry reuses the selected file and never retries an interrupted upload automatically', async () => {
  const f = fixture(); await f.controller.setScope(scope()); await f.controller.acceptFiles([file()]);
  const localId = f.controller.snapshot().items[0].localId;
  f.uploads[0].emit('error'); assert.equal(f.controller.snapshot().items[0].error, 'chat_upload_unknown');
  assert.equal(f.uploads.length, 1); assert.equal(f.controller.retry(localId), true); assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[1].body.entries[0][1], f.uploads[0].body.entries[0][1]);
  f.ready(1); assert.equal(f.controller.snapshot().items[0].revision, 2); assert.equal(f.controller.retry(localId), false);
  f.controller.destroy();
});
test('removal aborts transport, detaches listeners and revokes only the removed preview', async () => {
  const f = fixture(); await f.controller.setScope(scope()); await f.controller.acceptFiles([file(), file()]);
  const removed = f.controller.snapshot().items[0].localId; assert.equal(f.controller.remove(removed), true);
  assert.equal(f.uploads[0].aborted, true); assert.equal(f.uploads[0].count() + f.uploads[0].upload.count(), 0);
  assert.deepEqual(f.revoked, ['blob:local-0']); f.ready(0);
  assert.equal(f.controller.snapshot().items.length, 1); assert.equal(f.controller.snapshot().items[0].status, 'uploading');
  f.controller.destroy(); assert.equal(f.uploads[1].aborted, true); assert.equal(f.revoked.length, 2);
});
test('instance and local conversation isolate pending files and captured send cleanup', async () => {
  const f = fixture(); await f.controller.setScope(scope()); await f.controller.acceptFiles([file()]); f.ready();
  const captured = f.controller.capture();
  await f.controller.setScope(scope('b')); await f.controller.acceptFiles([file()]); f.ready(1);
  f.controller.completeStored(captured);
  assert.deepEqual(f.controller.readyIDs(), ['attachment-1']);
  await f.controller.setScope(scope('a', 'remote')); assert.equal(f.controller.snapshot().items.length, 0);
  await f.controller.setScope(scope()); assert.equal(f.controller.snapshot().items.length, 0);
  await f.controller.setScope(scope('b')); assert.deepEqual(f.controller.readyIDs(), ['attachment-1']);
  assert.equal(f.uploads[1].url, scope('b').uploadsUrl); f.controller.destroy();
});
test('stored send removes only captured unchanged ready items and preserves additions and retry revisions', async () => {
  const f = fixture(); await f.controller.setScope(scope()); await f.controller.acceptFiles([file()]); f.ready();
  const captured = f.controller.capture(); await f.controller.acceptFiles([file()]); f.ready(1);
  f.controller.completeStored(captured); assert.deepEqual(f.controller.readyIDs(), ['attachment-1']);
  const retryCapture = f.controller.capture(), localId = f.controller.snapshot().items[0].localId;
  await f.advance(25 * 60 * 1000); f.controller.retry(localId); f.ready(2, { id: 'attachment-1' });
  f.controller.completeStored(retryCapture); assert.deepEqual(f.controller.readyIDs(), ['attachment-1']); f.controller.destroy();
});
test('canonical group promotion moves retained failed items within the same instance only', async () => {
  const f = fixture(); await f.controller.setScope(scope('draft')); await f.controller.acceptFiles([file()]);
  assert.equal(f.controller.moveScope(scope('draft'), scope('group')), false);
  f.uploads[0].emit('timeout'); assert.equal(f.controller.moveScope(scope('draft'), scope('group', 'remote')), false);
  assert.equal(f.controller.moveScope(scope('draft'), scope('group')), true);
  assert.equal(f.controller.snapshot().scope.conversationId, 'group');
  const localId = f.controller.snapshot().items[0].localId; f.controller.retry(localId);
  assert.equal(f.uploads[1].url, scope('group').uploadsUrl); f.controller.destroy();
});
test('canonical promotion replaces an empty target tray and aborts its pending configuration', async () => {
  let targetResolve, targetSignal;
  const f = fixture({ fetch: (path, init) => {
    if (path === scope('group').uploadsUrl + '/config') {
      targetSignal = init.signal; return new Promise(resolve => { targetResolve = resolve; });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ maxUploadBytes: 10, maxAttachments: 20 }) });
  } });
  await f.controller.setScope(scope('draft')); await f.controller.acceptFiles([file()]); f.uploads[0].emit('error');
  const pendingTarget = f.controller.setScope(scope('group')); assert.equal(f.timers.size, 1);
  const changes = f.changes.length;
  assert.equal(f.controller.moveScope(scope('draft'), scope('group')), true);
  assert.equal(targetSignal.aborted, true); assert.equal(f.timers.size, 0);
  assert.equal(f.changes.length, changes + 1);
  assert.equal(f.controller.snapshot().scope.conversationId, 'group');
  assert.equal(f.controller.snapshot().items[0].status, 'failed');
  targetResolve({ ok: true, status: 200, json: async () => ({ maxUploadBytes: 99, maxAttachments: 1 }) }); await pendingTarget;
  assert.equal(f.controller.snapshot().config.maxUploadBytes, 10);
  assert.equal(f.changes.length, changes + 1); assert.equal(f.timers.size, 0); f.controller.destroy();
});
test('upload unauthorized clears all trays for that instance and invokes authentication cleanup', async () => {
  const f = fixture(); await f.controller.setScope(scope('a', 'remote')); await f.controller.acceptFiles([file()]);
  await f.controller.setScope(scope('b', 'remote')); await f.controller.acceptFiles([file()]);
  await f.controller.setScope(scope('a', 'local')); await f.controller.acceptFiles([file()]);
  f.uploads[0].reply(401); assert.equal(f.unauthorized.length, 1); assert.equal(f.unauthorized[0].instance, 'remote');
  assert.equal(f.uploads[1].aborted, true); assert.equal(f.controller.snapshot().items.length, 1);
  await f.controller.setScope(scope('a', 'remote')); assert.equal(f.controller.snapshot().items.length, 0); f.controller.destroy();
});
test('unauthorized configuration cannot replay itself through an authentication redraw', async () => {
  let reads = 0, controller;
  const f = fixture({ fetch: async () => { reads += 1; assert.ok(reads <= 1, 'redraw must not replay a denied configuration read'); return { ok: false, status: 401 }; },
    onChange: () => { void controller.setScope(scope()); },
    onUnauthorized: () => { void controller.setScope(scope()); } });
  controller = f.controller;
  await controller.setScope(scope());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1); assert.equal(controller.snapshot().configStatus, 'failed');
  assert.equal(controller.snapshot().items.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.timers.size, 0);
  await controller.setScope(scope()); assert.equal(reads, 1); controller.destroy();
});
test('authentication cleanup before a wrapped configuration response prevents a redraw retry loop', async () => {
  let reads = 0, controller;
  const f = fixture({ fetch: async () => {
    reads += 1; assert.ok(reads <= 1, 'the wrapper clears before the denied response is observed');
    await Promise.resolve(); controller.clearForAuthentication({ instance: 'local' });
    return { ok: false, status: 401 };
  }, onChange: () => { void controller.setScope(scope()); } });
  controller = f.controller;
  await controller.setScope(scope()); await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1); assert.equal(controller.snapshot().configStatus, 'failed');
  assert.equal(controller.snapshot().items.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.timers.size, 0);
  controller.destroy();
});
test('invalid configuration prevents upload and can be explicitly retried without guessed limits', async () => {
  let reads = 0;
  const f = fixture({ fetch: async () => ({ ok: true, status: 200, json: async () => ++reads === 1
    ? { maxUploadBytes: Infinity, maxAttachments: 20 } : { maxUploadBytes: 5, maxAttachments: 1 } }) });
  await f.controller.setScope(scope()); assert.equal(f.controller.snapshot().configStatus, 'failed'); assert.equal(f.uploads.length, 0);
  await f.controller.setScope(scope()); assert.equal(reads, 1, 'rendering the same failed scope must not trigger a retry loop');
  await f.controller.acceptFiles([file()]); assert.equal(f.uploads.length, 1); assert.equal(reads, 2); f.controller.destroy();
});
test('configuration failure is quiet on page entry and actionable after a file selection', async () => {
  const f = fixture({ fetch: async () => { throw Error('unavailable'); } });
  await f.controller.setScope(scope());
  assert.equal(f.controller.snapshot().configStatus, 'failed'); assert.equal(f.controller.snapshot().error, null);
  const result = await f.controller.acceptFiles([file()]);
  assert.equal(result.error, 'chat_upload_config_failed');
  assert.equal(f.controller.snapshot().error, 'chat_upload_config_failed');
  assert.equal(f.controller.snapshot().items.length, 0); assert.equal(f.uploads.length, 0);
  await f.controller.setScope(scope()); assert.equal(f.controller.snapshot().error, 'chat_upload_config_failed');
  f.controller.destroy();
});
test('unchanged scope selection is silent after config loads and refresh never restores File objects', async () => {
  const f = fixture(); await f.controller.setScope(scope()); const count = f.changes.length;
  await f.controller.setScope(scope()); assert.equal(f.changes.length, count); assert.equal(f.calls.length, 1);
  await f.controller.acceptFiles([file()]); f.ready(); f.controller.destroy();
  const refreshed = fixture(); await refreshed.controller.setScope(scope()); assert.equal(refreshed.controller.snapshot().items.length, 0);
  refreshed.controller.destroy();
});
test('repeated empty scope and no-op cleanup stay silent for page redraws', async () => {
  const f = fixture(); await f.controller.setScope(null); f.controller.clear();
  assert.equal(f.changes.length, 0);
  await f.controller.setScope(scope()); await f.controller.acceptFiles([file()]);
  await f.controller.setScope(null); const hiddenCount = f.changes.length;
  await f.controller.setScope(null); assert.equal(f.changes.length, hiddenCount);
  f.controller.clear({ instance: 'other' }); assert.equal(f.changes.length, hiddenCount);
  f.controller.clear(); const clearedCount = f.changes.length;
  f.controller.clear(); await f.controller.setScope(null); assert.equal(f.changes.length, clearedCount);
  assert.equal(f.uploads[0].aborted, true); f.controller.destroy();
});
test('destroy aborts configuration and ignores late completion without creating uploads', async () => {
  let resolveRead, signal;
  const f = fixture({ fetch: (_path, init) => { signal = init.signal; return new Promise(resolve => { resolveRead = resolve; }); } });
  const pending = f.controller.setScope(scope()); f.controller.destroy(); assert.equal(signal.aborted, true);
  assert.equal(f.timers.size, 0, 'destroy releases the timeout before any late response settles');
  resolveRead({ ok: true, status: 200, json: async () => ({ maxUploadBytes: 10, maxAttachments: 20 }) }); await pending;
  assert.equal(f.controller.snapshot().items.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.timers.size, 0);
});
