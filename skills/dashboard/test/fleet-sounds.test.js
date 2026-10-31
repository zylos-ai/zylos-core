import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFleetTransitions, isWorkingMood } from '../public/js/fleet-sounds.js';

const agent = (name, state, extra = {}) => ({ name, state, ...extra });

test('working moods are busy and thinking only', () => {
  assert.equal(isWorkingMood('busy'), true);
  assert.equal(isWorkingMood('thinking'), true);
  assert.equal(isWorkingMood('idle'), false);
  assert.equal(isWorkingMood('stuck'), false);
  assert.equal(isWorkingMood('offline'), false);
});

test('first payload seeds silently', () => {
  const { moods, started, finished } = computeFleetTransitions(new Map(), [
    agent('a', 'BUSY'),
    agent('b', 'IDLE')
  ]);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
  assert.equal(moods.get('a'), 'busy');
  assert.equal(moods.get('b'), 'idle');
});

test('idle -> busy fires start', () => {
  const prev = new Map([['a', 'idle']]);
  const { started, finished } = computeFleetTransitions(prev, [agent('a', 'BUSY')]);
  assert.deepEqual(started, ['a']);
  assert.deepEqual(finished, []);
});

test('busy -> idle fires finish', () => {
  const prev = new Map([['a', 'busy']]);
  const { started, finished } = computeFleetTransitions(prev, [agent('a', 'IDLE')]);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, ['a']);
});

test('busy <-> thinking is not a transition', () => {
  const prev = new Map([['a', 'busy']]);
  const { started, finished } = computeFleetTransitions(prev, [agent('a', 'THINKING')]);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
});

test('working -> stuck/offline does not fire finish', () => {
  const prev = new Map([['a', 'busy'], ['b', 'thinking']]);
  const { started, finished } = computeFleetTransitions(prev, [
    agent('a', 'STUCK'),
    agent('b', 'OFFLINE')
  ]);
  assert.deepEqual(started, []);
  assert.deepEqual(finished, []);
});

test('offline -> busy fires start (recovered agent picks up work)', () => {
  const prev = new Map([['a', 'offline']]);
  const { started } = computeFleetTransitions(prev, [agent('a', 'BUSY')]);
  assert.deepEqual(started, ['a']);
});

test('new agent mid-session seeds silently even when busy', () => {
  const prev = new Map([['a', 'idle']]);
  const { started, moods } = computeFleetTransitions(prev, [
    agent('a', 'IDLE'),
    agent('new', 'BUSY')
  ]);
  assert.deepEqual(started, []);
  assert.equal(moods.get('new'), 'busy');
});

test('removed agent drops out of the mood map', () => {
  const prev = new Map([['a', 'busy'], ['gone', 'busy']]);
  const { moods, finished } = computeFleetTransitions(prev, [agent('a', 'BUSY')]);
  assert.equal(moods.has('gone'), false);
  assert.deepEqual(finished, []);
});

test('same payload reprocessed is a no-op (hover-pause replay)', () => {
  const payload = [agent('a', 'BUSY'), agent('b', 'IDLE')];
  const first = computeFleetTransitions(new Map([['a', 'idle'], ['b', 'idle']]), payload);
  assert.deepEqual(first.started, ['a']);
  const second = computeFleetTransitions(first.moods, payload);
  assert.deepEqual(second.started, []);
  assert.deepEqual(second.finished, []);
});

test('multiple simultaneous transitions are all reported', () => {
  const prev = new Map([['a', 'idle'], ['b', 'busy'], ['c', 'thinking']]);
  const { started, finished } = computeFleetTransitions(prev, [
    agent('a', 'BUSY'),
    agent('b', 'IDLE'),
    agent('c', 'IDLE')
  ]);
  assert.deepEqual(started, ['a']);
  assert.deepEqual(finished, ['b', 'c']);
});

test('handles missing or malformed agent lists', () => {
  assert.deepEqual(computeFleetTransitions(new Map(), null).started, []);
  assert.deepEqual(computeFleetTransitions(new Map(), undefined).finished, []);
  const { moods } = computeFleetTransitions(new Map(), [{ state: 'BUSY' }]);
  assert.equal(moods.size, 0);
});

// ─── Suspended AudioContext: unmute confirmation must survive resume() ───
// Reproduces the review finding on #194: resume() is async, so a synchronous
// state check after unmute dropped the confirmation blip.

class FakeAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
    this.resumeCalls = 0;
    this.oscillatorStarts = 0;
    this.closed = false;
    this.sinkIds = [];
  }
  resume() {
    this.resumeCalls += 1;
    // Flip state in a microtask, like a real browser: a synchronous state
    // check right after resume() must still see 'suspended', which is
    // exactly what the original bug relied on. A closed context stays
    // closed — resume() never revives it.
    return Promise.resolve().then(() => {
      if (this.state !== 'closed') this.state = 'running';
    });
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
  setSinkId(id) {
    this.sinkIds.push(id);
    return Promise.resolve();
  }
  createOscillator() {
    const ctx = this;
    return {
      type: '',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(node) { return node; },
      start() { ctx.oscillatorStarts += 1; },
      stop() {}
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(node) { return node; }
    };
  }
}

function fakeButton() {
  const handlers = {};
  return {
    textContent: '',
    title: '',
    attrs: {},
    addEventListener(name, fn) { handlers[name] = fn; },
    setAttribute(name, value) { this.attrs[name] = value; },
    click() { handlers.click?.(); }
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('unmute confirmation plays after a suspended context resumes', async (t) => {
  const ctx = new FakeAudioContext();
  globalThis.window = { AudioContext: function () { return ctx; } };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  t.after(() => { delete globalThis.window; delete globalThis.localStorage; });

  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const button = fakeButton();
  const sounds = createFleetSounds({ button });
  assert.equal(sounds.isMuted(), true);

  button.click(); // unmute — the context is still suspended at this point
  assert.equal(sounds.isMuted(), false);
  assert.ok(ctx.resumeCalls >= 1);

  await flushMicrotasks();
  assert.equal(ctx.oscillatorStarts, 4, 'confirmation cue plays two rising strikes (2 oscillators each: fundamental + partial) once resume() settles');
});

test('first cue after unmute is not dropped by a suspended context', async (t) => {
  const ctx = new FakeAudioContext();
  globalThis.window = { AudioContext: function () { return ctx; } };
  globalThis.localStorage = { getItem: () => 'false', setItem: () => {} }; // stored unmuted
  t.after(() => { delete globalThis.window; delete globalThis.localStorage; });

  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const sounds = createFleetSounds({});
  assert.equal(sounds.isMuted(), false);

  sounds.handleFleet({ agents: [{ name: 'a', state: 'IDLE' }] }); // seed
  sounds.handleFleet({ agents: [{ name: 'a', state: 'BUSY' }] }); // start cue, ctx suspended
  await flushMicrotasks();
  assert.equal(ctx.oscillatorStarts, 4, 'start cue plays two strikes (2 oscillators each) after resume() settles');
});

test('start cue has two notes and finish cue has three notes', async (t) => {
  const contexts = withAudioFactory(t);
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const sounds = createFleetSounds({ mediaDevices: null, doc: null });

  sounds.handleFleet({ agents: [{ name: 'a', state: 'IDLE' }] });
  sounds.handleFleet({ agents: [{ name: 'a', state: 'BUSY' }] });
  await flushMicrotasks();
  assert.equal(contexts[0].oscillatorStarts, 4, 'start cue is two strikes (2 oscillators each)');

  sounds.handleFleet({ agents: [{ name: 'a', state: 'IDLE' }] });
  await flushMicrotasks();
  assert.equal(contexts[0].oscillatorStarts, 10, 'finish cue adds three strikes (2 oscillators each)');
});

// ─── Output device routing + global unlock (#195) ───

function fakeEventTarget() {
  const handlers = {};
  return {
    handlers,
    addEventListener(name, fn) { handlers[name] = fn; },
    dispatch(name) { handlers[name]?.(); }
  };
}

function withAudioFactory(t, { stored = 'false' } = {}) {
  const contexts = [];
  globalThis.window = {
    AudioContext: function () {
      const ctx = new FakeAudioContext();
      contexts.push(ctx);
      return ctx;
    }
  };
  globalThis.localStorage = { getItem: () => stored, setItem: () => {} };
  t.after(() => { delete globalThis.window; delete globalThis.localStorage; });
  return contexts;
}

test('new contexts are pinned to the default sink when setSinkId exists', async (t) => {
  const contexts = withAudioFactory(t);
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const sounds = createFleetSounds({ mediaDevices: null, doc: null });

  sounds.handleFleet({ agents: [{ name: 'a', state: 'IDLE' }] });
  sounds.handleFleet({ agents: [{ name: 'a', state: 'BUSY' }] });
  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0].sinkIds, ['']);
});

test('devicechange closes the context and rebinds to the new default', async (t) => {
  const contexts = withAudioFactory(t);
  const devices = fakeEventTarget();
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const sounds = createFleetSounds({ mediaDevices: devices, doc: null });

  sounds.handleFleet({ agents: [{ name: 'a', state: 'IDLE' }] });
  sounds.handleFleet({ agents: [{ name: 'a', state: 'BUSY' }] }); // creates ctx 1
  assert.equal(contexts.length, 1);

  devices.dispatch('devicechange');
  assert.equal(contexts[0].closed, true, 'stale context is closed');
  assert.equal(contexts.length, 2, 'unmuted page rebinds eagerly');

  sounds.handleFleet({ agents: [{ name: 'a', state: 'IDLE' }] }); // finish cue
  await flushMicrotasks();
  assert.equal(contexts[1].oscillatorStarts > 0, true, 'cue plays on the fresh context');
  assert.equal(contexts[0].oscillatorStarts, 0, 'nothing plays on the closed context');
});

test('devicechange with no context yet is a no-op', async (t) => {
  const contexts = withAudioFactory(t);
  const devices = fakeEventTarget();
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  createFleetSounds({ mediaDevices: devices, doc: null });

  devices.dispatch('devicechange');
  assert.equal(contexts.length, 0);
});

test('any pointerdown resumes a suspended context when unmuted', async (t) => {
  const contexts = withAudioFactory(t);
  const doc = fakeEventTarget();
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  createFleetSounds({ mediaDevices: null, doc });

  doc.dispatch('pointerdown');
  assert.equal(contexts.length, 1, 'click creates the context');
  assert.ok(contexts[0].resumeCalls >= 1, 'click resumes the suspended context');
});

test('fast unmute -> mute cancels the scheduled confirmation cue', async (t) => {
  const contexts = withAudioFactory(t, { stored: null }); // start muted
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const button = fakeButton();
  const sounds = createFleetSounds({ button, mediaDevices: null, doc: null });

  button.click(); // unmute — confirmation blip parked behind resume()
  button.click(); // mute again before the cue ever sounds
  assert.equal(sounds.isMuted(), true);
  assert.equal(contexts[0].closed, true, 'mute drops the context immediately');

  await flushMicrotasks();
  assert.equal(contexts[0].oscillatorStarts, 0, 'no cue plays after mute');
});

test('mute cancels fleet cues parked behind a pending resume()', async (t) => {
  const contexts = withAudioFactory(t); // stored unmuted
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const button = fakeButton();
  const sounds = createFleetSounds({ button, mediaDevices: null, doc: null });

  sounds.handleFleet({ agents: [{ name: 'a', state: 'IDLE' }] }); // seed
  sounds.handleFleet({ agents: [{ name: 'a', state: 'BUSY' }] }); // cue queued, ctx suspended
  button.click(); // mute before resume() settles
  assert.equal(sounds.isMuted(), true);

  await flushMicrotasks();
  assert.equal(contexts[0].oscillatorStarts, 0, 'queued cue dies with the dropped context');
});

test('unmute after a cancelled cue still plays its confirmation', async (t) => {
  const contexts = withAudioFactory(t, { stored: null });
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const button = fakeButton();
  createFleetSounds({ button, mediaDevices: null, doc: null });

  button.click(); // unmute
  button.click(); // mute — drops ctx 1
  button.click(); // unmute again — fresh context, new confirmation
  await flushMicrotasks();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].oscillatorStarts, 0);
  assert.equal(contexts[1].oscillatorStarts, 4, 'confirmation plays on the fresh context (two strikes, 2 oscillators each)');
});

test('pointerdown does not create or resume audio while muted', async (t) => {
  const contexts = withAudioFactory(t, { stored: null });
  const doc = fakeEventTarget();
  const { createFleetSounds } = await import('../public/js/fleet-sounds.js');
  const sounds = createFleetSounds({ mediaDevices: null, doc });
  assert.equal(sounds.isMuted(), true);

  doc.dispatch('pointerdown');
  assert.equal(contexts.length, 0);
});
