/**
 * Zylos Web Console - Frontend Application with WebSocket
 */

class ZylosConsole {
  constructor() {
    this.messagesContainer = document.getElementById('messages');
    this.messageForm = document.getElementById('message-form');
    this.messageInput = document.getElementById('message-input');
    this.sendButton = document.getElementById('send-button');
    this.statusDot = document.querySelector('.status-dot');
    this.statusText = document.querySelector('.status-text');

    this.lastMessageId = 0;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.pendingMessages = new Map(); // Track messages being sent

    // Detect base path for API/WS calls (handles /console/ proxy)
    this.basePath = this.detectBasePath();

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
    // WebSocket connects to the same path
    return `${protocol}//${host}${this.basePath}`;
  }

  init() {
    // Event listeners
    this.messageForm.addEventListener('submit', (e) => this.handleSubmit(e));
    this.messageInput.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.messageInput.addEventListener('input', () => this.autoResize());

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
    if (!message) return;

    // Disable input while sending
    this.sendButton.disabled = true;
    this.messageInput.value = '';
    this.autoResize();

    // Add temporary message
    const tempId = `temp-${Date.now()}`;
    this.addTempMessage(message, tempId);
    this.pendingMessages.set(tempId, message);

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Send via WebSocket
        this.ws.send(JSON.stringify({ type: 'send', content: message }));
        this.markMessageSent(tempId);
      } else {
        // Fallback to HTTP
        const response = await fetch(`${this.basePath}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
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
      this.messageInput.focus();
    }
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
    }

    const div = document.createElement('div');
    div.className = `message ${msg.direction === 'in' ? 'user' : 'claude'}`;
    div.dataset.id = msg.id;

    const content = document.createElement('div');
    content.className = 'content';
    content.textContent = msg.content;

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

  addTempMessage(content, tempId) {
    this.clearEmptyState();

    const div = document.createElement('div');
    div.className = 'message user sending';
    div.dataset.tempId = tempId;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';
    contentDiv.textContent = content;

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
      <h2>Welcome to Zylos Console</h2>
      <p>Start a conversation with Claude</p>
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
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new ZylosConsole();
});
