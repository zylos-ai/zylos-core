import assert from 'node:assert/strict';
import test from 'node:test';
import { createActionFeedback } from '../public/js/action-result.js';

function control() {
  const attributes = new Map();
  return {
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
  };
}

function notice() {
  const classes = new Set();
  return {
    textContent: '',
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
}

test('a confirmed action stays busy until its result and clears success after five seconds', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const status = notice(), button = control(), other = control();
  const sync = () => { button.disabled = other.disabled = button.hasAttribute('aria-busy'); };
  const actions = createActionFeedback(status, sync);

  const operation = actions.start(button);
  assert.equal(button.disabled, true);
  assert.equal(other.disabled, true);
  assert.equal(other.hasAttribute('aria-busy'), false);
  assert.equal(actions.start(other), null);

  operation.show('Saved', true);
  assert.equal(button.disabled, false);
  assert.equal(other.disabled, false);
  assert.equal(status.classList.contains('wb-status-success'), true);
  t.mock.timers.tick(4999);
  assert.equal(status.textContent, 'Saved');
  t.mock.timers.tick(1);
  assert.equal(status.textContent, '');
});

test('a retry cancels the earlier success timeout and keeps its failure until the next attempt', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const status = notice(), button = control();
  const actions = createActionFeedback(status, () => {});
  const first = actions.start(button);
  first.show('Saved', true);

  const retry = actions.start(button);
  assert.equal(status.textContent, '');
  first.show('Old follow-up', true);
  assert.equal(status.textContent, '');
  retry.show('Partly saved: permission denied', false);
  t.mock.timers.tick(10_000);
  assert.equal(status.textContent, 'Partly saved: permission denied');
  assert.equal(status.classList.contains('wb-status-error'), true);

  const next = actions.start(button);
  actions.reset();
  next.show('Response from the previous view', true);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(status.textContent, '');
});
