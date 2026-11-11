import { element, icon } from './plain-text.js?v=106';
import { chars, composeContent, storedContent, contentBytes, shortStamp, MAX_ANNOTATIONS, MAX_CHARS, MAX_CONTENT_BYTES } from './chat-compose-text.js?v=1';

const BLOCK = /^(P|LI|OL|UL|H[1-6]|PRE|BLOCKQUOTE|TABLE|TR|DIV|HR)$/;
const LISTISH = /^(OL|UL|DIV|BLOCKQUOTE|TABLE|TBODY|TR)$/;
const HIGHLIGHT = 'conversation-annotations';
const firstChars = (value, count) => Array.from(value).slice(0, count).join('');
const normalize = text => text.replace(/\n{2,}/g, '\n');

/** The text a message part shows, as the user reads it: block boundaries and line breaks become `\n`. */
export function textIndex(root) {
  const entries = [];
  let text = '';
  const walk = parent => {
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) {
        if (/^\s*\n\s*$/.test(child.data) && LISTISH.test(child.parentNode?.nodeName ?? '')) continue;
        entries.push({ node: child, start: text.length });
        text += child.data;
      } else if (child.nodeType === 1) {
        if (child.nodeName === 'BR') { text += '\n'; continue; }
        const block = BLOCK.test(child.nodeName);
        if (block && text && !text.endsWith('\n')) text += '\n';
        walk(child);
        if (block && text && !text.endsWith('\n')) text += '\n';
      }
    }
  };
  walk(root);
  return { entries, text };
}
function pointToIndex(document, index, container, offset) {
  const point = document.createRange();
  point.setStart(container, offset);
  for (const entry of index.entries) {
    if (entry.node === container) return entry.start + offset;
    if (point.comparePoint(entry.node, 0) > 0) return entry.start;
  }
  return index.text.length;
}
function indexToPoint(index, position) {
  for (const entry of index.entries) if (position >= entry.start && position <= entry.start + entry.node.data.length) return [entry.node, position - entry.start];
  for (const entry of index.entries) if (entry.start >= position) return [entry.node, 0];
  const last = index.entries.at(-1);
  return [last.node, last.node.data.length];
}
const textParts = article => [...article.querySelectorAll('.chat-message-text')].filter(part => part.closest('article') === article);

/**
 * The selection as an annotation target: it must lie in one text part of one message that `eligible` accepts, so a
 * selection across messages or touching a chart, form control or attachment card gives none.
 */
export function selectionTarget({ document, root, eligible }) {
  const selection = document.defaultView?.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;
  const startText = elementOf(range.startContainer)?.closest('.chat-message-text');
  const endText = elementOf(range.endContainer)?.closest('.chat-message-text');
  if (!startText || startText !== endText) return null;
  const article = startText.closest('article[data-message-id]');
  if (!article || !root.contains(article) || !eligible(article)) return null;
  const part = textParts(article).indexOf(startText);
  if (part < 0) return null;
  const index = textIndex(startText);
  let start = pointToIndex(document, index, range.startContainer, range.startOffset);
  let end = pointToIndex(document, index, range.endContainer, range.endOffset);
  while (start < end && /\s/.test(index.text[start])) start++;
  while (end > start && /\s/.test(index.text[end - 1])) end--;
  if (end <= start) return null;
  const selected = normalize(index.text.slice(start, end));
  return { messageId: article.dataset.messageId, part, start, end, excerpt: firstChars(selected, MAX_CHARS), length: chars(selected),
    rects: [...range.getClientRects()].filter(rect => rect.width || rect.height) };
}

/** The range an annotation marks, when its message is loaded and still shows the same text there. */
export function annotationRange({ document, root, item }) {
  if (!/^[1-9][0-9]{0,18}$/.test(String(item.messageId))) return null;
  const article = root.querySelector(`article[data-message-id="${item.messageId}"]`);
  const part = article && textParts(article)[item.part];
  if (!part) return null;
  const index = textIndex(part);
  if (!index.entries.length) return null;
  const selected = normalize(index.text.slice(item.start, item.end));
  if (chars(selected) !== item.length || firstChars(selected, MAX_CHARS) !== item.excerpt) return null;
  const range = document.createRange(), [startNode, startOffset] = indexToPoint(index, item.start), [endNode, endOffset] = indexToPoint(index, item.end);
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/** Annotations change only on the user's own conversation while the composer is writable and no send is open. */
export const annotationsEditable = s => s.tab === 'mine' && s.canWrite && !s.sending && !s.pending;
/** Whether text in a message can be annotated: internal messages cannot, nor anything while editing is locked. */
export const annotatable = (article, s) => !article.classList.contains('conversation-internal') && annotationsEditable(s);

/**
 * Annotations while composing: the 标注 button beside a selection, the editor (a bottom sheet on phones), the
 * highlights, the count button in the composer and the list. The conversation state owns the items; this draws them.
 */
export function createAnnotationUi({ document, t, root, composer, composeBox, narrow, snapshot, author, onAdd, onUpdate, onRemove, onLocate, onOpen }) {
  const view = document.defaultView;
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const button = (cls, label, ico) => {
    const result = node('button', undefined, cls);
    result.type = 'button';
    if (ico) result.append(icon(document, ico));
    if (label !== undefined) result.append(node('span', label));
    return result;
  };
  const editable = annotationsEditable;
  const eligible = article => annotatable(article, snapshot());
  const layer = [];
  // Fixed-position popups live on <body>: the page view is scale-transformed while it animates in, which would anchor
  // them to the view instead of the viewport. Without a body (a detached document) they stay inside the page.
  const host = document.body ?? root;
  const mount = el => { host.append(el); layer.push(el); return el; };

  const mark = mount(button('conversation-mark-button', t('chat.annotation.button'), 'annotate'));
  mark.hidden = true;
  const scrim = mount(node('div', undefined, 'conversation-annotation-scrim'));
  scrim.hidden = true;
  const count = button('conversation-annotations-button', undefined, 'annotate');
  count.dataset.action = 'annotations';
  const countText = node('span', '0', 'conversation-annotations-count');
  count.append(countText);
  count.hidden = true;

  const pop = (cls, label) => {
    const result = mount(node('div', undefined, 'conversation-annotation-pop ' + cls));
    result.hidden = true;
    result.setAttribute('role', 'dialog');
    result.setAttribute('aria-label', label);
    const head = node('div', undefined, 'conversation-annotation-head'), heading = node('h3');
    const close = button('wb-icon-btn', undefined, 'x');
    close.setAttribute('aria-label', t('chat.annotation.close'));
    head.append(heading, close);
    const body = node('div', undefined, 'conversation-annotation-body'), foot = node('div', undefined, 'conversation-annotation-foot');
    result.append(head, body, foot);
    return { el: result, heading, close, body, foot };
  };

  // Editor
  const editor = pop('conversation-annotation-editor', t('chat.annotation.title'));
  let editing = null;
  const excerpt = node('p', undefined, 'conversation-annotation-excerpt');
  const field = node('label', undefined, 'conversation-annotation-field');
  const fieldLabel = node('span'), fieldCount = node('span', undefined, 'conversation-annotation-chars');
  const comment = node('textarea', undefined, 'conversation-annotation-input');
  comment.maxLength = MAX_CHARS;
  comment.id = 'conversation-annotation-comment';
  comment.disabled = true;
  field.htmlFor = comment.id;
  field.append(fieldLabel, fieldCount);
  const editorHint = node('p', undefined, 'conversation-annotation-hint');
  editor.body.append(excerpt, field, comment, editorHint);
  const editorCancel = button('wb-btn', t('chat.page.cancel')), editorSave = button('wb-btn wb-btn-primary', t('chat.annotation.save'));
  editorSave.dataset.action = 'saveAnnotation';
  editorSave.disabled = true;
  editor.foot.append(node('span', undefined, 'conversation-annotation-spacer'), editorCancel, editorSave);
  const charCount = value => `${chars(value)} / ${MAX_CHARS}`;
  comment.addEventListener('input', () => { fieldCount.textContent = charCount(comment.value); });
  comment.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); editorSave.click(); } });
  function closeEditor() {
    editing = null;
    editor.el.hidden = true;
    scrim.hidden = !(list.open && narrow());
  }
  editor.close.addEventListener('click', closeEditor);
  editorCancel.addEventListener('click', closeEditor);
  editorSave.addEventListener('click', () => {
    if (!editing || !editable(snapshot())) return;
    const target = editing;
    if (onAdd({ ...target.item, comment: firstChars(comment.value.trim(), MAX_CHARS) })) view?.getSelection?.()?.removeAllRanges();
    closeEditor();
    mark.hidden = true;
    bump();
  });
  function placeNear(el, rects) {
    if (narrow()) { el.style.cssText = ''; return; }
    const width = 380, last = rects.at(-1) ?? rects[0];
    el.style.width = `${width}px`;
    el.style.left = `${Math.min(Math.max(12, (last?.right ?? 12) - width / 2), view.innerWidth - width - 12)}px`;
    el.style.top = '0px';
    const height = el.offsetHeight;
    let top = (last?.bottom ?? 12) + 10;
    if (top + height > view.innerHeight - 12) top = (rects[0]?.top ?? 12) - height - 10;
    // The selected text may be off screen (a shorter window); the editor and its buttons stay on it.
    top = Math.max(12, Math.min(top, view.innerHeight - height - 12));
    el.style.top = `${top}px`;
  }
  // Where the editor sits follows the viewport: a bottom sheet when narrow, otherwise beside the selected text, which is
  // measured again because a resize (a phone keyboard opening, a window drag) moves it.
  function placeEditor() {
    if (editor.el.hidden || !editing) return;
    const range = annotationRange({ document, root, item: editing.item });
    const rects = range ? [...range.getClientRects()].filter(rect => rect.width || rect.height) : [];
    if (rects.length) editing.rects = rects;
    editor.el.classList.toggle('conversation-annotation-sheet', narrow());
    scrim.hidden = !narrow();
    placeNear(editor.el, editing.rects);
  }
  function openEditor(target) {
    const row = author(target.messageId);
    if (!row) return;
    editing = { item: { messageId: String(target.messageId), direction: row.direction, timestamp: row.timestamp, part: target.part,
      start: target.start, end: target.end, excerpt: target.excerpt, length: target.length }, rects: target.rects };
    editor.heading.textContent = t('chat.annotation.title');
    excerpt.textContent = target.excerpt;
    fieldLabel.textContent = t('chat.annotation.commentLabel');
    comment.placeholder = t('chat.annotation.placeholder');
    comment.value = '';
    fieldCount.textContent = charCount('');
    editorHint.textContent = target.length > MAX_CHARS ? t('chat.annotation.hintLong', { count: String(target.length), limit: String(MAX_CHARS) })
      : t('chat.annotation.hint');
    editor.el.hidden = false;
    placeEditor();
    mark.hidden = true;
    view?.setTimeout(() => comment.focus({ preventScroll: true }), 0);
  }

  // Selection → 标注 button
  let pendingTarget = null, selectionTimer = null;
  function readSelection() {
    selectionTimer = null;
    if (!editor.el.hidden) return;
    const s = snapshot();
    pendingTarget = root.isConnected && !root.hidden ? selectionTarget({ document, root, eligible }) : null;
    if (!pendingTarget || !editable(s)) { mark.hidden = true; return; }
    const rects = pendingTarget.rects, last = rects.at(-1);
    if (!last) { mark.hidden = true; return; }
    const width = 84, height = 32;
    const left = Math.min(Math.max(8, narrow() ? (rects[0].left + last.right) / 2 - width / 2 : last.right - width / 2), view.innerWidth - width - 8);
    let top = last.bottom + 8;
    // Never over the composer: above the selection instead.
    if (top + height > composer.getBoundingClientRect().top - 4) top = Math.max(8, rects[0].top - height - 8);
    mark.style.left = `${left}px`;
    mark.style.top = `${top}px`;
    mark.disabled = s.annotations.length >= MAX_ANNOTATIONS;
    mark.title = t(mark.disabled ? 'chat.annotation.limitTitle' : 'chat.annotation.buttonTitle', { limit: String(MAX_ANNOTATIONS) });
    mark.lastElementChild.textContent = t('chat.annotation.button');
    mark.hidden = false;
  }
  const selectionChanged = () => {
    if (selectionTimer !== null) view.clearTimeout(selectionTimer);
    selectionTimer = view.setTimeout(readSelection, narrow() ? 220 : 60);
  };
  document.addEventListener?.('selectionchange', selectionChanged);
  // Keep the selection when the button is pressed.
  mark.addEventListener('mousedown', event => event.preventDefault());
  mark.addEventListener('click', () => { if (pendingTarget && !mark.disabled) openEditor(pendingTarget); });

  // List
  const list = { ...pop('conversation-annotation-list', t('chat.annotation.title')), open: false, editing: null, expanded: new Set(), previewOpen: false };
  list.close.addEventListener('click', () => closeList());
  function openList() {
    list.open = true;
    list.el.hidden = false;
    mark.hidden = true;
    render(snapshot());
    onOpen?.();
  }
  function closeList({ focus = false } = {}) {
    list.open = false;
    list.el.hidden = true;
    list.editing = null;
    scrim.hidden = editor.el.hidden || !narrow();
    if (focus) count.focus();
  }
  function placeList() {
    if (!list.open) return;
    if (narrow()) { list.el.style.cssText = ''; list.el.classList.add('conversation-annotation-sheet'); scrim.hidden = false; return; }
    list.el.classList.remove('conversation-annotation-sheet');
    scrim.hidden = editor.el.hidden;
    const box = composeBox.getBoundingClientRect(), composerTop = composer.getBoundingClientRect().top;
    const width = Math.min(560, box.width);
    list.el.style.width = `${width}px`;
    list.el.style.left = `${box.left}px`;
    list.el.style.top = 'auto';
    list.el.style.bottom = `${view.innerHeight - composerTop + 8}px`;
    list.el.style.maxHeight = `${Math.max(240, composerTop - Math.max(0, root.getBoundingClientRect().top) - 16)}px`;
  }
  count.addEventListener('click', () => list.open ? closeList() : openList());
  scrim.addEventListener('click', () => { if (!editor.el.hidden) closeEditor(); if (list.open) closeList(); });
  const keydown = event => {
    if (event.key !== 'Escape') return;
    if (!editor.el.hidden) closeEditor();
    else if (list.open) closeList({ focus: true });
  };
  const pointerdown = event => {
    if (list.open && !narrow() && !list.el.contains(event.target) && !count.contains(event.target)) closeList();
  };
  document.addEventListener?.('keydown', keydown);
  document.addEventListener?.('mousedown', pointerdown);
  const action = (ico, label, handler, cls = '') => {
    const result = button('conversation-annotation-action ' + cls, label, ico);
    result.addEventListener('click', handler);
    return result;
  };
  function render(s) {
    if (!list.open) return;
    const items = s.annotations, readOnly = !editable(s);
    list.heading.textContent = t('chat.annotation.listTitle', { count: String(items.length) });
    list.body.replaceChildren();
    if (items.length >= MAX_ANNOTATIONS) list.body.append(node('p', t('chat.annotation.limit', { limit: String(MAX_ANNOTATIONS) }), 'conversation-annotation-limit'));
    const ol = node('ol', undefined, 'conversation-annotation-items');
    items.forEach((item, index) => {
      const li = node('li', undefined, 'conversation-annotation-item');
      li.dataset.key = String(item.key);
      const meta = node('div', undefined, 'conversation-annotation-meta');
      meta.append(node('span', `${t(item.direction === 'in' ? 'chat.page.you' : 'chat.page.ai')} · ${shortStamp(item.timestamp, s.tz)}`));
      const content = node('div', undefined, 'conversation-annotation-content');
      const quoted = node('p', item.excerpt, 'conversation-annotation-excerpt');
      const long = item.excerpt.split('\n').length > 3 || chars(item.excerpt) > 120;
      if (long && !list.expanded.has(item.key)) quoted.classList.add('conversation-annotation-clamp');
      content.append(quoted);
      if (long) {
        const more = button('conversation-annotation-more', t(list.expanded.has(item.key) ? 'chat.annotation.less' : 'chat.annotation.more'));
        more.addEventListener('click', () => {
          if (list.expanded.has(item.key)) list.expanded.delete(item.key); else list.expanded.add(item.key);
          render(snapshot());
        });
        content.append(more);
      }
      if (list.editing === item.key && !readOnly) {
        const area = node('textarea', undefined, 'conversation-annotation-input');
        area.maxLength = MAX_CHARS;
        area.value = item.comment;
        area.placeholder = t('chat.annotation.commentLabel');
        area.setAttribute('aria-label', t('chat.annotation.commentLabel'));
        const row = node('div', undefined, 'conversation-annotation-edit-row'), counter = node('span', charCount(area.value), 'conversation-annotation-chars');
        area.addEventListener('input', () => { counter.textContent = charCount(area.value); });
        const cancel = button('wb-btn', t('chat.page.cancel')), save = button('wb-btn wb-btn-primary', t('chat.annotation.save'));
        cancel.addEventListener('click', () => { list.editing = null; render(snapshot()); });
        save.addEventListener('click', () => { list.editing = null; onUpdate(item.key, firstChars(area.value.trim(), MAX_CHARS)); render(snapshot()); });
        row.append(counter, cancel, save);
        content.append(area, row);
        view?.setTimeout(() => area.focus({ preventScroll: true }), 0);
      } else {
        content.append(node('p', item.comment || t('chat.annotation.noComment'), 'conversation-annotation-comment' + (item.comment ? '' : ' conversation-annotation-empty')));
        const actions = node('div', undefined, 'conversation-annotation-actions');
        const locate = action('target', t('chat.annotation.locate'), () => { if (narrow()) closeList(); void onLocate(item.messageId); });
        locate.dataset.action = 'locateAnnotation';
        const edit = action('edit', t(item.comment ? 'chat.annotation.edit' : 'chat.annotation.add'), () => { list.editing = item.key; render(snapshot()); });
        const remove = action('trash', t('chat.annotation.delete'), () => {
          onRemove(item.key);
          if (!snapshot().annotations.length) closeList({ focus: false }); else render(snapshot());
        }, 'conversation-annotation-danger');
        remove.dataset.action = 'removeAnnotation';
        edit.disabled = remove.disabled = readOnly;
        actions.append(locate, edit, remove);
        content.append(actions);
      }
      li.append(node('span', String(index + 1), 'conversation-annotation-number'), meta, content);
      ol.append(li);
    });
    list.body.append(ol);
    const preview = node('details', undefined, 'conversation-annotation-preview');
    preview.open = list.previewOpen;
    const summary = node('summary');
    summary.append(icon(document, 'chev'), node('span', t('chat.annotation.preview')));
    preview.append(summary);
    const content = s.pending?.content ?? composeContent({ text: s.input, annotations: items, timeZone: s.tz });
    const quoteId = s.pending ? s.pending.quote : s.quote?.id ?? null;
    if (quoteId && s.quote) {
      preview.append(node('p', t('chat.annotation.previewQuote', { who: quoteAuthor(s.quote, t), time: shortStamp(s.quote.timestamp, s.tz) }), 'conversation-annotation-preview-quote'));
    }
    const bytes = contentBytes(storedContent(content, quoteId));
    preview.append(node('pre', content, 'conversation-annotation-preview-text'),
      node('p', t('chat.annotation.bytes', { bytes: bytes.toLocaleString('en-US'), limit: MAX_CONTENT_BYTES.toLocaleString('en-US') }),
        'conversation-annotation-bytes' + (bytes > MAX_CONTENT_BYTES ? ' conversation-annotation-over' : '')));
    preview.addEventListener('toggle', () => { list.previewOpen = preview.open; });
    list.body.append(preview);
    const clear = button('conversation-annotation-clear', t('chat.annotation.clear'));
    clear.dataset.action = 'clearAnnotations';
    clear.disabled = readOnly;
    clear.addEventListener('click', () => { onRemove(undefined); closeList({ focus: false }); });
    const done = button('wb-btn', t('chat.annotation.done'));
    done.addEventListener('click', () => closeList({ focus: true }));
    list.foot.replaceChildren(clear, node('span', undefined, 'conversation-annotation-spacer'), done);
    placeList();
  }
  function bump() {
    count.classList.remove('conversation-bump');
    void count.offsetWidth;
    count.classList.add('conversation-bump');
  }
  function paint(s) {
    const highlights = view?.CSS?.highlights, Highlight = view?.Highlight;
    if (!highlights || typeof Highlight !== 'function') return;
    const ranges = [];
    if (s.tab === 'mine') for (const item of s.annotations) {
      const range = annotationRange({ document, root, item });
      if (range) ranges.push(range);
    }
    highlights.set(HIGHLIGHT, new Highlight(...ranges));
  }
  function update(s) {
    const total = s.tab === 'mine' ? s.annotations.length : 0;
    count.hidden = total === 0;
    countText.textContent = String(total);
    count.setAttribute('aria-label', t('chat.annotation.count', { count: String(total) }));
    count.title = t('chat.annotation.countTitle', { count: String(total) });
    const writable = editable(s);
    comment.disabled = editorSave.disabled = !writable;
    if (!writable) { mark.hidden = true; if (!editor.el.hidden) closeEditor(); }
    if (!total && list.open) closeList();
    if (list.open && list.editing === null) render(s);
    else placeList();
    paint(s);
  }
  const resize = () => { placeList(); placeEditor(); };
  view?.addEventListener('resize', resize);
  return {
    count,
    update,
    hide() { mark.hidden = true; if (!editor.el.hidden) closeEditor(); if (list.open) closeList(); },
    destroy() {
      if (selectionTimer !== null) view.clearTimeout(selectionTimer);
      document.removeEventListener?.('selectionchange', selectionChanged);
      document.removeEventListener?.('keydown', keydown);
      document.removeEventListener?.('mousedown', pointerdown);
      view?.removeEventListener('resize', resize);
      view?.CSS?.highlights?.delete(HIGHLIGHT);
      for (const el of layer) el.remove();
    }
  };
}

/** Who a quote shows: you, the AI, or an internal message. */
export function quoteAuthor(quote, t) {
  return t(quote.internal ? 'chat.quote.internal' : quote.direction === 'in' ? 'chat.page.you' : 'chat.page.ai');
}
