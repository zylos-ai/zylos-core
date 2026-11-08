// Codex records no success flag on a tool result; a non-zero exit code or an explicit error marker in the
// output is the only sign that the call failed. Live collection and history parsing share this reading.
const FAILED_OUTPUT = /(?:Process exited with code [1-9]|"exit_code"\s*:\s*[1-9]|"isError"\s*:\s*true)/;

/** Whether a Codex tool output reports a failed call. */
export function codexToolOutputFailed(output) {
  return FAILED_OUTPUT.test(String(output));
}
