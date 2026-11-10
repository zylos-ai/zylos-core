import { element, icon } from './plain-text.js?v=106';

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
  let kind = attachment.kind === 'image' ? 'image' : 'file';
  let name = displayName(attachment.name) || t('chat.attachment.' + kind);
  const root = node('figure', undefined, `chat-attachment chat-attachment-${kind}`);
  root.dataset.attachmentKind = kind;
  const info = node('figcaption', undefined, 'chat-attachment-info');
  const copy = node('span', undefined, 'chat-attachment-copy');
  const typeIcon = icon(document, kind); typeIcon.classList.add('chat-attachment-type');
  const nameNode = node('span', name, 'chat-attachment-name'); nameNode.title = name;
  const meta = node('span', undefined, 'chat-attachment-meta');
  const size = node('span', sizeLabel(attachment.size) || attachment.sizeLabel || '');
  const separator = node('span', ' · ');
  const status = node('span', '', 'chat-attachment-status'); status.setAttribute('role', 'status');
  meta.append(size, separator, status); copy.append(nameNode, meta);
  const actions = node('div', undefined, 'chat-attachment-actions');
  const url = mode === 'history' ? chatAttachmentURL(attachment, context) : null;
  let previewUrl = mode === 'tray' && typeof localUrl === 'string' && localUrl.startsWith('blob:') ? localUrl : url;
  const external = context.external || attachment.external;
  const fetcher = context.fetch || globalThis.fetch;
  const browserURL = document.defaultView?.URL || globalThis.URL;
  let destroyed = false, mounted = false, request = null, saveUrl = null, revokeTimer = null;
  let image = null, frame = null, imageRetry = null, placeholder = null, downloading = false;
  let progress = null, retryUpload = null, remove = null, disabled = false, imageState = 'loading';
  const layout = change => {
    if (destroyed) return;
    if (context.onLayout) context.onLayout(change);
    else change();
  };
  const setText = (target, value) => { if (target.textContent !== value) target.textContent = value; };
  const setStatus = key => {
    root.dataset.attachmentState = key || 'ready';
    const percent = Math.min(100, Math.max(0, Number(attachment.progress) || 0));
    const value = key ? t('chat.attachment.' + key) + (mode === 'tray' && key === 'uploading' ? ` ${Math.round(percent)}%` : '') : '';
    setText(status, value); status.hidden = !key; separator.hidden = !key || !size.textContent;
  };
  const imageStatus = key => {
    const transfer = mode === 'tray' ? attachment.status : null;
    setStatus(mode === 'tray' ? transfer || 'ready' : key);
  };
  function button(key, action, handler) {
    const control = node('button', undefined, 'wb-btn wb-btn-sm');
    control.setAttribute('aria-label', `${t('chat.attachment.' + key)} ${name}`);
    control.title = t('chat.attachment.' + key);
    if (mode === 'tray') { control.append(icon(document, key === 'remove' ? 'trash' : 'restart')); control.classList.add('chat-attachment-icon-button'); }
    control.append(node('span', t('chat.attachment.' + key), 'chat-attachment-action-label'));
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
  function updateImagePresentation() {
    if (!image) return;
    const transferFailed = mode === 'tray' && ['failed', 'expired'].includes(attachment.status);
    const collapsed = transferFailed || imageState === 'failed';
    frame.dataset.state = collapsed ? 'failed' : imageState;
    const ratio = imageState === 'loaded' && image.naturalWidth > 0 && image.naturalHeight > 0
      ? `${image.naturalWidth} / ${image.naturalHeight}` : '4 / 3';
    frame.style.aspectRatio = collapsed ? '' : ratio;
    image.hidden = collapsed; placeholder.hidden = !collapsed;
    imageRetry.hidden = imageState !== 'failed' || transferFailed || kind !== 'image';
  }
  function loadImage() {
    if (!image || destroyed) return;
    layout(() => {
      imageState = 'loading'; updateImagePresentation();
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
    const loaded = () => layout(() => { imageState = 'loaded'; updateImagePresentation(); if (!downloading) imageStatus(null); });
    const failed = () => layout(() => { imageState = 'failed'; updateImagePresentation(); imageStatus('loadFailed'); });
    image.addEventListener('load', loaded); image.addEventListener('error', failed);
    placeholder = node('div', undefined, 'chat-attachment-placeholder'); placeholder.append(icon(document, 'image')); placeholder.hidden = true;
    frame.append(image, placeholder); root.append(frame);
    imageRetry = button('retry', 'retryAttachment', loadImage); imageRetry.hidden = true;
    root.disposeImage = () => { image.removeEventListener('load', loaded); image.removeEventListener('error', failed); image.removeAttribute('src'); };
  }
  if (url) download = button('download', 'downloadAttachment', () => { void downloadFile(); });
  if (mode === 'tray') {
    progress = node('progress', undefined, 'chat-attachment-progress'); progress.max = 100;
    progress.setAttribute('aria-label', t('chat.attachment.uploading'));
    if (typeof onRemove === 'function') remove = button('remove', 'removeAttachment', onRemove);
    if (typeof onRetry === 'function') retryUpload = button('retry', 'retryUpload', onRetry);
  } else if (!url) setStatus(external ? 'external' : 'unavailable');
  else setStatus(null);
  if (kind === 'image' && !previewUrl) {
    placeholder = node('div', undefined, 'chat-attachment-placeholder'); placeholder.append(icon(document, 'image'));
    root.append(placeholder);
  }
  info.append(typeIcon, copy, actions); root.append(info);
  if (progress) root.append(progress);
  const update = ({ attachment: next = attachment, localUrl: nextUrl = previewUrl, disabled: nextDisabled = disabled } = {}) => {
    if (destroyed || mode !== 'tray') return;
    attachment = next; disabled = nextDisabled;
    kind = attachment.kind === 'image' ? 'image' : 'file';
    name = displayName(attachment.name) || t('chat.attachment.' + kind);
    root.className = `chat-attachment chat-attachment-${kind}`; root.dataset.attachmentKind = kind;
    typeIcon.className = `wb-ico wb-ico-${kind} chat-attachment-type`;
    setText(nameNode, name); nameNode.title = name;
    setText(size, sizeLabel(attachment.size) || attachment.sizeLabel || '');
    if (image) image.alt = name;
    if (frame) frame.hidden = kind !== 'image';
    if (kind === 'image' && !placeholder) {
      placeholder = node('div', undefined, 'chat-attachment-placeholder'); placeholder.append(icon(document, 'image'));
      root.insertBefore(placeholder, info);
    }
    if (placeholder && !frame) placeholder.hidden = kind !== 'image';
    for (const control of actions.querySelectorAll('button')) {
      const key = control.dataset.action === 'removeAttachment' ? 'remove' : control.dataset.action === 'downloadAttachment' ? 'download' : 'retry';
      control.setAttribute('aria-label', `${t('chat.attachment.' + key)} ${name}`);
      control.title = t('chat.attachment.' + key);
      setText(control.querySelector('.chat-attachment-action-label'), t('chat.attachment.' + key));
    }
    progress.setAttribute('aria-label', t('chat.attachment.uploading'));
    if (imageRetry) { imageRetry.disabled = disabled; if (kind !== 'image') imageRetry.hidden = true; }
    const state = attachment.status || 'ready'; root.dataset.uploadState = state;
    setStatus(state); updateImagePresentation();
    progress.hidden = state !== 'uploading';
    progress.value = Math.min(100, Math.max(0, Number(attachment.progress) || 0));
    if (remove) remove.disabled = disabled;
    if (retryUpload) { retryUpload.hidden = !['failed', 'expired'].includes(state); retryUpload.disabled = disabled; }
    // A progress/poll update must not reload an unchanged preview or replace focused controls.
    if (image && typeof nextUrl === 'string' && nextUrl.startsWith('blob:') && nextUrl !== previewUrl) {
      previewUrl = nextUrl; if (mounted) loadImage();
    }
  };
  if (mode === 'tray') update();
  return { node: root, update,
    mount() { if (destroyed || mounted) return; mounted = true; if (image) loadImage(); },
    destroy() {
      if (destroyed) return; destroyed = true;
      request?.abort(); request = null; releaseDownload(); root.disposeImage?.();
    },
  };
}
