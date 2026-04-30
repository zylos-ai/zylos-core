import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { consumeRecentUserMessageSignal } from '../signal-store.js';

function tempSignalFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-signal-store-')), 'user-message-signal.json');
}

describe('signal-store', () => {
  it('returns empty result when the signal file is missing', () => {
    const result = consumeRecentUserMessageSignal({
      signalFile: tempSignalFile(),
      currentTime: 100,
    });

    assert.deepEqual(result, { consumed: false, fresh: false, signal: null });
  });

  it('consumes a fresh user message signal', () => {
    const signalFile = tempSignalFile();
    fs.writeFileSync(signalFile, JSON.stringify({ timestamp: 90, source: 'test' }));

    const result = consumeRecentUserMessageSignal({
      signalFile,
      currentTime: 100,
      ttlSec: 60,
    });

    assert.equal(result.consumed, true);
    assert.equal(result.fresh, true);
    assert.deepEqual(result.signal, { timestamp: 90, source: 'test' });
    assert.equal(fs.existsSync(signalFile), false);
  });

  it('consumes a stale signal without marking it fresh', () => {
    const signalFile = tempSignalFile();
    fs.writeFileSync(signalFile, JSON.stringify({ timestamp: 30 }));

    const result = consumeRecentUserMessageSignal({
      signalFile,
      currentTime: 100,
      ttlSec: 60,
    });

    assert.equal(result.consumed, true);
    assert.equal(result.fresh, false);
    assert.equal(fs.existsSync(signalFile), false);
  });

  it('fails closed on malformed signal content', () => {
    const signalFile = tempSignalFile();
    fs.writeFileSync(signalFile, '{bad json');

    const result = consumeRecentUserMessageSignal({
      signalFile,
      currentTime: 100,
    });

    assert.deepEqual(result, { consumed: false, fresh: false, signal: null });
  });
});
