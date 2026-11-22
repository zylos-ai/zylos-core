// Codex records no success flag on a tool result; a non-zero exit code or an explicit error marker in the
// output is the only sign that the call failed. Live collection and history parsing share this reading.
// Outputs come as a string, or as a content array (`[{ type: 'input_text', text }]`, the shape `exec` writes);
// only the text parts are read, and only the verdict is kept by callers.
// The exit line is read only in the result header (before `Output:`), so a command's own output cannot fake it.
// A code-mode script reports its own end in that header: `Script completed`, `Script failed` or `Script terminated`.
const FAILED_HEADER = /(?:Process exited with code [1-9]|^Exit code: [1-9]|^Script (?:failed|terminated)$)/m;
const FAILED_MARKER = /(?:"exit_code"\s*:\s*[1-9]|"isError"\s*:\s*true)/;

/** The text parts of a Codex tool output (a string, a content array or an object carrying them). */
export function codexToolOutputText(output, depth = 0) {
  if (typeof output === 'string') return output;
  if (depth > 3 || output === null || typeof output !== 'object') return '';
  if (Array.isArray(output)) return output.map(part => codexToolOutputText(part, depth + 1)).filter(Boolean).join('\n');
  if (typeof output.text === 'string') return output.text;
  if (output.content !== undefined) return codexToolOutputText(output.content, depth + 1);
  if (typeof output.output === 'string' || Array.isArray(output.output)) return codexToolOutputText(output.output, depth + 1);
  return '';
}

function failedObject(output) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return false;
  if (output.isError === true || output.is_error === true) return true;
  const code = output.exit_code ?? output.exitCode;
  return Number.isInteger(code) && code !== 0;
}

/** Whether a Codex tool output reports a failed call. */
export function codexToolOutputFailed(output) {
  if (failedObject(output)) return true;
  const text = codexToolOutputText(output);
  const body = text.search(/^Output:$/m);
  return FAILED_HEADER.test(body < 0 ? text : text.slice(0, body)) || FAILED_MARKER.test(text);
}
