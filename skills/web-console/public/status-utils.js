(function (root) {
  function getStatusDisplay(status) {
    const health = status && status.health;
    if (health && health !== 'ok') {
      if (health === 'rate_limited') {
        return { className: 'busy', text: 'Runtime is rate limited' };
      }
      if (health === 'auth_failed') {
        return { className: 'offline', text: 'Runtime auth failed' };
      }
      return { className: 'offline', text: 'Runtime unavailable' };
    }

    switch (status && status.state) {
      case 'busy':
        return { className: 'busy', text: 'Runtime is busy' };
      case 'idle':
        return { className: 'online', text: 'Runtime is ready' };
      case 'offline':
      case 'stopped':
        return { className: 'offline', text: 'Runtime is offline' };
      default:
        return { className: '', text: 'Unknown status' };
    }
  }

  root.ZylosStatusUtils = { getStatusDisplay };
})(typeof window !== 'undefined' ? window : globalThis);
