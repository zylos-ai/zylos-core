/**
 * Zylos Web Console - Frontend Application
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
    this.pollInterval = null;
    this.statusInterval = null;

    // Detect base path for API calls (handles /console/ proxy)
    this.apiBase = this.detectApiBase();

    this.init();
  }

  detectApiBase() {
    // If served from /console/, use relative paths
    const path = window.location.pathname;
    if (path.startsWith('/console')) {
      return '/console';
    }
    return '';
  }

  init() {
    // Event listeners
    this.messageForm.addEventListener('submit', (e) => this.handleSubmit(e));
    this.messageInput.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.messageInput.addEventListener('input', () => this.autoResize());

    // Load initial data
    this.loadConversations();
    this.updateStatus();

    // Start polling
    this.pollInterval = setInterval(() => this.pollMessages(), 2000);
    this.statusInterval = setInterval(() => this.updateStatus(), 5000);
  }

  async loadConversations() {
    try {
      const response = await fetch(`${this.apiBase}/api/conversations/recent?limit=100`);
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

  async pollMessages() {
    try {
      const response = await fetch(`${this.apiBase}/api/poll?since_id=${this.lastMessageId}`);
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

  async updateStatus() {
    try {
      const response = await fetch(`${this.apiBase}/api/status`);
      const status = await response.json();

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

    try {
      const response = await fetch(`${this.apiBase}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });

      const result = await response.json();

      if (!result.success) {
        console.error('Failed to send:', result.error);
        this.markMessageError(tempId);
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
