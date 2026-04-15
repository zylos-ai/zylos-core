import { execFileSync } from 'node:child_process';

const CURSOR_EMPTY_THRESHOLD = 2;
const IN_PROGRESS_CAPTURE_PATTERNS = [
  /\bFetching(?:\.\.\.|…)\s*$/i,
  /\bProofing(?:\.\.\.|…)\s*$/i,
  /\bThinking(?:\.\.\.|…)\s*$/i,
  /\bSearching(?:\.\.\.|…)\s*$/i,
  /\bRunning(?:\.\.\.|…)\s*$/i,
  /\bExecuting(?:\.\.\.|…)\s*$/i,
  /\bAnaly(?:zing|sing)(?:\.\.\.|…)\s*$/i,
  /\bReading(?:\.\.\.|…)\s*$/i,
  /\bSketching(?:\.\.\.|…)\s*$/i,
  /\bCascading(?:\.\.\.|…)\s*$/i,
  /\bPlanning(?:\.\.\.|…)\s*$/i,
  /\bDrafting(?:\.\.\.|…)\s*$/i,
  /\bComposing(?:\.\.\.|…)\s*$/i,
  /\bReflecting(?:\.\.\.|…)\s*$/i,
  /\bRetrying(?:\.\.\.|…)\s*$/i,
];

export function findPromptY(capture) {
  const lines = String(capture || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[›❯]/.test(lines[i])) {
      return i;
    }
  }
  return -1;
}

export function isUsageOverlayCapture(capture) {
  if (!capture) return false;
  const hasUsageHeader = /Settings:\s+Status\s+Config\s+Usage/i.test(capture);
  const hasEscHint = /Esc to cancel/i.test(capture);
  return hasUsageHeader && hasEscHint;
}

export function hasInProgressCapture(capture) {
  if (!capture) return false;
  const recentLines = String(capture)
    .split('\n')
    .slice(-12)
    .map((line) => line.trim())
    .filter(Boolean);
  return recentLines.some((line) => IN_PROGRESS_CAPTURE_PATTERNS.some((pattern) => pattern.test(line)));
}

function readCursorCoord(sessionName, format, execFileSyncImpl) {
  try {
    const out = execFileSyncImpl('tmux', ['display-message', '-p', '-t', sessionName, format], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    return Number.parseInt(String(out).trim(), 10);
  } catch {
    return -1;
  }
}

function readPaneCapture(sessionName, execFileSyncImpl) {
  try {
    return execFileSyncImpl('tmux', ['capture-pane', '-p', '-t', sessionName], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
  } catch {
    return null;
  }
}

export function readTmuxInputState({
  sessionName,
  execFileSyncImpl = execFileSync
} = {}) {
  if (!sessionName) {
    return {
      promptVisible: false,
      inputState: 'indeterminate',
      usageOverlay: false,
      captureOk: false,
      cursorX: -1,
      cursorY: -1,
      capture: null
    };
  }

  const cursorX = readCursorCoord(sessionName, '#{cursor_x}', execFileSyncImpl);
  const cursorY = readCursorCoord(sessionName, '#{cursor_y}', execFileSyncImpl);
  const capture = readPaneCapture(sessionName, execFileSyncImpl);
  const captureOk = typeof capture === 'string';
  const usageOverlay = isUsageOverlayCapture(capture);
  const inProgressCapture = captureOk ? hasInProgressCapture(capture) : false;
  const promptY = captureOk ? findPromptY(capture) : -1;
  const promptVisible = promptY >= 0;

  let inputState = 'indeterminate';
  if (cursorX >= 0 && cursorY >= 0 && promptVisible) {
    if (cursorX > CURSOR_EMPTY_THRESHOLD) {
      inputState = 'has_content';
    } else {
      inputState = cursorY === promptY ? 'empty' : 'has_content';
    }
  }

  return {
    promptVisible,
    inputState,
    usageOverlay,
    inProgressCapture,
    captureOk,
    cursorX,
    cursorY,
    capture,
  };
}
