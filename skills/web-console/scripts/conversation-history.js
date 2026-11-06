export function createConversationHistoryHandler(db, cleanMessageForDisplay) {
  return (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const channel = req.query.channel || 'web-console';
      // Dashboard history has its own access gate; Web Console never exposes it.
      const stmt = db.prepare(`
        SELECT id, direction, channel, endpoint_id, content, timestamp
        FROM conversations
        WHERE channel = ? AND channel NOT IN ('void', 'dashboard')
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      const conversations = stmt.all(channel, limit).map(cleanMessageForDisplay);
      res.json(conversations.reverse());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}
