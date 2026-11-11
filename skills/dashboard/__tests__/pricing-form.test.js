import assert from 'node:assert/strict';
import test from 'node:test';
import { priceWithEditedBaseRates } from '../public/js/pricing-form.js';

test('editing base prices preserves long-context and model Fast tariffs', () => {
  const original = {
    input: 10, output: 50, cacheRead: 1, cacheCreation: 12.5,
    longContext: { inputTokenThreshold: 272000, input: 20, output: 75, cacheRead: 2, cacheCreation: 25 },
    fastModeMultiplier: 2
  };
  const edited = priceWithEditedBaseRates(original, ['11', '55', '1.1', '13.75']);
  assert.equal(edited.input, 11);
  assert.equal(edited.output, 55);
  assert.equal(edited.cacheRead, 1.1);
  assert.equal(edited.cacheCreation, 13.75);
  assert.deepEqual(edited.longContext, original.longContext);
  assert.equal(edited.fastModeMultiplier, 2);
  assert.equal(original.input, 10);
  assert.deepEqual(priceWithEditedBaseRates(original, ['10', '50', '1', '12.5']), original);
});

test('new custom price rows have no implicit premium tariffs', () => {
  assert.deepEqual(priceWithEditedBaseRates(undefined, ['1', '2', '0.02', '1.25']), {
    input: 1, output: 2, cacheRead: 0.02, cacheCreation: 1.25
  });
});
