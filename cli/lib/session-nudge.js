import { setTimeout as timerDelay } from 'node:timers/promises';

/** Queue Escape with optional continue; admission belongs to enqueue. */
export async function nudgeSession({ enqueue, delay = timerDelay, continueAfterEscape = true }) {
  const first = { ...await enqueue('[KEYSTROKE]Escape'), control: 'escape' };
  if (!first.ok || !continueAfterEscape) return { ...first, steps: [first] };
  await delay(500);
  const second = { ...await enqueue('continue'), control: 'continue' };
  return { ...second, steps: [first, second] };
}
