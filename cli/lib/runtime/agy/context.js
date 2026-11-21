import path from 'node:path';
import { readJsonSample } from '../../session-usage-reader.js';
import { UNSUPPORTED } from '../contract.js';

const CONTEXT_WINDOW = 1_048_576;

export const context = Object.freeze({
  readUsageSample: ({ dir }) => readJsonSample(path.join(dir, 'statusline.json'), 'usage'),
  usageSampleExpires: false,
  usageFacts: value => ({
    model: value?.model?.id ?? value?.model,
    contextWindow: value?.context_window?.context_window_size ?? CONTEXT_WINDOW,
    usedPercent: value?.context_window?.used_percentage,
    usedTokens: null,
    effort: value?.model?.effort,
    version: value?.version ?? value?.cliVersion,
  }),
  contextWindowFor: () => CONTEXT_WINDOW,
  readModelWindows: UNSUPPORTED,
  thresholdKeys: Object.freeze({
    key: model => model,
    alias: () => null,
    isAlias: () => false,
  }),
  readDefaultModel: UNSUPPORTED,
  statusLine: Object.freeze({
    normalize(sample) {
      // The native transcript path does not identify the transcript owned by the CLI hooks.
      const { transcript_path, ...normalized } = sample;
      return { ...normalized, session_id: sample.conversation_id ?? sample.conversationId ?? sample.session_id };
    },
  }),
});
