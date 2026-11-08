import { element } from './plain-text.js?v=94';

const displayName = name => String(name || '').split(/[/\\]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 160);
const sizeLabel = value => !Number.isFinite(value) || value < 0 ? '' : value < 1024 ? `${value} B`
  : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;

/** Only history metadata authorizes a same-conversation browser route. */
export function chatAttachmentURL(attachment, { conversationId, endpoint = path => path, external = false } = {}) {
  if (external || attachment?.external || attachment?.available !== true || typeof attachment.id !== 'string'
    || !attachment.id || typeof conversationId !== 'string' || !conversationId) return null;
  const url = endpoint(`/api/chat/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachment.id)}`);
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !/[\r\n\\]/.test(url) ? url : null;
}

/** Hide transport annotations, never parse their paths into browser authority. */
export function attachmentDisplayText(content, { external = false, t = key => key } = {}) {
  const lines = String(content || '').split('\n');
  const body = lines.filter(line => !/^\[attachment:(?:image|file) .+ name="(?:\\.|[^"\\])*" [^\]]+\]\r?$/.test(line))
    .map(line => /^\[attachment:(?:image|file) /.test(line) ? t('chat.attachment.unavailable')
      : external && /^\[MEDIA:[^\r\n]*$/.test(line) ? t('chat.attachment.externalMedia') : line).join('\n');
  return lines.length !== body.split('\n').length ? body.trim() : body;
}

/** One visual component for user, agent and local File/Blob upload previews. */
export function createChatAttachment({ document, attachment = {}, t = key => key, context = {}, localUrl = null,
  mode = 'history', onRemove, onRetry } = {}) {
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const kind = attachment.kind === 'image' ? 'image' : 'file';
  const name = displayName(attachment.name) || t('chat.attachment.' + kind);
  const root = node('figure', undefined, `chat-attachment chat-attachment-${kind}`);
  root.dataset.attachmentKind = kind;
  const info = node('figcaption', undefined, 'chat-attachment-info');
  const nameNode = node('span', name, 'chat-attachment-name'); nameNode.title = name;
  info.append(nameNode);
  const details = sizeLabel(attachment.size) || attachment.sizeLabel;
  if (details) info.append(node('span', details, 'chat-attachment-meta'));
  const status = node('p', '', 'chat-attachment-status'); status.setAttribute('role', 'status');
  const actions = node('div', undefined, 'chat-attachment-actions');
  const url = mode === 'history' ? chatAttachmentURL(attachment, context) : null;
  const previewUrl = mode === 'tray' && typeof localUrl === 'string' && localUrl.startsWith('blob:') ? localUrl : url;
  const external = context.external || attachment.external;
  const fetcher = context.fetch || globalThis.fetch;
  const browserURL = document.defaultView?.URL || globalThis.URL;
  let destroyed = false, mounted = false, request = null, saveUrl = null, revokeTimer = null;
  let image = null, frame = null, imageRetry = null, downloading = false;
  const layout = change => {
    if (destroyed) return;
    if (context.onLayout) context.onLayout(change);
    else change();
  };
  const setStatus = key => { root.dataset.attachmentState = key || 'ready'; status.textContent = key ? t('chat.attachment.' + key) : ''; status.hidden = !key; };
  const imageStatus = key => {
    const transfer = mode === 'tray' ? attachment.status : null;
    setStatus(['failed', 'expired', 'unknown', 'uploading', 'queued'].includes(transfer) ? transfer === 'queued' ? 'uploading' : transfer : key);
  };
  function button(key, action, handler) {
    const control = node('button', t('chat.attachment.' + key), 'action-btn');
    control.type = 'button'; control.dataset.action = action;
    control.addEventListener('click', () => { if (!destroyed && !control.disabled) handler(); });
    actions.append(control); return control;
  }
  function releaseDownload() {
    if (revokeTimer !== null) { globalThis.clearTimeout(revokeTimer); revokeTimer = null; }
    if (saveUrl) { browserURL.revokeObjectURL(saveUrl); saveUrl = null; }
  }
  let download;
  async function downloadFile() {
    if (!url || downloading || destroyed) return;
    downloading = true; download.disabled = true;
    layout(() => setStatus('downloading'));
    const controller = new AbortController(); request = controller;
    try {
      const response = await fetcher(url, { signal: controller.signal });
      if (!response.ok) throw new Error('attachment_download_failed');
      const blob = await response.blob();
      if (Number.isFinite(attachment.size) && blob.size !== attachment.size) throw new Error('attachment_download_incomplete');
      if (destroyed || controller.signal.aborted) return;
      releaseDownload(); saveUrl = browserURL.createObjectURL(blob);
      const anchor = node('a'); anchor.href = saveUrl; anchor.download = name; anchor.hidden = true;
      root.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
      revokeTimer = globalThis.setTimeout(releaseDownload, 1000);
      layout(() => setStatus(null));
    } catch {
      if (!destroyed && !controller.signal.aborted) layout(() => setStatus('downloadFailed'));
    } finally {
      if (request === controller) request = null;
      downloading = false;
      if (!destroyed) download.disabled = false;
    }
  }
  function loadImage() {
    if (!image || destroyed) return;
    layout(() => {
      image.hidden = false; imageRetry.hidden = true;
      frame.dataset.state = 'loading';
      imageStatus('loading');
      // Assigning the source again is an explicit user retry, never a timer loop.
      image.src = previewUrl;
    });
  }
  if (kind === 'image' && previewUrl) {
    frame = node('div', undefined, 'chat-attachment-image-frame');
    frame.style.aspectRatio = '4 / 3';
    image = node('img', undefined, 'chat-attachment-image-content');
    image.alt = name; image.decoding = 'async'; image.loading = 'lazy'; image.width = 640; image.height = 480;
    const loaded = () => layout(() => { frame.dataset.state = 'loaded'; image.hidden = false; imageRetry.hidden = true; if (!downloading) imageStatus(null); });
    const failed = () => layout(() => { frame.dataset.state = 'failed'; image.hidden = true; imageRetry.hidden = false; imageStatus('loadFailed'); });
    image.addEventListener('load', loaded); image.addEventListener('error', failed);
    frame.append(image); root.append(frame);
    imageRetry = button('retry', 'retryAttachment', loadImage); imageRetry.hidden = true;
    root.disposeImage = () => { image.removeEventListener('load', loaded); image.removeEventListener('error', failed); image.removeAttribute('src'); };
  }
  if (url) download = button('download', 'downloadAttachment', () => { void downloadFile(); });
  if (mode === 'tray') {
    const state = attachment.status || 'ready'; root.dataset.uploadState = state;
    if (state === 'uploading' || state === 'queued') {
      const progress = node('progress', undefined, 'chat-attachment-progress'); progress.max = 100;
      progress.value = Math.min(100, Math.max(0, Number(attachment.progress) || 0));
      progress.setAttribute('aria-label', t('chat.attachment.uploading')); info.append(progress);
      setStatus('uploading');
    } else if (['failed', 'expired', 'unknown'].includes(state)) setStatus(state);
    else setStatus(null);
    if (typeof onRemove === 'function') button('remove', 'removeAttachment', onRemove);
    if (typeof onRetry === 'function' && ['failed', 'expired', 'unknown'].includes(state)) button('retry', 'retryUpload', onRetry);
  } else if (!url) setStatus(external ? 'external' : 'unavailable');
  else setStatus(null);
  root.append(info, status, actions);
  return { node: root,
    mount() { if (destroyed || mounted) return; mounted = true; if (image) loadImage(); },
    destroy() {
      if (destroyed) return; destroyed = true;
      request?.abort(); request = null; releaseDownload(); root.disposeImage?.();
    },
  };
}
