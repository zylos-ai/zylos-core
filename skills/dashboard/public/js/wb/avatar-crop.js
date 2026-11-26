// The 「换本机头像」 dialog: drag and zoom a picture inside a circle, preview it at the sizes the fleet uses, and get
// back the square image to upload (cropped and scaled in the browser). A phone shows it as a bottom sheet.
import { element } from './plain-text.js';

const PREVIEWS = [['lg', 'wb.settings.fleet.avatarPreviewSettings'], ['md', 'wb.settings.fleet.avatarPreviewCard'], ['sm', 'wb.settings.fleet.avatarPreviewList']];
const MAX_ZOOM = 4;

function button(document, text, className = 'wb-btn') {
  const node = element(document, 'button', text, className);
  node.type = 'button';
  return node;
}

function encode(canvas) {
  return new Promise(resolve => canvas.toBlob(webp => {
    // Browsers that cannot write WebP hand back PNG under the same call; ask for PNG explicitly then.
    if (webp?.type === 'image/webp') resolve(webp);
    else canvas.toBlob(png => resolve(png), 'image/png');
  }, 'image/webp', 0.9));
}

/** Resolves to the cropped square image (WebP, or PNG where WebP cannot be written), or null when cancelled. */
export function cropAvatarDialog(document, { t = key => key, file, title, size = 256 }) {
  const win = document.defaultView;
  return new Promise(resolve => {
    const backdrop = element(document, 'div', undefined, 'wb-modal-bg wb-av-crop-bg');
    const dialog = element(document, 'div', undefined, 'wb-modal wb-av-crop');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    const heading = element(document, 'h3', title); heading.id = 'wb-av-crop-title';
    dialog.setAttribute('aria-labelledby', heading.id);
    const lead = element(document, 'p', t('wb.settings.fleet.avatarCropHint'));

    const stage = element(document, 'div', undefined, 'wb-av-stage');
    stage.tabIndex = 0; stage.setAttribute('role', 'img'); stage.setAttribute('aria-label', t('wb.settings.fleet.avatarCropArea'));
    const canvas = element(document, 'canvas');
    stage.append(canvas, element(document, 'span', undefined, 'wb-av-mask'), element(document, 'span', t('wb.settings.fleet.avatarDrag'), 'wb-av-hint'));
    const zoomInput = element(document, 'input'); zoomInput.type = 'range'; zoomInput.min = '1'; zoomInput.max = String(MAX_ZOOM); zoomInput.step = '0.01'; zoomInput.value = '1';
    zoomInput.setAttribute('aria-label', t('wb.settings.fleet.avatarZoom'));
    const zoomRow = element(document, 'div', undefined, 'wb-av-zoom');
    zoomRow.append(element(document, 'span', '−'), zoomInput, element(document, 'span', '+'));
    const left = element(document, 'div', undefined, 'wb-av-left'); left.append(stage, zoomRow);

    const previews = element(document, 'div', undefined, 'wb-av-previews');
    const previewCanvases = PREVIEWS.map(([sizeName, label]) => {
      const figure = element(document, 'figure');
      const face = element(document, 'span', undefined, `wb-av wb-av-${sizeName}`);
      const small = element(document, 'canvas'); face.append(small);
      figure.append(face, element(document, 'figcaption', t(label)));
      previews.append(figure);
      return small;
    });
    const side = element(document, 'div', undefined, 'wb-av-side');
    side.append(element(document, 'div', t('wb.settings.fleet.avatarPreview'), 'wb-av-side-h'), previews, element(document, 'p', t('wb.settings.fleet.avatarSaveNote', { size })));
    const body = element(document, 'div', undefined, 'wb-av-body'); body.append(left, side);

    const status = element(document, 'p', '', 'wb-av-status'); status.setAttribute('role', 'status'); status.hidden = true;
    const picker = element(document, 'input'); picker.type = 'file'; picker.accept = 'image/*'; picker.hidden = true;
    const again = button(document, t('wb.settings.fleet.avatarPickAgain'));
    const cancel = button(document, t('btn.cancel'));
    const save = button(document, t('btn.save'), 'wb-btn wb-btn-primary'); save.disabled = true;
    const acts = element(document, 'div', undefined, 'wb-modal-acts');
    acts.append(again, element(document, 'span', undefined, 'wb-grow'), cancel, save);
    dialog.append(heading, lead, body, status, acts, picker);
    backdrop.append(dialog);

    let image = null, side0 = 0, base = 1, zoom = 1, ox = 0, oy = 0, drag = null, downOnBackdrop = false;
    const scale = () => base * zoom;
    const clamp = () => {
      ox = Math.min(0, Math.max(side0 - image.width * scale(), ox));
      oy = Math.min(0, Math.max(side0 - image.height * scale(), oy));
    };
    const paint = (target, pixels) => {
      target.width = target.height = Math.round(pixels);
      const context = target.getContext('2d');
      const k = pixels / side0;
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.clearRect(0, 0, target.width, target.height);
      context.drawImage(image, ox * k, oy * k, image.width * scale() * k, image.height * scale() * k);
    };
    const draw = () => {
      if (!image) return;
      const ratio = win?.devicePixelRatio || 1;
      paint(canvas, side0 * ratio);
      for (const small of previewCanvases) paint(small, small.parentElement.clientWidth * ratio);
    };
    const zoomTo = (value, cx = side0 / 2, cy = side0 / 2) => {
      if (!image) return;
      const next = Math.min(MAX_ZOOM, Math.max(1, value));
      const px = (cx - ox) / scale(), py = (cy - oy) / scale();
      zoom = next; ox = cx - px * scale(); oy = cy - py * scale();
      clamp(); zoomInput.value = String(zoom); draw();
    };
    const show = message => { status.textContent = message; status.hidden = !message; };
    const load = picked => {
      if (!picked) return;
      show(''); save.disabled = true;
      const url = win.URL.createObjectURL(picked);
      const next = new win.Image();
      next.onload = () => {
        win.URL.revokeObjectURL(url);
        image = next; side0 = stage.clientWidth;
        base = Math.max(side0 / image.width, side0 / image.height); zoom = 1; zoomInput.value = '1';
        ox = (side0 - image.width * base) / 2; oy = (side0 - image.height * base) / 2;
        save.disabled = false; draw();
      };
      next.onerror = () => { win.URL.revokeObjectURL(url); show(t('wb.settings.fleet.avatarUnreadable')); };
      next.src = url;
    };

    stage.addEventListener('pointerdown', event => {
      if (!image) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ox, oy };
      stage.setPointerCapture?.(event.pointerId); stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      ox = drag.ox + event.clientX - drag.x; oy = drag.oy + event.clientY - drag.y; clamp(); draw();
    });
    const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
    stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('wheel', event => {
      if (!image) return;
      event.preventDefault();
      const box = stage.getBoundingClientRect();
      zoomTo(zoom * Math.exp(-event.deltaY / 500), event.clientX - box.left, event.clientY - box.top);
    }, { passive: false });
    stage.addEventListener('keydown', event => {
      if (!image) return;
      const moves = { ArrowLeft: [8, 0], ArrowRight: [-8, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] };
      if (moves[event.key]) { ox += moves[event.key][0]; oy += moves[event.key][1]; clamp(); draw(); }
      else if (event.key === '+' || event.key === '=') zoomTo(zoom + 0.1);
      else if (event.key === '-') zoomTo(zoom - 0.1);
      else return;
      event.preventDefault();
    });
    zoomInput.addEventListener('input', () => zoomTo(Number(zoomInput.value)));
    again.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { load(picker.files?.[0]); picker.value = ''; });

    const previous = document.activeElement;
    const finish = value => {
      document.removeEventListener('keydown', keydown, true);
      backdrop.remove(); previous?.focus?.(); resolve(value);
    };
    const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); } };
    cancel.addEventListener('click', () => finish(null));
    save.addEventListener('click', async () => {
      if (!image) return;
      save.disabled = true;
      const out = document.createElement('canvas');
      paint(out, size);
      const blob = await encode(out);
      if (blob) finish(blob);
      else { show(t('wb.settings.fleet.avatarUnreadable')); save.disabled = false; }
    });
    // A drag that ends outside the dialog must not close it: only a press and release on the backdrop does.
    backdrop.addEventListener('pointerdown', event => { downOnBackdrop = event.target === backdrop; });
    backdrop.addEventListener('click', event => { if (event.target === backdrop && downOnBackdrop) finish(null); });
    document.addEventListener('keydown', keydown, true);
    document.body.append(backdrop);
    stage.focus();
    load(file);
  });
}
