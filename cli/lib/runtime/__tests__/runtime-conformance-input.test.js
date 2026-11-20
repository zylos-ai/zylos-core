import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getRuntime, SUPPORTED_RUNTIMES } from '../index.js';

for (const id of SUPPORTED_RUNTIMES) {
  test(`${id} recognizes recorded tmux input states`, async t => {
    const samples = new URL(`./samples/${id}/input/`, import.meta.url);
    const manifest = JSON.parse(await fs.readFile(new URL('manifest.json', samples), 'utf8'));
    const { input } = await getRuntime(id);
    const expected = {
      'empty.txt': 'empty',
      'draft.txt': 'has_content',
      'slash-menu.txt': null,
    };
    if (id === 'agy') {
      expected['panel-empty.txt'] = 'empty';
      expected['panel-draft.txt'] = 'has_content';
    }
    for (const [file, verdict] of Object.entries(expected)) {
      await t.test(file, async () => {
        const { cursorX, cursorY } = manifest.files[file];
        assert.ok(Number.isInteger(cursorX) && cursorX >= 0);
        assert.ok(Number.isInteger(cursorY) && cursorY >= 0);
        const screen = await fs.readFile(new URL(file, samples), 'utf8');
        const result = await input.inputState({
          cursorX,
          readCursorY: async () => cursorY,
          capture: async () => screen,
        });
        if (verdict === null) assert.notEqual(result, 'empty');
        else assert.equal(result, verdict);
      });
    }
  });
}
