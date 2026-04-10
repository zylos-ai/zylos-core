import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readTmuxInputState, isUsageOverlayCapture } from '../../../../cli/lib/tmux-input-state.js';

function createExecStub({ cursorX = '2', cursorY = '5', capture = 'line\n❯ ', failCapture = false } = {}) {
  return (_cmd, args) => {
    const joined = args.join(' ');
    if (joined.includes('#{cursor_x}')) return cursorX;
    if (joined.includes('#{cursor_y}')) return cursorY;
    if (joined.includes('capture-pane')) {
      if (failCapture) {
        throw new Error('capture failed');
      }
      return capture;
    }
    throw new Error(`unexpected call: ${joined}`);
  };
}

describe('tmux-input-state', () => {
  it('detects an empty prompt', () => {
    const state = readTmuxInputState({
      sessionName: 'claude-main',
      execFileSyncImpl: createExecStub({
        cursorX: '2',
        cursorY: '1',
        capture: 'header\n❯ '
      })
    });

    assert.equal(state.promptVisible, true);
    assert.equal(state.inputState, 'empty');
    assert.equal(state.usageOverlay, false);
  });

  it('detects multi-line wrapped input as has_content', () => {
    const state = readTmuxInputState({
      sessionName: 'claude-main',
      execFileSyncImpl: createExecStub({
        cursorX: '1',
        cursorY: '3',
        capture: 'header\n❯ prompt line\nwrapped text'
      })
    });

    assert.equal(state.inputState, 'has_content');
  });

  it('detects usage overlay separately from prompt visibility', () => {
    const capture = 'Settings: Status Config Usage\nEsc to cancel';
    const state = readTmuxInputState({
      sessionName: 'claude-main',
      execFileSyncImpl: createExecStub({
        cursorX: '0',
        cursorY: '0',
        capture
      })
    });

    assert.equal(isUsageOverlayCapture(capture), true);
    assert.equal(state.usageOverlay, true);
    assert.equal(state.promptVisible, false);
    assert.equal(state.inputState, 'indeterminate');
  });

  it('returns indeterminate when capture fails', () => {
    const state = readTmuxInputState({
      sessionName: 'claude-main',
      execFileSyncImpl: createExecStub({ failCapture: true })
    });

    assert.equal(state.captureOk, false);
    assert.equal(state.inputState, 'indeterminate');
  });
});
