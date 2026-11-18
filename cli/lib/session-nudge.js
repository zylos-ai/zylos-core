import { setTimeout as timerDelay } from 'node:timers/promises';

/** Queue the same Escape/continue nudge for every caller; admission belongs to enqueue. */
export async function nudgeSession({ enqueue, delay = timerDelay }) {
  const first = { ...await enqueue('[KEYSTROKE]Escape'), control: 'escape' };
  if (!first.ok) return { ...first, steps: [first] };
  await delay(500);
  const second = { ...await enqueue('continue'), control: 'continue' };
  return { ...second, steps: [first, second] };
}
