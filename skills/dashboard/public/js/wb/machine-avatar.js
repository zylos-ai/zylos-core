// A machine's avatar: its uploaded picture, or the first letter of its name on its fleet colour. Fleet cards and
// rows, the Settings machine cards and the header of a machine opened from the fleet all draw it from here.
import { agentColor } from '../agent-color.js';

const SIZES = new Set(['xs', 'sm', 'md', 'lg']);
const RETRY_MS = 60_000;

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function avatarLetter(name) {
  return (Array.from(String(name ?? '').trim())[0] ?? '?').toUpperCase();
}

/**
 * `src` is an image URL already read into the page (see createAvatarStore), or null for the letter. `dot` is the
 * class list of the status dot shown on the avatar's corner (for example 'wb-hdot idle'), or empty for none.
 */
export function avatarHtml({ name, color, src = null, size = 'sm', offline = false, dot = '' } = {}) {
  const fill = /^#[0-9a-f]{3,8}$/i.test(String(color ?? '')) ? color : agentColor(name).color;
  const face = src ? `<img src="${escapeHtml(src)}" alt="">` : `<span class="wb-av-l">${escapeHtml(avatarLetter(name))}</span>`;
  return `<span class="wb-av wb-av-${SIZES.has(size) ? size : 'sm'}${offline ? ' off' : ''}" style="--wb-av-c:${fill}" aria-hidden="true">${face}${dot ? `<span class="${escapeHtml(dot)}"></span>` : ''}</span>`;
}

export function avatarNode(document, options) {
  const template = document.createElement('template');
  template.innerHTML = avatarHtml(options);
  return template.content.firstElementChild;
}

/**
 * Avatar pictures read once per machine and version. The avatar endpoint is not cacheable and the fleet redraws
 * often, so each picture is fetched into a blob URL and reused until its version changes. `version` null means the
 * machine reported no avatar (nothing is fetched); undefined means unknown (read once if nothing was read yet). A
 * failed read (other than 404, no avatar) is tried again a minute later. `onChange` runs when a
 * picture arrives, so the caller can redraw.
 */
export function createAvatarStore({ fetch = globalThis.fetch, URL: Url = globalThis.URL, onChange = () => {}, now = Date.now } = {}) {
  const entries = new Map();
  const drop = entry => { if (entry?.src) Url.revokeObjectURL(entry.src); };
  function src(url, version) {
    if (!url || version === null) return null;
    const entry = entries.get(url);
    // An unknown version takes whatever was read last, so callers without a version never cause a re-read.
    if (entry && (version === undefined || entry.version === version) && !(entry.retryAt && now() >= entry.retryAt)) return entry.src;
    drop(entry);
    const next = { version: version ?? '', src: null, retryAt: 0 };
    entries.set(url, next);
    fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(async response => {
      if (response.status === 404) return null;
      if (!response.ok || !/^image\//.test(response.headers.get('content-type') ?? '')) throw new Error('avatar_read_failed');
      return Url.createObjectURL(await response.blob());
    }).then(value => {
      if (entries.get(url) !== next) { if (value) Url.revokeObjectURL(value); return; }
      next.src = value;
      if (value) onChange();
    }, () => { if (entries.get(url) === next) next.retryAt = now() + RETRY_MS; });
    return null;
  }
  // After an upload the page already holds the picture: show it at once under its new version.
  function put(url, version, blob) {
    drop(entries.get(url));
    entries.set(url, { version, src: Url.createObjectURL(blob), retryAt: 0 });
    onChange();
  }
  return { src, put };
}
