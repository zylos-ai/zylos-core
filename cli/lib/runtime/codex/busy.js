import { UNSUPPORTED } from '../contract.js';

function createParser({ sessionId, startedAt }) {
  let matches = false;
  return value => {
    const ts = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
    const payload = value.payload;
    if (value.type === 'session_meta') matches = payload?.id === sessionId;
    if (!matches || !Number.isFinite(ts) || ts < startedAt || value.isMeta || payload?.isMeta) return {};
    const output = value.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant' &&
      Array.isArray(payload.content) && payload.content.some(block => block.type === 'output_text' && typeof block.text === 'string' && block.text.length > 0);
    const call = value.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload?.type) && typeof payload.name === 'string';
    return output || call ? { responseAt: ts } : {};
  };
}

export const busy = Object.freeze({
  source: 'hooks',
  queuedPromptsInTurn: false,
  transcript: Object.freeze({ createParser, readFailure: 'throw' }),
  statuslineActivity: UNSUPPORTED,
});
