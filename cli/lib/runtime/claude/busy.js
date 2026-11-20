import { UNSUPPORTED } from '../contract.js';

function createParser({ sessionId, startedAt }) {
  return value => {
    const ts = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
    const facts = {};
    const mainActivity = !value.isSidechain && !value.agent_id && !value.agentId &&
      Number.isFinite(ts) && ts >= startedAt;
    if (mainActivity && value.type === 'queue-operation' && value.operation === 'dequeue' &&
        (!value.sessionId || value.sessionId === sessionId)) facts.dequeueAt = ts;
    if (mainActivity && value.sessionId === sessionId) {
      const message = value.message;
      const output = value.type === 'assistant' && !value.isMeta && !message?.isMeta && !value.isApiErrorMessage && !value.error &&
        message?.role === 'assistant' && typeof message.model === 'string' && message.model.length > 0 && message.model !== '<synthetic>' &&
        Array.isArray(message.content) && message.content.some(block =>
          (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) ||
          (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) || block.type === 'tool_use');
      if (output) {
        facts.responseAt = ts;
        facts.mainActionAt = ts;
      }
    }
    const content = value.message?.content ?? value.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          (facts.toolResultIds ??= []).push(block.tool_use_id);
        }
      }
    }
    return facts;
  };
}

export const busy = Object.freeze({
  source: 'hooks',
  queuedPromptsInTurn: true,
  transcript: Object.freeze({ createParser, readFailure: 'ignore' }),
  statuslineActivity: UNSUPPORTED,
});
