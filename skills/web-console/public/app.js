/**
 * Zylos Web Console - Frontend Application with WebSocket
 */

class ZylosConsole {
  constructor(timezone) {
    this.messagesContainer = document.getElementById('messages');
    this.messageForm = document.getElementById('message-form');
    this.messageInput = document.getElementById('message-input');
    this.sendButton = document.getElementById('send-button');
    this.attachButton = document.getElementById('attach-button');
    this.fileInput = document.getElementById('file-input');
    this.attachmentTray = document.getElementById('attachment-tray');
    this.statusDot = document.querySelector('.status-dot');
    this.statusText = document.querySelector('.status-text');

    this.lastMessageId = 0;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.pendingMessages = new Map(); // Track messages being sent
    this.pendingAttachments = [];
    this.maxAttachments = 20;
    this.timezone = timezone || null;

    // Detect base path for API/WS calls (handles /console/ proxy)
    this.basePath = this.detectBasePath();

    this.initMarkdown();
    this.init();
  }

  detectBasePath() {
    const path = window.location.pathname;
    if (path.startsWith('/console')) {
      return '/console';
    }
    return '';
  }

  getWebSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    // WebSocket needs trailing slash for proxy path matching
    const wsPath = this.basePath ? `${this.basePath}/` : '/';
    return `${protocol}//${host}${wsPath}`;
  }

  init() {
    // Event listeners
    this.messageForm.addEventListener('submit', (e) => this.handleSubmit(e));
    this.messageInput.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.messageInput.addEventListener('input', () => this.autoResize());
    this.attachButton.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => {
      this.addFiles(Array.from(e.target.files || []));
      this.fileInput.value = '';
    });
    this.messagesContainer.addEventListener('dragover', (e) => this.handleDragOver(e));
    this.messagesContainer.addEventListener('dragleave', () => this.messagesContainer.classList.remove('drag-over'));
    this.messagesContainer.addEventListener('drop', (e) => this.handleDrop(e));
    document.addEventListener('paste', (e) => this.handlePaste(e));

    // Load initial conversations via HTTP (for history)
    this.loadConversations();

    // Connect WebSocket for real-time updates
    this.connectWebSocket();
  }

  connectWebSocket() {
    const wsUrl = this.getWebSocketUrl();
    console.log('Connecting to WebSocket:', wsUrl);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.updateConnectionStatus(true);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleWebSocketMessage(msg);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.updateConnectionStatus(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        this.updateConnectionStatus(false);
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connectWebSocket(), delay);
    } else {
      console.error('Max reconnect attempts reached, falling back to polling');
      this.startPolling();
    }
  }

  startPolling() {
    // Fallback to HTTP polling if WebSocket fails
    this.pollInterval = setInterval(() => this.pollMessages(), 2000);
    this.statusInterval = setInterval(() => this.updateStatusViaHttp(), 5000);
  }

  handleWebSocketMessage(msg) {
    switch (msg.type) {
      case 'status':
        this.updateStatusDisplay(msg.data);
        break;

      case 'messages':
        if (Array.isArray(msg.data)) {
          this.clearEmptyState();
          msg.data.forEach((m) => this.addMessage(m, true));
          if (msg.data.length > 0) {
            this.lastMessageId = Math.max(...msg.data.map((m) => m.id));
          }
        }
        break;

      case 'sent':
        // Message send confirmation
        if (msg.success) {
          // Message was sent successfully, it will appear via 'messages' event
        } else {
          console.error('Failed to send message:', msg.error);
          // Mark the specific message as error if tempId is provided
          if (msg.tempId) {
            this.markMessageError(msg.tempId);
          }
        }
        break;
    }
  }

  updateConnectionStatus(connected) {
    if (!connected) {
      this.statusDot.className = 'status-dot offline';
      this.statusText.textContent = 'Disconnected';
    }
  }

  updateStatusDisplay(status) {
    this.statusDot.className = 'status-dot';

    switch (status.state) {
      case 'busy':
        this.statusDot.classList.add('busy');
        this.statusText.textContent = 'Claude is busy';
        break;
      case 'idle':
        this.statusDot.classList.add('online');
        this.statusText.textContent = 'Claude is ready';
        break;
      case 'offline':
      case 'stopped':
        this.statusDot.classList.add('offline');
        this.statusText.textContent = 'Claude is offline';
        break;
      default:
        this.statusText.textContent = 'Unknown status';
    }
  }

  async loadConversations() {
    try {
      const response = await fetch(`${this.basePath}/api/conversations/recent?limit=100`);
      const conversations = await response.json();

      if (conversations.length === 0) {
        this.showEmptyState();
        return;
      }

      this.clearEmptyState();
      conversations.forEach((msg) => this.addMessage(msg, false));

      if (conversations.length > 0) {
        this.lastMessageId = Math.max(...conversations.map((m) => m.id));
      }

      this.scrollToBottom();
    } catch (err) {
      console.error('Failed to load conversations:', err);
    }
  }

  // HTTP fallback methods
  async pollMessages() {
    try {
      const response = await fetch(`${this.basePath}/api/poll?since_id=${this.lastMessageId}`);
      const messages = await response.json();

      if (messages.length > 0) {
        this.clearEmptyState();
        messages.forEach((msg) => this.addMessage(msg, true));
        this.lastMessageId = Math.max(...messages.map((m) => m.id));
      }
    } catch (err) {
      console.error('Failed to poll messages:', err);
    }
  }

  async updateStatusViaHttp() {
    try {
      const response = await fetch(`${this.basePath}/api/status`);
      const status = await response.json();
      this.updateStatusDisplay(status);
    } catch (err) {
      this.statusDot.className = 'status-dot offline';
      this.statusText.textContent = 'Connection error';
    }
  }

  async handleSubmit(e) {
    e.preventDefault();

    const message = this.messageInput.value.trim();
    const readyAttachments = this.pendingAttachments.filter((item) => item.status === 'ready');
    const uploading = this.pendingAttachments.some((item) => item.status === 'uploading');
    if (!message && readyAttachments.length === 0) return;
    if (uploading) return;

    // Disable input while sending
    this.sendButton.disabled = true;
    this.attachButton.disabled = true;
    this.messageInput.value = '';
    this.autoResize();

    // Add temporary message
    const tempId = `temp-${Date.now()}`;
    const tempAttachments = readyAttachments.map((item) => ({
      kind: item.kind,
      name: item.name,
      size_label: this.formatBytes(item.size),
      url: item.previewUrl || null
    }));
    this.addTempMessage(message, tempId, tempAttachments);
    this.pendingMessages.set(tempId, message);
    this.pendingAttachments = this.pendingAttachments.filter((item) => item.status !== 'ready');
    this.updateAttachmentTray();
    const attachmentIds = readyAttachments.map((item) => item.id);

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Send via WebSocket
        // Note: Don't mark as sent immediately - wait for server confirmation
        // or for message to appear via polling
        const payload = { type: 'send', content: message, tempId };
        if (attachmentIds.length > 0) payload.attachments = attachmentIds;
        this.ws.send(JSON.stringify(payload));
      } else {
        // Fallback to HTTP
        const body = { message };
        if (attachmentIds.length > 0) body.attachments = attachmentIds;
        const response = await fetch(`${this.basePath}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const result = await response.json();

        if (result.success) {
          this.markMessageSent(tempId);
        } else {
          console.error('Failed to send:', result.error);
          this.markMessageError(tempId);
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      this.markMessageError(tempId);
    } finally {
      this.sendButton.disabled = false;
      this.attachButton.disabled = false;
      this.messageInput.focus();
    }
  }

  handleDragOver(e) {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    this.messagesContainer.classList.add('drag-over');
  }

  handleDrop(e) {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    this.messagesContainer.classList.remove('drag-over');
    this.addFiles(Array.from(e.dataTransfer.files));
  }

  handlePaste(e) {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length === 0) return;
    e.preventDefault();
    this.addFiles(files);
  }

  addFiles(files) {
    const slots = this.maxAttachments - this.pendingAttachments.length;
    files.slice(0, Math.max(0, slots)).forEach((file) => this.queueUpload(file));
  }

  queueUpload(file) {
    const localId = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const item = {
      localId,
      file,
      name: file.name || 'attachment',
      size: file.size,
      kind: file.type.startsWith('image/') ? 'image' : 'file',
      status: 'uploading',
      progress: 0,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    };
    this.pendingAttachments.push(item);
    this.updateAttachmentTray();
    this.uploadAttachment(item);
  }

  uploadAttachment(item) {
    const form = new FormData();
    form.append('file', item.file, item.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${this.basePath}/api/upload`);
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.round((event.loaded / event.total) * 100);
      this.updateAttachmentTray();
    });
    xhr.addEventListener('load', () => {
      let result = {};
      try {
        result = JSON.parse(xhr.responseText || '{}');
      } catch {
        // Keep generic error below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && result.id) {
        item.status = 'ready';
        item.progress = 100;
        item.id = result.id;
        item.name = result.name || item.name;
        item.kind = result.kind || item.kind;
        item.size = result.size ?? item.size;
      } else {
        item.status = 'error';
        item.error = result.message || result.error || 'Upload failed';
      }
      this.updateAttachmentTray();
    });
    xhr.addEventListener('error', () => {
      item.status = 'error';
      item.error = 'Upload failed';
      this.updateAttachmentTray();
    });
    xhr.send(form);
  }

  removeAttachment(localId) {
    const item = this.pendingAttachments.find((candidate) => candidate.localId === localId);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    this.pendingAttachments = this.pendingAttachments.filter((candidate) => candidate.localId !== localId);
    this.updateAttachmentTray();
  }

  updateAttachmentTray() {
    this.attachmentTray.textContent = '';
    if (this.pendingAttachments.length === 0) {
      this.attachmentTray.hidden = true;
      return;
    }
    this.attachmentTray.hidden = false;

    this.pendingAttachments.forEach((item) => {
      const chip = document.createElement('div');
      chip.className = `attachment-preview ${item.status}`;
      if (item.previewUrl) {
        const img = document.createElement('img');
        img.src = item.previewUrl;
        img.alt = '';
        chip.appendChild(img);
      }

      const details = document.createElement('div');
      details.className = 'attachment-details';
      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = item.name;
      const status = document.createElement('span');
      status.className = 'attachment-status';
      status.textContent = item.status === 'uploading'
        ? `Uploading ${item.progress}%`
        : item.status === 'error' ? item.error : this.formatBytes(item.size);
      details.appendChild(name);
      details.appendChild(status);
      chip.appendChild(details);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.textContent = 'x';
      remove.setAttribute('aria-label', `Remove ${item.name}`);
      remove.addEventListener('click', () => this.removeAttachment(item.localId));
      chip.appendChild(remove);
      this.attachmentTray.appendChild(chip);
    });
  }

  handleKeydown(e) {
    // Send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.messageForm.dispatchEvent(new Event('submit'));
    }
  }

  autoResize() {
    this.messageInput.style.height = 'auto';
    this.messageInput.style.height =
      Math.min(this.messageInput.scrollHeight, 150) + 'px';
  }

  addMessage(msg, scroll = true) {
    this.clearEmptyState();

    // Check if message already exists (by id)
    if (this.messagesContainer.querySelector(`[data-id="${msg.id}"]`)) {
      return; // Skip duplicate
    }

    // For incoming user messages, remove matching temp message
    if (msg.direction === 'in') {
      const tempMessages = this.messagesContainer.querySelectorAll('[data-temp-id]');
      for (const temp of tempMessages) {
        const tempContent = temp.querySelector('.content');
        if (tempContent && tempContent.textContent === msg.content) {
          temp.remove();
          break;
        }
      }
      if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        const temp = this.messagesContainer.querySelector('.message.user.sending[data-has-attachments="true"]');
        if (temp) temp.remove();
      }
    }

    const div = document.createElement('div');
    div.className = `message ${msg.direction === 'in' ? 'user' : 'claude'}`;
    div.dataset.id = msg.id;

    const content = this.renderMessageContent(msg);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = this.formatTime(msg.timestamp);

    div.appendChild(content);
    div.appendChild(meta);
    this.messagesContainer.appendChild(div);

    if (scroll) {
      this.scrollToBottom();
    }
  }

  addTempMessage(content, tempId, attachments = []) {
    this.clearEmptyState();

    const div = document.createElement('div');
    div.className = 'message user sending';
    div.dataset.tempId = tempId;
    div.dataset.hasAttachments = attachments.length > 0 ? 'true' : 'false';

    const contentDiv = this.renderMessageContent({
      direction: 'in',
      content,
      attachments
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'Sending...';

    div.appendChild(contentDiv);
    div.appendChild(meta);
    this.messagesContainer.appendChild(div);

    this.scrollToBottom();
  }

  markMessageSent(tempId) {
    const msg = this.messagesContainer.querySelector(
      `[data-temp-id="${tempId}"]`
    );
    if (msg) {
      msg.classList.remove('sending');
      const meta = msg.querySelector('.meta');
      if (meta) meta.textContent = this.formatTime(new Date().toISOString());
    }
    this.pendingMessages.delete(tempId);
  }

  markMessageError(tempId) {
    const msg = this.messagesContainer.querySelector(
      `[data-temp-id="${tempId}"]`
    );
    if (msg) {
      msg.classList.remove('sending');
      msg.classList.add('error');
      const meta = msg.querySelector('.meta');
      if (meta) meta.textContent = 'Failed to send';
    }
    this.pendingMessages.delete(tempId);
  }

  showEmptyState() {
    if (this.messagesContainer.querySelector('.empty-state')) return;

    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-avatar"><img src="logo.png" alt="Zylos"></div>
      <h2>Welcome to Zylos</h2>
      <p>Start a conversation</p>
    `;
    this.messagesContainer.appendChild(empty);
  }

  clearEmptyState() {
    const empty = this.messagesContainer.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  formatTime(timestamp) {
    const ts = timestamp.endsWith('Z') ? timestamp : timestamp + 'Z';
    const date = new Date(ts);
    const opts = { hour: '2-digit', minute: '2-digit' };
    if (this.timezone) opts.timeZone = this.timezone;
    return date.toLocaleTimeString([], opts);
  }

  resolveHref(href) {
    if (!href || !href.startsWith('/')) return href;
    return `${this.basePath}${href}`;
  }

  formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '?B';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  initMarkdown() {
    if (typeof window.markdownit === 'function') {
      this.md = window.markdownit({ html: false, linkify: true });
      const defaultRender = this.md.renderer.rules.link_open || function (tokens, idx, options, _env, self) {
        return self.renderToken(tokens, idx, options);
      };
      this.md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
        tokens[idx].attrSet('target', '_blank');
        tokens[idx].attrSet('rel', 'noopener noreferrer');
        return defaultRender(tokens, idx, options, env, self);
      };
    }
  }

  renderMarkdown(container, text) {
    if (this.md) {
      container.innerHTML = this.md.render(text);
      for (const li of container.querySelectorAll('li')) {
        const children = li.children;
        if (children.length === 1 && children[0].tagName === 'P') {
          li.innerHTML = children[0].innerHTML;
        }
      }
    } else {
      container.textContent = text;
    }
  }

  renderMessageContent(msg) {
    const content = document.createElement('div');
    content.className = 'content';

    if (msg.kind === 'media') {
      content.appendChild(this.renderMediaMessage(msg));
      return content;
    }

    if (msg.content) {
      const text = document.createElement('div');
      text.className = 'markdown-body';
      this.renderMarkdown(text, msg.content);
      content.appendChild(text);
    }

    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const list = document.createElement('div');
      list.className = 'message-attachments';
      msg.attachments.forEach((attachment) => {
        const resolved = attachment.href ? { ...attachment, href: this.resolveHref(attachment.href) } : attachment;
        if (resolved.kind === 'image' && resolved.href) {
          const link = document.createElement('a');
          link.href = resolved.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'media-image-link';
          const img = document.createElement('img');
          img.src = resolved.href;
          img.alt = resolved.name || 'Image';
          img.className = 'media-image';
          link.appendChild(img);
          list.appendChild(link);
        } else {
          list.appendChild(this.renderAttachmentChip(resolved));
        }
      });
      content.appendChild(list);
    }

    return content;
  }

  renderMediaMessage(msg) {
    const href = `${this.basePath}/api/media/${msg.message_id}`;
    if (msg.media_type === 'image') {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'media-image-link';
      const img = document.createElement('img');
      img.src = href;
      img.alt = msg.name || 'Image';
      img.className = 'media-image';
      link.appendChild(img);
      return link;
    }
    return this.renderAttachmentChip({
      kind: 'file',
      name: msg.name || 'download',
      size_label: Number.isFinite(msg.size) ? this.formatBytes(msg.size) : '',
      href
    });
  }

  renderAttachmentChip(attachment) {
    const wrapper = attachment.href ? document.createElement('a') : document.createElement('div');
    wrapper.className = `message-attachment ${attachment.kind === 'image' ? 'image' : 'file'}`;
    if (attachment.href) {
      wrapper.href = attachment.href;
      wrapper.target = '_blank';
      wrapper.rel = 'noopener noreferrer';
    }
    const icon = document.createElement('span');
    icon.className = 'attachment-icon';
    icon.textContent = attachment.kind === 'image' ? 'IMG' : 'FILE';
    const label = document.createElement('span');
    label.className = 'attachment-label';
    label.textContent = attachment.name || 'attachment';
    const size = document.createElement('span');
    size.className = 'attachment-size';
    size.textContent = attachment.size_label || '';
    wrapper.appendChild(icon);
    wrapper.appendChild(label);
    if (size.textContent) wrapper.appendChild(size);
    if (attachment.href) {
      const dl = document.createElement('span');
      dl.className = 'attachment-download';
      dl.textContent = '⬇';
      wrapper.appendChild(dl);
    }
    return wrapper;
  }
}

function showLogoutButton(basePath) {
  const btn = document.getElementById('logout-btn');
  if (!btn) return;
  btn.style.display = '';
  btn.addEventListener('click', async () => {
    await fetch(`${basePath}/api/logout`, { method: 'POST' });
    window.location.reload();
  });
}

/**
 * Auth guard - check if login is required before showing chat
 */
async function checkAuth() {
  const loginScreen = document.getElementById('login-screen');
  const chatScreen = document.getElementById('chat-screen');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const basePath = window.location.pathname.startsWith('/console') ? '/console' : '';

  try {
    const res = await fetch(`${basePath}/api/auth`);
    const auth = await res.json();

    if (!auth.required || auth.authenticated) {
      // No password set, or already authenticated
      chatScreen.style.display = '';
      if (auth.required) showLogoutButton(basePath);
      new ZylosConsole(auth.timezone);
      return;
    }

    // Show login screen
    loginScreen.style.display = '';
    chatScreen.style.display = 'none';

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.textContent = '';
      const password = document.getElementById('login-password').value;
      const remember = document.getElementById('login-remember')?.checked ?? true;

      const loginRes = await fetch(`${basePath}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, remember }),
      });
      const result = await loginRes.json();

      if (result.success) {
        loginScreen.style.display = 'none';
        chatScreen.style.display = '';
        showLogoutButton(basePath);
        new ZylosConsole(result.timezone);
      } else {
        loginError.textContent = result.error || 'Login failed';
      }
    });
  } catch (err) {
    // Can't reach server, just show chat (will show connection error)
    chatScreen.style.display = '';
    new ZylosConsole();
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', checkAuth);
