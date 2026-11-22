import path from 'node:path';
import { UNSUPPORTED } from '../contract.js';
import { readCodexSampleForIdentity, readRecordedCodexSample } from './rollout.js';

export const usage = Object.freeze({
  transcript: Object.freeze({
    root({ home }) { return path.join(home, '.codex', 'sessions'); },
    projectDir: UNSUPPORTED,
    isTranscriptFile(file) { return /^rollout-[^/]+\.jsonl$/.test(path.basename(file)); },
    pathMarker: '/.codex/',
  }),
  accountQuota: Object.freeze({
    readLiveSample({ sessionGroup, identity, env }) {
      const found = readCodexSampleForIdentity({ sessionGroup, identity, env, account: true });
      if (!found?.sample.rateLimits) return null;
      return { value: found.sample.rateLimits, mtime: found.mtime, recordedAt: found.sample.capturedAt };
    },
    readRecordedSample({ sessionGroup, env, now }) {
      const found = readRecordedCodexSample({ sessionGroup, env, now, includeWithoutQuota: true });
      if (!found) return null;
      return { value: found.sample.rateLimits, recordedAt: found.sample.capturedAt };
    },
    stateFile: 'usage-codex.json',
    alertStateFile: 'usage-codex-alert-state.json',
    sampleOnStart: true,
  }),
  legacyAccountRecord: UNSUPPORTED,
  healthQuota: UNSUPPORTED,
});
