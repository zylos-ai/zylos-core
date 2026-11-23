import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getRuntime } from '../index.js';

const text = (id, file) => fs.readFile(new URL(`./samples/${id}/${file}`, import.meta.url), 'utf8');

for (const id of ['claude', 'codex']) {
  test(`${id} recorded idle pane contains no health failure`, async () => {
    const { health } = await getRuntime(id);
    const result = health.screen.match(await text(id, 'input/empty.txt'));
    assert.deepEqual(result, {
      rateLimit: { detected: false },
      authFailure: { detected: false },
      apiError: { detected: false },
    });
  });
}
