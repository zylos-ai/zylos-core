// Read-only history UI. The controller never owns the terminal or its lease.
export function escapeHistory(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export function createHistoryMarkdown(factory) {
  if (!factory) return text => `<pre>${escapeHistory(text)}</pre>`;
  const md = factory({ html: false, linkify: true });
  md.validateLink = url => /^https?:\/\//i.test(url);
  md.renderer.rules.link_open = (tokens, i, options, env, renderer) => {
    tokens[i].attrSet('rel', 'noopener noreferrer');
    tokens[i].attrSet('target', '_blank');
    return renderer.renderToken(tokens, i, options);
  };
  // Do not fetch transcript-controlled external images (tracking or huge payloads).
  md.renderer.rules.image = (tokens, i) => escapeHistory(tokens[i].content);
  return text => md.render(String(text ?? ''));
}
export class ObserverHistory {
  constructor({ root, endpoint, t, document: doc = document, fetch: request = fetch }) {
    Object.assign(this, { root, endpoint, t, doc });
    this.request = (...args) => request(...args);
    this.active = false;
    this.generation = 0;
    this.entries = new Map();
    this.fields = new Map();
    this.controllers = new Set();
    this.markdown = createHistoryMarkdown(globalThis.window?.markdownit);
    this.root.innerHTML = `<div class="history-controls"><label class="history-session-field"><span data-label="sessions"></span><select data-history="sessions"></select></label><form data-history="search-form"><input data-history="query" type="search" minlength="2" maxlength="200"><button class="action-btn" data-label="search"></button></form><label><input data-history="internal" type="checkbox"><span data-label="internal"></span></label></div><div data-history="status" role="status"></div><div data-history="results" class="history-results" hidden></div><div data-history="timeline" class="history-timeline" tabindex="0"><button class="action-btn" data-history="older" data-label="older" hidden></button><div data-history="entries"></div></div><button class="action-btn history-latest" data-history="latest" data-label="latest" hidden></button>`;
    this.el = name => root.querySelector(`[data-history="${name}"]`);
    this.el('sessions').onchange = () => this.select(this.el('sessions').value);
    this.el('internal').onchange = () => this.select(this.session);
    this.el('search-form').onsubmit = event => { event.preventDefault(); this.search(); };
    this.el('older').onclick = () => this.load('before');
    this.el('latest').onclick = () => { this.session = null; this.cancel(); this.start(); };
    this.el('timeline').onscroll = () => {
      const timeline = this.el('timeline');
      this.el('latest').hidden = this.atBottom() && this.session === this.current;
      if (timeline.scrollTop < 60 && this.hasOlder) this.load('before');
      this.schedule();
    };
    this.doc.addEventListener('visibilitychange', () => {
      if (this.doc.hidden) this.cancel();
      else if (this.active) { if (!this.session) this.start(); else this.schedule(); }
    });
    globalThis.window?.addEventListener('resize', () => this.refreshOverflow());
    this.refreshLabels();
  }
  refreshOverflow() {
    for (const field of this.fields.values()) {
      if (!field.expanded && !field.descriptor.truncated && field.content.clientHeight) {
        field.expand.hidden = field.content.scrollHeight <= field.content.clientHeight + 1;
      }
    }
  }
  label(key, values) { return this.t(`observer.history.${key}`, values); }
  refreshLabels() {
    this.root.querySelectorAll('[data-label]').forEach(el => { el.textContent = this.label(el.dataset.label); });
    for (const field of this.fields.values()) {
      field.expand.textContent = this.label('expand');
      field.more.textContent = this.label('more');
      field.all.textContent = this.label('all');
    }
    for (const item of this.entries.values()) {
      const node = this.renderEntry(item.entry, item.node);
      item.node.replaceWith(node); item.node = node;
    }
    for (const option of this.el('sessions').options) {
      const session = this.sessions?.find(s => s.id === option.value);
      if (session) option.textContent = this.sessionLabel(session);
    }
    this.el('query').placeholder = this.label('search_placeholder');
    this.el('query').setAttribute('aria-label', this.label('search_placeholder'));
  }
  cancel() {
    clearTimeout(this.timer);
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.loading = false;
    for (const field of this.fields.values()) { field.loading = false; field.more.disabled = false; field.all.disabled = false; }
  }
  setActive(active) {
    this.active = active;
    this.cancel();
    if (active && !this.doc.hidden) this.start();
  }
  async json(route, params = {}) {
    const controller = new AbortController();
    const generation = this.generation;
    this.controllers.add(controller);
    try {
      const response = await this.request(this.endpoint(`/api/observer/history/${route}`) + '?' + new URLSearchParams(params), { cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (generation !== this.generation) throw Object.assign(new Error('stale'), { name: 'AbortError' });
      if (!response.ok) throw new Error(data.error || this.label('error'));
      return data;
    } finally { this.controllers.delete(controller); }
  }
  error(error) { if (error.name !== 'AbortError') this.el('status').textContent = this.label('error') + ': ' + error.message; }
  sessionLabel(session) {
    const date = session.startedAt ? new Date(session.startedAt) : null;
    let time = '';
    if (date && Number.isFinite(date.getTime())) {
      const pad = value => String(value).padStart(2, '0');
      const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}-`;
      time = `${year}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    const title = session.title || session.startedAt || session.id;
    const body = session.title && time ? `${time} · ${title}` : title;
    return `${session.kind === 'subagent' ? '↳ ' : ''}${session.id === this.current ? this.label('current') + ' · ' : ''}${body}`;
  }
  async start() {
    this.el('status').textContent = this.label('loading');
    try {
      const data = await this.json('sessions');
      this.current = data.current;
      const main = data.sessions.filter(s => s.kind !== 'subagent');
      main.sort((a, b) => Number(b.id === data.current) - Number(a.id === data.current));
      const sessions = main.flatMap(s => [s, ...data.sessions.filter(child => child.parentId === s.id)]);
      for (const session of data.sessions) if (!sessions.includes(session)) sessions.push(session);
      this.sessions = sessions;
      this.el('sessions').replaceChildren(...sessions.map(s => {
        const option = this.doc.createElement('option'); option.value = s.id;
        option.textContent = this.sessionLabel(s);
        return option;
      }));
      this.el('status').textContent = sessions.length ? '' : this.label('empty');
      if (sessions.length) await this.select(sessions.some(s => s.id === this.session) ? this.session : data.current || sessions[0].id);
    } catch (error) { this.error(error); }
  }
  async select(session, around) {
    this.cancel();
    this.session = session;
    this.el('sessions').value = session;
    this.entries.clear(); this.fields.clear();
    this.el('entries').replaceChildren();
    this.el('results').hidden = true;
    this.before = this.after = null;
    this.hasOlder = false;
    await this.load(around ? 'around' : 'latest', around);
  }
  atBottom() { const el = this.el('timeline'); return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }
  schedule() {
    clearTimeout(this.timer);
    if (this.active && !this.doc.hidden && this.atBottom()) this.timer = setTimeout(() => this.load('after'), 3000);
  }
  async load(direction, around) {
    if (this.loading || !this.active || this.doc.hidden || !this.session) return;
    this.loading = true;
    const generation = this.generation;
    const timeline = this.el('timeline');
    const oldHeight = timeline.scrollHeight;
    const oldTop = timeline.scrollTop;
    const wasBottom = this.atBottom();
    const params = { session: this.session, limit: 50, internal: this.el('internal').checked ? 1 : 0 };
    if (direction === 'around') params.around = around;
    else if (direction !== 'latest' && this[direction]) params[direction] = this[direction];
    try {
      const data = await this.json('entries', params);
      const additions = [];
      const visibleUpdates = (data.updates || []).filter(entry => this.entries.has(entry.id));
      for (const entry of [...data.entries, ...visibleUpdates]) {
        const old = this.entries.get(entry.id);
        if (old && JSON.stringify(old.entry) === JSON.stringify(entry)) continue;
        const node = this.renderEntry(entry, old?.node);
        if (old) old.node.replaceWith(node); else additions.push(node);
        this.entries.set(entry.id, { entry, node });
      }
      const container = this.el('entries');
      if (direction === 'before') container.prepend(...additions); else container.append(...additions);
      if (direction !== 'after') { this.before = data.before; this.hasOlder = data.hasOlder; }
      if (direction !== 'before' && data.after) this.after = data.after;
      this.refreshOverflow();
      this.el('older').hidden = !this.hasOlder;
      this.el('status').textContent = this.entries.size ? '' : this.label('empty');
      if (direction === 'before') timeline.scrollTop = oldTop + timeline.scrollHeight - oldHeight;
      else if (direction === 'around') this.entries.get(around)?.node.scrollIntoView({ block: 'center' });
      else if (direction === 'latest' || wasBottom) timeline.scrollTop = timeline.scrollHeight;
      this.el('latest').hidden = this.atBottom() && this.session === this.current;
    } catch (error) { this.error(error); }
    finally { if (generation === this.generation) { this.loading = false; this.schedule(); } }
  }
  renderEntry(entry, oldNode) {
    const node = this.doc.createElement('article');
    node.className = `history-entry history-${['inbound','outbound','text','tool','marker','internal'].includes(entry.kind) ? entry.kind : 'internal'}`;
    const details = entry.kind === 'tool' || entry.kind === 'internal';
    const kindLabel = entry.channel === 'void' ? this.label('handoff') : this.label(entry.kind === 'internal' ? 'internal_record' : entry.kind);
    const status = ['running','success','failed','error'].includes(entry.status) ? this.label(entry.status === 'error' ? 'error_status' : entry.status) : entry.status;
    const header = [kindLabel, entry.system ? this.label('system') : null, entry.name || entry.tool, entry.channel, entry.sender || entry.target, status, entry.ts].filter(Boolean).join(' · ');
    node.innerHTML = details ? `<details ${oldNode?.querySelector('details')?.open ? 'open' : ''}><summary>${escapeHistory(header)} ${escapeHistory(entry.summary || '')}</summary><div class="history-fields"></div></details>` : `<header>${escapeHistory(header)}</header><div class="history-fields"></div>`;
    const container = node.querySelector('.history-fields');
    if (details) node.querySelector('details').ontoggle = () => this.refreshOverflow();
    if (entry.redaction?.count) {
      const badge = this.doc.createElement('div'); badge.className = 'history-redaction';
      badge.textContent = this.label('redacted', { count: entry.redaction.count }) + ' · ' + (entry.redaction.kinds || []).join(', '); container.append(badge);
    }
    for (const [name, field] of Object.entries(entry.fields || {})) {
      const wrapper = this.doc.createElement('section'); wrapper.className = 'history-field';
      const heading = this.doc.createElement('strong'); heading.textContent = ['body','input','output','raw'].includes(name) ? this.label('field_' + name) : name; wrapper.append(heading);
      if (field.type === 'binary') {
        const link = this.doc.createElement('a');
        link.href = this.endpoint('/api/observer/history/content') + '?' + new URLSearchParams({ session: this.session, entry: entry.id, field: name });
        link.textContent = `${this.label('attachment')} · ${field.mimeType || ''} · ${field.bytes ?? field.total} B`;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; wrapper.append(link);
      } else {
        const key = entry.id + '\0' + name;
        const cached = this.fields.get(key);
        // Keep expanded content when a pending tool receives an output update.
        if (cached && JSON.stringify(cached.descriptor) === JSON.stringify(field)) wrapper.append(cached.content, cached.expand, cached.more, cached.all);
        else {
          const content = this.doc.createElement('div'); content.className = 'history-content history-collapsed';
          const markdown = entry.kind === 'text' && name === 'body';
          const render = text => { content.innerHTML = markdown ? this.markdown(text) : `<pre>${escapeHistory(text)}</pre>`; };
          render(field.preview || '');
          const expand = this.doc.createElement('button'); expand.className = 'action-btn'; expand.textContent = this.label('expand');
          const more = this.doc.createElement('button'); more.className = 'action-btn'; more.textContent = this.label('more'); more.hidden = true;
          const all = this.doc.createElement('button'); all.className = 'action-btn'; all.textContent = this.label('all'); all.hidden = true;
          const state = { descriptor: field, content, expand, more, all, next: 0, text: '', loading: false };
          this.fields.set(key, state);
          const load = async everything => {
            if (state.loading) return;
            state.loading = true; more.disabled = all.disabled = true;
            const generation = this.generation;
            try {
              do {
                const chunk = await this.json('content', { session: this.session, entry: entry.id, field: name, offset: state.next });
                state.text += chunk.text; state.next = chunk.next;
                if (chunk.expandedEntry) {
                  const old = this.entries.get(entry.id);
                  if (old) {
                    const expanded = chunk.expandedEntry;
                    // Keep the loaded body controls while exposing decoded attachments.
                    expanded.fields = { ...expanded.fields, [name]: field };
                    const node = this.renderEntry(expanded, old.node);
                    old.node.replaceWith(node);
                    this.entries.set(entry.id, { entry: expanded, node });
                  }
                }
                render(state.text); state.expanded = true; content.classList.remove('history-collapsed'); expand.hidden = true;
                more.hidden = all.hidden = chunk.next == null;
              } while (everything && state.next != null && generation === this.generation);
            } catch (error) { this.error(error); }
            finally { state.loading = false; more.disabled = all.disabled = false; }
          };
          expand.onclick = () => {
            state.expanded = true;
            content.classList.remove('history-collapsed');
            if (field.truncated) load(false); else expand.hidden = true;
          };
          more.onclick = () => load(false); all.onclick = () => load(true);
          wrapper.append(content, expand, more, all);
        }
      }
      container.append(wrapper);
    }
    return node;
  }
  async search(before) {
    const query = this.el('query').value.trim();
    if (query.length < 2 || query.length > 200 || !this.session) return;
    const searchVersion = this.searchVersion = (this.searchVersion || 0) + 1;
    try {
      const data = await this.json('search', { session: this.session, q: query, internal: this.el('internal').checked ? 1 : 0, ...(before ? { before } : {}) });
      if (searchVersion !== this.searchVersion || query !== this.el('query').value.trim()) return;
      const results = this.el('results'); results.hidden = false;
      if (!before) results.replaceChildren();
      results.querySelector('[data-continue]')?.remove();
      for (const match of data.matches) {
        const button = this.doc.createElement('button'); button.className = 'history-search-match'; button.textContent = match.snippet;
        button.onclick = () => this.select(this.session, match.entry); results.append(button);
      }
      if (!results.childNodes.length) results.textContent = this.label('no_results');
      if (data.hasMore && data.before) {
        const button = this.doc.createElement('button'); button.dataset.continue = 'true'; button.className = 'action-btn'; button.textContent = this.label('continue_search');
        button.onclick = () => this.search(data.before); results.append(button);
      }
    } catch (error) { this.error(error); }
  }
}
