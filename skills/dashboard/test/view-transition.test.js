import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function harness() {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('const VIEW_ANIM_CLASSES');
  const end = app.indexOf('// #222:', start);
  const timers = new Map(), frames = new Map();
  let next = 0;
  const element = (hidden) => {
    const classes = new Set(), listeners = new Set();
    return { hidden, offsetWidth: 100, classes, listeners,
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)) },
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
      end() { for (const fn of [...listeners]) fn({ target: this, propertyName: 'opacity' }); }
    };
  };
  const fleet = element(false), agent = element(true), stack = element(false);
  const context = vm.createContext({
    $: id => ({ '#view-stack': stack, '#fleet-view': fleet, '#agent-detail': agent })[id],
    window: { matchMedia: () => ({ matches: false }) },
    setTimeout: fn => { const id = ++next; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++next; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  vm.runInContext(app.slice(start, end), context);
  const drain = jobs => { for (const [id, fn] of [...jobs]) { jobs.delete(id); fn(); } };
  return { fleet, agent, stack, timers, frames, context, go: context.transitionView,
    flush() { drain(frames); drain(timers); },
    assertTarget(target) {
      assert.equal(fleet.hidden, target !== 'fleet', 'Fleet visibility');
      assert.equal(agent.hidden, target !== 'agent', 'detail visibility');
      for (const el of [fleet, agent, stack]) assert.equal(el.classes.size, 0, 'animation classes cleared');
      assert.equal(fleet.listeners.size + agent.listeners.size, 0, 'transition listeners released');
      assert.equal(timers.size + frames.size, 0, 'pending animation callbacks released');
    }
  };
}

for (const first of ['agent', 'fleet']) {
  for (const completion of ['timeout', 'event']) {
    test(`rapid ${first} reversal settles on latest target via ${completion}`, () => {
      const h = harness();
      if (first === 'fleet') h.go('agent', { animate: false });
      h.go(first);
      const last = first === 'agent' ? 'fleet' : 'agent';
      h.go(last);
      if (completion === 'event') { h.fleet.end(); h.agent.end(); }
      h.flush();
      h.assertTarget(last);
    });
  }
}

test('instant reversal cancels pending animation callbacks', () => {
  const h = harness();
  h.go('agent');
  h.go('fleet', { animate: false });
  h.flush();
  h.assertTarget('fleet');
});

test('repeated alternating transitions release superseded work', () => {
  const h = harness();
  for (let n = 0; n < 12; n++) h.go(n % 2 ? 'fleet' : 'agent');
  h.flush();
  h.assertTarget('fleet');
});

test('uninterrupted transition preserves final target and releases fallback', () => {
  const h = harness();
  h.go('agent');
  h.agent.end();
  h.flush();
  h.assertTarget('agent');
});

for (const instant of [false, true]) {
  test(`captured stale callbacks cannot affect a newer ${instant ? 'reduced-motion' : 'animated'} transition`, () => {
    const h = harness();
    h.go('agent');
    const stale = [...h.frames.values(), ...h.timers.values()];
    const oldEnd = [...h.agent.listeners][0];
    if (instant) h.context.window.matchMedia = () => ({ matches: true });
    h.go('fleet');
    for (const fn of stale) fn();
    oldEnd({ target: h.agent, propertyName: 'opacity' });
    h.flush();
    h.assertTarget('fleet');
  });
}
